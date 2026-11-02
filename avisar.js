'use strict';

// ============================================================
// Aviso interno a equipe - e a fala que a resposta perdida pedia.
//
// Existe para reprocessar UMA resposta que o bot NAO tratou: sessao morta,
// fora do horario (a resposta fica "segurada" e nunca sai) ou bot desligado.
// Manda ao lead a fala que ele deveria ter recebido e avisa a equipe,
// marcando o estado como se o bot tivesse respondido.
//
//   node avisar.js 5511900000000 --tipo interesse --texto "Sim"
//   node avisar.js 5511900000000 --tipo talvez --texto "vou pensar"
//
// Mesma trava do bot/falar: um socket de cada vez, e a config e auditada
// antes de qualquer envio. So fala com lead de data/numeros.txt; a equipe
// nunca e tratada como alvo aqui (ela e quem RECEBE o aviso).
// ============================================================

const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const templates = require('./templates');
const config = require('./config');
const atendimento = require('./atendimento');
const escopo = require('./escopo.guard');
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
const soDigitos = (t) => String(t || '').replace(/\D/g, '');
const jidNumero = (numero) => `${soDigitos(numero)}@s.whatsapp.net`;

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i !== -1 ? process.argv[i + 1] : null;
}

const TIPOS = ['interesse', 'talvez', 'indefinido'];
const FALAS = {
  interesse: () => templates.interesse(),
  talvez: () => templates.talvez(),
  indefinido: () => null, // so avisa a equipe, nao fala com o lead
};
const MARCAR = {
  interesse: estado.marcarInteresse,
  talvez: estado.marcarTalvez,
  indefinido: () => {},
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

  const numero = soDigitos(process.argv[2] || '');
  const tipo = arg('--tipo') || 'interesse';
  const textoResposta = arg('--texto') || '';
  // --somente-equipe: manda so o aviso interno, sem falar com o lead (util
  // para avisar de um interesse que ja foi respondido). --forcar: reenvia o
  // aviso mesmo que equipeNotificadoEm ja esteja marcado.
  const somenteEquipe = process.argv.includes('--somente-equipe') || process.argv.includes('--sem-lead');
  const forcar = process.argv.includes('--forcar');

  if (!numero) {
    console.error('Uso: node avisar.js <numero E.164> [--tipo interesse|talvez|indefinido] [--texto "resposta da pessoa"] [--somente-equipe] [--forcar]');
    process.exit(1);
  }
  if (!TIPOS.includes(tipo)) {
    console.error(`--tipo desconhecido: ${tipo} (use ${TIPOS.join(', ')})`);
    process.exit(1);
  }

  const jid = jidNumero(numero);
  if (escopo.isEquipe(jid)) {
    console.error(`${numero} e numero de equipe: nao entra no fluxo.`);
    process.exit(1);
  }
  if (!escopo.emListaBranca(jid)) {
    console.error(`Fora da lista (${numero}). Nada enviado.`);
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
    console.error(`Ja existe um processo rodando (PID ${t.pid}). Pare o bot antes.`);
    process.exit(1);
  }

  console.log(`Conectando para avisar sobre ${numero} (${tipo})...`);
  let sock;
  try {
    sock = await conectarAteAbrir();
  } catch (e) {
    console.error(e.message);
    trava.liberar();
    process.exit(1);
  }

  const contato = estado.get(jid) || {};
  const nome = escopo.nomeDe(jid) || null;

  try {
    // 1. A fala que a resposta pedia (indefinido nao fala com o lead).
    const fala = somenteEquipe ? null : FALAS[tipo]();
    if (fala) {
      const r = await enviarTexto(sock, jid, fala, { motivo: 'solicitado', log: console.log });
      if (r && r.barrado) {
        console.log(`[${numero}] fala barrada (${r.motivo}).`);
      } else {
        MARCAR[tipo](jid);
        console.log(`[${numero}] fala enviada (${tipo}).`);
      }
    }

    // 2. O aviso a equipe. Um por pessoa (equipeNotificadoEm).
    const equipe = escopo.entradasEquipe();
    if (contato.equipeNotificadoEm && !forcar) {
      console.log(`[${numero}] equipe ja avisada antes - nao repete.`);
    } else if (!equipe.length) {
      console.log(`[${numero}] sem numero de equipe em config.escopo.equipe.`);
    } else {
      const aviso = templates.avisoEquipe({ nome, numero, texto: textoResposta, tipo });
      for (const pessoa of equipe) {
        const jidEquipe = jidNumero(pessoa.numero);
        try {
          await enviarTexto(sock, jidEquipe, aviso, { motivo: 'espontaneo', log: console.log });
          console.log(`[${numero}] equipe avisada em ${pessoa.numero}.`);
        } catch (e) {
          console.error(`[${numero}] falha ao avisar ${pessoa.numero}: ${e.message}`);
        }
      }
      estado.marcarEquipeNotificada(jid);
    }
  } finally {
    try { sock.end(); } catch (e) { console.error(`falha ao fechar o socket: ${e.message}`); }
    trava.liberar();
  }

  console.log('\nAvisar: pronto.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
