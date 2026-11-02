'use strict';

// ============================================================
// Envio proativo da Bia.
//
// Existe para responder quem escreveu enquanto a sessao estava morta: o
// WhatsApp nao reenvia mensagem ja entregue, entao a resposta sai daqui, por
// comando, e nao por reacao a um inbound.
//
//   node falar.js 5511900000000 5511900000000
//   node falar.js 5511900000000 --texto interesse
//
// Manda o texto, marca cada pessoa como NEUTRO (o estado "confirmando": se
// ela responder de novo e continuar ambigua, a equipe e avisada para
// conferir). So fala com numero de data/numeros.txt e nunca com a equipe.
//
// Mesma trava do bot/repicar: um socket de cada vez, e a config e auditada
// antes de qualquer envio.
// ============================================================

const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const templates = require('./templates');
const config = require('./config');
const atendimento = require('./atendimento');
const escopo = require('./escopo.guard');
const numeros = require('./numeros');
const estado = require('./estado');
const trava = require('./pid.lock');
const { enviarTexto } = require('./enviar');

const pinoLogger = (() => {
  try {
    return require('pino')({ level: 'silent' });
  } catch {
    // silencio-ok: pino e opcional; sem ele o Baileys usa o proprio logger.
    return undefined;
  }
})();

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const jidNumero = (numero) => `${String(numero).replace(/\D/g, '')}@s.whatsapp.net`;
const soDigitos = (t) => String(t || '').replace(/\D/g, '');

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i !== -1 ? process.argv[i + 1] : null;
}

// Numeros sao os argumentos posicionais. `--texto <x>` e ignorado por nao ser
// so digitos.
const alvos = process.argv.slice(2).filter((a) => /^\+?\d[\d\s().-]*$/.test(a)).map(soDigitos).filter(Boolean);

const TEXTOS = {
  repique: (nome) => templates.repique(nome),
  protocolo: () => templates.protocolo(),
  interesse: () => templates.interesse(),
  negacao: () => templates.negacao(),
};

// Cria o socket e espera abrir; trata o 515 (restart required).
async function conectarAteAbrir(maxTentativas = 6) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pinoLogger,
      // Identidade canonica: rotulo inventado faz o WhatsApp recusar o codigo (PR #2559).
    browser: Browsers.windows('Chrome'),
    });
    sock.ev.on('creds.update', saveCreds);

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout ao conectar')), 30000);
        sock.ev.on('connection.update', (u) => {
          if (u.connection === 'open') {
            clearTimeout(t);
            resolve();
          } else if (u.connection === 'close') {
            clearTimeout(t);
            const status = u.lastDisconnect?.error?.output?.statusCode;
            reject(new Error(`restart:${status}`));
          }
        });
      });
      return sock;
    } catch (e) {
      try { sock.end(); } catch (e2) { console.error(`falha ao fechar o socket: ${e2.message}`); }
      console.log(`Tentativa ${tentativa} nao abriu (${e.message}). Reconectando...`);
      if (tentativa >= maxTentativas) throw new Error(`Nao foi possivel conectar. Rode "npm run connect".`);
      await delay(2500);
    }
  }
  throw new Error('Nao foi possivel conectar.');
}

async function main() {
  const saude = escopo.auditar();
  if (!saude.ok) {
    console.error('CONFIG INVALIDA - nada sera enviado:');
    for (const p of saude.problemas) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (!alvos.length) {
    console.error('Uso: node falar.js <numero> [<numero> ...] [--texto repique|protocolo|interesse|negacao]');
    process.exit(1);
  }

  const chaveTexto = arg('--texto') || 'protocolo';
  const montaTexto = TEXTOS[chaveTexto];
  if (!montaTexto) {
    console.error(`--texto desconhecido: ${chaveTexto} (use repique, protocolo, interesse ou negacao)`);
    process.exit(1);
  }
  // Nome por numero (o repique e personalizado). Sem nome, o template cai no "Oi!".
  const nomes = new Map();
  for (const e of numeros.carregar().entradas) nomes.set(soDigitos(e.numero), e.nome || null);
  const textoDe = (n) => montaTexto(nomes.get(n) || null);

  const validos = [];
  for (const n of alvos) {
    const jid = jidNumero(n);
    if (escopo.isEquipe(jid)) {
      console.error(`  pulado ${n}: equipe`);
      continue;
    }
    if (!escopo.emListaBranca(jid)) {
      console.error(`  pulado ${n}: fora_da_lista`);
      continue;
    }
    validos.push({ n, jid });
  }
  if (!validos.length) {
    console.error('Nenhum numero valido da lista. Nada enviado.');
    process.exit(1);
  }

  const janela = atendimento.podeEnviar();
  if (!janela.ok) {
    console.error(`Fora do horario de funcionamento (${janela.motivo}). Nada enviado.`);
    console.error('Para forcar em teste: $env:BIA_FORCAR="1"');
    process.exit(0);
  }

  // Um socket de cada vez, e nunca junto com o bot.
  const t = trava.adquirir();
  if (!t.ok) {
    console.error(`Ja existe um processo rodando (PID ${t.pid}). Pare o bot antes de falar.`);
    process.exit(1);
  }

  console.log(`Conectando para enviar para ${validos.length} numero(s)...`);
  let sock;
  try {
    sock = await conectarAteAbrir();
  } catch (e) {
    console.error(e.message);
    trava.liberar();
    process.exit(1);
  }

  let enviados = 0;
  let falhas = 0;
  for (const [i, a] of validos.entries()) {
    try {
      const r = await enviarTexto(sock, a.jid, textoDe(a.n), { motivo: 'espontaneo', log: console.log });
      if (r && r.barrado) {
        console.log(`[${a.n}] barrado (${r.motivo}), pulando.`);
        falhas++;
        continue;
      }
      estado.marcarNeutro(a.jid);
      enviados++;
      console.log(`[${a.n}] enviado (${enviados}/${validos.length}).`);
    } catch (e) {
      falhas++;
      console.error(`[${a.n}] falha: ${e.message}`);
      if (falhas >= 5) {
        console.error('5 falhas - abortando para nao queimar o numero.');
        break;
      }
    }

    if (i < validos.length - 1) {
      const espera = between(config.repique.intervaloMin, config.repique.intervaloMax);
      console.log(`  aguardando ${espera}s antes do proximo...`);
      await delay(espera * 1000);
    }
  }

  try { sock.end(); } catch (e) { console.error(`falha ao fechar o socket: ${e.message}`); }
  trava.liberar();
  console.log(`\nFalar: ${enviados} enviado(s), ${falhas} falha(s).`);
  process.exit(falhas && !enviados ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
