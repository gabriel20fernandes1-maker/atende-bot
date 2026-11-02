'use strict';

const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

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

const usarPareamento =
  process.argv.includes('--pair') || process.env.BIA_PAIR === '1';

const logFile = path.join(config.dataFolder, 'connect.log');

function log(msg) {
  const linha = `[${new Date().toISOString()}] ${msg}`;
  console.log(linha);
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.appendFileSync(logFile, linha + '\n', 'utf8');
  } catch (e) {
    console.error(`[log] falha ao gravar connect.log: ${e.message}`);
  }
}

let travaObtida = false;
let tentativaReconexao = 0;

// Em modo pareamento, desistir no primeiro 408/401 e o pior desfecho: a sessao
// antiga ja foi guardada e o operador fica sem tela para tentar de novo. Aqui
// a auth PARCIAL (nunca registrou) e descartada e um codigo NOVO e pedido,
// mantendo o pareamento vivo por ate 30 min / 20 tentativas.
const PAREAMENTO_LIMITE_MS = 30 * 60 * 1000;
const PAREAMENTO_MAX_TENTATIVAS = 20;
const inicioPareamento = Date.now();

function descartarAuthParcial() {
  const backup = `${config.authFolder}_falha_${Date.now()}`;
  try {
    if (fs.existsSync(config.authFolder)) {
      fs.renameSync(config.authFolder, backup);
      log(`auth parcial de pareamento movida para ${backup}`);
    }
  } catch (e) {
    log(`falha ao mover auth parcial: ${e.message}`);
  }
  // O codigo antigo morreu junto com a auth: some da tela para ninguem
  // digitar um codigo que ja nao vale.
  try {
    fs.rmSync(path.join(config.dataFolder, 'pair_code.txt'), { force: true });
  } catch {
    // silencio-ok: arquivo ausente ja e o caso normal.
  }
}

// A trava e pega UMA vez. O reconnect automatico do 515 (que o WhatsApp exige
// LOGO APOS ler o QR) chama connect() de novo; se a trava fosse pega aqui
// dentro, o processo bateria na propria trava e sairia - era exatamente isso
// que fazia o pareamento morrer logo depois de escanear o QR.
function garantirTrava() {
  if (travaObtida) return true;
  const t = trava.adquirir();
  if (!t.ok) {
    log(`Ja existe um bot rodando (PID ${t.pid}). Pare o bot antes de conectar.`);
    return false;
  }
  travaObtida = true;
  process.on('exit', () => trava.liberar());
  return true;
}

