'use strict';

// ============================================================
// Disparo do repique.
//
// Le a lista de data/numeros.txt e manda UMA mensagem para cada numero que
// ainda nao recebeu o repique. Nada mais: quem responde e o `npm run bot`.
//
//   npm run repicar -- --dry-run            lista e nao envia
//   npm run repicar -- --limite 20          primeiros 20 pendentes
//   npm run repicar -- --para 5511900000000 so um numero
//   npm run repicar                         todos os pendentes
//
// Segurancas:
//   - a trava de PID impede rodar junto com o bot (dois sockets = mensagem 2x);
//   - numero que ja recebeu o repique e pulado (estado.repiqueEnviadoEm);
//   - sem janela de horario aberta, nao dispara (BIA_FORCAR=1 forca em teste);
//   - espera aleatoria entre um envio e o seguinte (config.repique), contra ban.
// ============================================================

const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const { repique } = require('./templates');
const config = require('./config');
const atendimento = require('./atendimento');
const numeros = require('./numeros');
const escopo = require('./escopo.guard');
const estado = require('./estado');
const store = require('./store');
const trava = require('./pid.lock');
const { enviarTexto } = require('./enviar');
const imagens = require('./imagens');
const mensagensCampanha = require('./mensagens-campanha');

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

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i !== -1 ? process.argv[i + 1] : null;
}
const dryRun = () => process.argv.includes('--dry-run');

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

// Decide quem recebe. Devolve { alvos, pulados }.
function selecionar() {
  const { entradas } = numeros.carregar();
  const soUm = arg('--para');
  const limite = Number(arg('--limite')) || 0;
  const alvos = [];
  const pulados = [];

  for (const entrada of entradas) {
    if (soUm && entrada.numero !== String(soUm).replace(/\D/g, '')) continue;

    const jid = jidNumero(entrada.numero);
    const contato = store.get(jid);
    // Numero novo ainda nao tem ficha no estado: sintetiza so com o jid, para
    // o portao conferir a lista em vez de recusar por "desconhecido".
    const portaria = escopo.podeReceberRepique({ ...(contato || {}), jid });
    if (!portaria.ok) {
      pulados.push({ ...entrada, motivo: portaria.motivo });
      continue;
    }
    alvos.push({ ...entrada, jid });
    if (limite && alvos.length >= limite) break;
  }
  return { alvos, pulados };
}

async function repicar() {
  const saude = escopo.auditar();
  if (!saude.ok) {
    console.error('CONFIG INVALIDA - nada sera enviado:');
    for (const p of saude.problemas) console.error(`  - ${p}`);
    process.exit(1);
  }

  const { alvos, pulados } = selecionar();

  console.log(`Lista: ${saude.total} numero(s); equipe: ${saude.equipe}.`);
  console.log(`Pendentes de repique: ${alvos.length}. Ja enviados/pulados: ${pulados.length}.`);
  for (const p of pulados) console.log(`  pulado ${p.numero}${p.nome ? ' (' + p.nome + ')' : ''}: ${p.motivo}`);

  if (!alvos.length) {
    console.log('Nada a fazer.');
    process.exit(0);
  }

  if (dryRun()) {
    console.log('\n[dry-run] NADA sera enviado. Alvos:');
    for (const a of alvos) {
      console.log(`  - ${a.numero}${a.nome ? ' (' + a.nome + ')' : ''}`);
      console.log(`    texto: ${repique(a.nome).replace(/\n/g, ' ')}`);
    }
    process.exit(0);
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
    console.error(`Ja existe um processo rodando (PID ${t.pid}). Pare o bot antes de repicar.`);
    process.exit(1);
  }

  console.log(`Conectando para enviar o repique para ${alvos.length} numero(s)...`);
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
  const consecutivasMax = 5;
  let consecutivas = 0;

  for (const [i, a] of alvos.entries()) {
    try {
      const img = imagens.paraRepique();
      const fala = mensagensCampanha.para(a.nome) || repique(a.nome);
      const r = await enviarTexto(sock, a.jid, fala, { motivo: 'espontaneo', log: console.log, imagem: img });
      if (r && r.barrado) {
        console.log(`[${a.numero}] barrado (${r.motivo}), pulando.`);
        falhas++;
        continue;
      }
      if (img) console.log(`[${a.numero}] com imagem ${img.nome}.`);
      estado.marcarRepiqueEnviado(a.jid);
      enviados++;
      consecutivas = 0;
      console.log(`[${a.numero}] repique enviado (${enviados}/${alvos.length}).`);
    } catch (e) {
      falhas++;
      consecutivas++;
      console.error(`[${a.numero}] falha: ${e.message}`);
      if (consecutivas >= consecutivasMax) {
        console.error(`${consecutivas} falhas seguidas - abortando para nao queimar o numero.`);
        break;
      }
    }

    if (i < alvos.length - 1) {
      const espera = between(config.repique.intervaloMin, config.repique.intervaloMax);
      console.log(`  aguardando ${espera}s antes do proximo...`);
      await delay(espera * 1000);
    }
  }

  try { sock.end(); } catch (e) { console.error(`falha ao fechar o socket: ${e.message}`); }
  trava.liberar();
  console.log(`\nRepique: ${enviados} enviado(s), ${falhas} falha(s).`);
  process.exit(falhas && !enviados ? 1 : 0);
}

if (require.main === module) {
  repicar().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { selecionar };
