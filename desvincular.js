'use strict';

// ============================================================
// Desvincula o aparelho do bot da conta do WhatsApp (sock.logout).
//
// Por que existe: uma conta aceita no maximo 4 aparelhos conectados. Re-parear
// sem desvincular o antigo cria um aparelho NOVO a cada troca, ate estourar o
// limite. Aqui o aparelho atual e removido do lado do WhatsApp, liberando vaga.
//
// Rodar com o bot PARADO (a trava impede dois sockets ao mesmo tempo). O painel
// faz essa orquestracao no botao "Desvincular aparelho".
//
//   node desvincular.js
//
// A sessao local vira um backup `auth-desvinculado-<ts>` (nada se perde).
// ============================================================

const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const config = require('./config');
const trava = require('./pid.lock');

const pinoLogger = (() => {
  try {
    return require('pino')({ level: 'silent' });
  } catch {
    // silencio-ok: pino e opcional; sem ele o Baileys usa o proprio logger.
    return undefined;
  }
})();

function log(msg) {
  const linha = `[${new Date().toISOString()}] [desvincular] ${msg}`;
  console.log(linha);
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.appendFileSync(path.join(config.dataFolder, 'connect.log'), linha + '\n', 'utf8');
  } catch (e) {
    console.error(`[desvincular] falha ao gravar no log: ${e.message}`);
  }
}

function guardarSessao() {
  const destino = `${config.authFolder}-desvinculado-${Date.now()}`;
  try {
    if (fs.existsSync(config.authFolder)) {
      fs.renameSync(config.authFolder, destino);
      log(`sessao guardada em ${destino}`);
    }
  } catch (e) {
    log(`falha ao guardar a sessao: ${e.message}`);
  }
}

async function desvincular() {
  if (!fs.existsSync(path.join(config.authFolder, 'creds.json'))) {
    log('sem sessao pareada (auth/creds.json ausente) - nada a desvincular.');
    return 0;
  }

  const r = trava.adquirir();
  if (!r.ok) {
    log(`o bot esta rodando (PID ${r.pid}). Pare o bot antes de desvincular.`);
    return 1;
  }
  process.on('exit', () => trava.liberar());

  const { state } = await useMultiFileAuthState(config.authFolder);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pinoLogger,
    // Identidade canonica: rotulo inventado faz o WhatsApp recusar o codigo (PR #2559).
    browser: Browsers.windows('Chrome'),
  });

  const codigo = await new Promise((resolve) => {
    let terminado = false;
    const terminar = (c) => {
      if (terminado) return;
      terminado = true;
      try {
        sock.end();
      } catch (e) {
        log(`falha ao fechar o socket: ${e.message}`);
      }
      resolve(c);
    };

    sock.ev.on('connection.update', async (update) => {
      if (update.qr) {
        log('a sessao local nao vale mais (o WhatsApp pediu QR) - nada a desvincular.');
        terminar(0);
        return;
      }
      if (update.connection === 'open') {
        log('conectado. Pedindo logout no WhatsApp...');
        try {
          await sock.logout();
          log('logout aceito - aparelho desvinculado.');
          terminar(0);
        } catch (e) {
          log(`falha no logout: ${e.message}`);
          terminar(1);
        }
      } else if (update.connection === 'close') {
        const status = update.lastDisconnect?.error?.output?.statusCode;
        if (status === 401) {
          log('sessao ja invalida no servidor (401) - considerando desvinculada.');
          terminar(0);
        } else {
          log(`conexao fechada antes do logout (status ${status || '-'}).`);
          terminar(1);
        }
      }
    });
  });

  guardarSessao();
  return codigo;
}

desvincular()
  .then((codigo) => process.exit(codigo || 0))
  .catch((e) => {
    log(`ERRO em desvincular(): ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