async function connect() {
  log(`Iniciando. authFolder=${config.authFolder} existe=${fs.existsSync(config.authFolder)}`);
  if (!garantirTrava()) process.exit(1);

  const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pinoLogger,
    // Identidade canonica: rotulo inventado faz o WhatsApp recusar o codigo (PR #2559).
    browser: Browsers.windows('Chrome'),
    // No modo CODIGO o socket precisa VIVER enquanto a pessoa navega no
    // celular (Aparelhos conectados > Conectar > numero > codigo). Cada QR
    // que o servidor manda consome uma "ref"; quando as refs acabam, o
    // WhatsApp fecha a conexao ("QR refs attempts ended", 408) e o codigo
    // morre junto - eram ~2,5 min de vida. Esticando o tempo de cada QR, o
    // socket fica aberto ~20 min e o codigo nao morre no meio da digitacao.
    ...(usarPareamento ? { qrTimeout: 5 * 60 * 1000 } : {}),
  });

  // O codigo e pedido UMA vez por conexao. Renovar de tempo em tempo (o que
  // era feito antes) mandava um novo "companion_hello" e INVALIDAVA o codigo
  // que estava na tela: a pessoa digitava o codigo certo e o WhatsApp
  // respondia "Nao foi possivel conectar". Quem quiser outro codigo usa o
  // botao "Gerar novo codigo" no painel, que reinicia esta conexao.
  let codigoPedido = false;
  let encerrando = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection || qr) {
      log(`update: connection=${connection || '-'} qr=${qr ? 'sim' : 'nao'} status=${lastDisconnect?.error?.output?.statusCode ?? '-'} reason=${lastDisconnect?.error?.message || '-'}`);
    }

    if (qr && usarPareamento && !sock.authState.creds.registered) {
      // No modo codigo o QR tambem chega (e nao e mostrado). Pedimos o codigo
      // no primeiro QR - a conexao ja esta aberta - e nunca mais nesta
      // conexao, para o codigo da tela nao ser invalidado por baixo.
      if (!codigoPedido) {
        codigoPedido = true;
        try {
          let numero = String(config.numeroPareamento || '').replace(/\D/g, '');
          // DDD + numero (10/11 digitos) ganha o 55 do Brasil. Sem isso o
          // codigo e gerado para outro numero, a conexao morre (428) e o
          // operador acha que o codigo "expirou".
          if (numero.length === 10 || numero.length === 11) numero = '55' + numero;
          if (numero.length < 12) {
            log(`NUMERO DE PAREAMENTO INVALIDO: "${numero}" (faltam digitos). Corrija no painel.`);
          } else {
            const codigo = await sock.requestPairingCode(numero);
            fs.mkdirSync(config.dataFolder, { recursive: true });
            fs.writeFileSync(path.join(config.dataFolder, 'pair_code.txt'), `${codigo}\n${new Date().toISOString()}\n`, 'utf8');
            log(`CODIGO DE PAREAMENTO: ${codigo} (numero ${numero}; vale enquanto esta conexao estiver aberta)`);
          }
        } catch (e) {
          log(`Falha ao pedir codigo de pareamento: ${e.message}`);
        }
      }
    } else if (qr && !usarPareamento) {
      log('QR gerado -> data/qr.png');
      qrcode.generate(qr, { small: false });
      try {
        fs.mkdirSync(config.dataFolder, { recursive: true });
        QRCode.toFile(path.join(config.dataFolder, 'qr.png'), qr, { width: 360 }, (e) => {
          if (e) log(`Falha ao gerar qr.png: ${e.message}`);
        });
      } catch (e) {
        log(`Falha ao gerar qr.png: ${e.message}`);
      }
    }

    if (connection === 'close') {
      if (encerrando) {
        log('Encerramento intencional apos conectar. Sessao preservada.');
        process.exit(0);
      }
      const status = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'desconhecida';
      const registrado = !!sock.authState.creds.registered;
      const shouldReconnect = status !== DisconnectReason.loggedOut && lastDisconnect?.error !== undefined;
      log(`Conexao fechada (status ${status}) - ${reason}.`);

      // Pareamento ainda nao registrou e caiu (408 "QR refs attempts ended",
      // 401 "Connection Failure", 428...): o codigo expirou ou foi recusado.
      // 515 (restartRequired) e o caminho BOM: o codigo foi aceito e o
      // WhatsApp pede para reconectar - ai a auth e preservada.
      if (usarPareamento && !registrado && status !== DisconnectReason.restartRequired) {
        const tempo = Date.now() - inicioPareamento;
        if (tempo > PAREAMENTO_LIMITE_MS || tentativaReconexao >= PAREAMENTO_MAX_TENTATIVAS) {
          log(`Pareamento sem sucesso (${Math.round(tempo / 60000)} min, ${tentativaReconexao} tentativas). Desistindo.`);
          process.exit(0);
        }
        tentativaReconexao++;
        descartarAuthParcial();
        // 428 e limite de taxa do numero: insistir rapido agrava. Espera 1 min.
        const espera = status === DisconnectReason.connectionClosed ? 60000 : Math.min(30000, 2000 * tentativaReconexao);
        log(`Pareamento: novo codigo em ${espera / 1000}s (tentativa ${tentativaReconexao}).`);
        setTimeout(connect, espera);
        return;
      }

      if (shouldReconnect) {
        // Backoff exponencial. Reagendar de 3 em 3 segundos num loop de 408
        // (foi o que aconteceu em 07/10: centenas de tentativas seguidas) so
        // agrava - o WhatsApp trata como uso suspeito. 3s, 6s, 12s... ate 60s.
        tentativaReconexao++;
        const espera = Math.min(60000, 3000 * Math.pow(2, tentativaReconexao - 1));
        log(`Reconectando em ${espera / 1000}s (tentativa ${tentativaReconexao})...`);
        setTimeout(connect, espera);
      } else {
        const backup = `${config.authFolder}_invalid_${Date.now()}`;
        try { fs.renameSync(config.authFolder, backup); log(`auth movido para ${backup}`); } catch (e) { log(`falha ao mover auth: ${e.message}`); }
        log('Sessao encerrada (loggedOut). Rode "npm run connect" novamente.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      tentativaReconexao = 0;
      log('Conectado! Salvando sessao...');
      try {
        fs.rmSync(path.join(config.dataFolder, 'precisa-religar'), { force: true });
      } catch {
        // silencio-ok: marca ausente ja e o caso normal.
      }
      // Marcador explicito de que ESTA conexao completou (QR OU codigo). O
      // painel usa isto (e nao "existe creds?") para decidir se descarta a auth
      // antiga: durante um pareamento em andamento o creds.json ja existe mas
      // ainda nao esta registrado, o que confundiria a checagem.
      //
      // Tambem e a prova de re-pareamento que o saude.js usa para curar a
      // cegueira (curarSeRepareou). Antes ele so era escrito no modo CODIGO:
      // quem re-pareava por QR nunca curava a marca de cegueira - o painel
      // pedia pareamento para sempre, mesmo com a sessao lendo normalmente.
      if (sock.authState.creds.registered) {
        try {
          fs.writeFileSync(path.join(config.dataFolder, 'pareamento-ok'), new Date().toISOString(), 'utf8');
        } catch (e) {
          log(`falha ao gravar pareamento-ok: ${e.message}`);
        }
      }
      try {
        fs.writeFileSync(path.join(config.dataFolder, 'connected.txt'), new Date().toISOString(), 'utf8');
      } catch (e) {
        log(`falha ao gravar connected.txt: ${e.message}`);
      }
      // Espera generosa para garantir que creds.json seja gravado no disco
      setTimeout(() => {
        log(`authFolder existe agora=${fs.existsSync(config.authFolder)} arquivos=${fs.existsSync(config.authFolder) ? fs.readdirSync(config.authFolder).length : 0}`);
        encerrando = true;
        sock.end();
        setTimeout(() => process.exit(0), 1500);
      }, 8000);
    }
  });

  sock.ev.on('creds.update', () => {
    log('creds.update -> saveCreds()');
    return saveCreds();
  });
  return sock;
}

connect().catch((e) => {
  log(`ERRO FATAL em connect(): ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});