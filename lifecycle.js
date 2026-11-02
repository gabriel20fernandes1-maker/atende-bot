'use strict';

// ============================================================
// Ciclo de vida: socket, timers, PID e fila serial.
//
// Tudo que nascia dentro de conectar() nascia DE NOVO a cada reconexao - foi
// assim que o setInterval do follow-up virou N timers em 26/09, e foi por isso
// que o corpo do handler de mensagem ficou preso no transporte. Aqui as coisas
// nascem uma vez so (em main), e conectar() so conecta.
//
// REGRA: nenhum outro arquivo cria setInterval. O agendador e um tick unico
// que consulta a lista de tarefas. `npm run check` falha se setInterval
// aparecer fora daqui.
//
// O lifecycle NAO conhece regra de negocio: ele entrega a mensagem (upsert) e
// avisa a conexao; quem decide e o bot.js. Se ele passar a importar templates
// ou estado, viramos o bot.js de novo com outro nome.
// ============================================================

const config = require('./config');
const trava = require('./pid.lock');
const atendimento = require('./atendimento');
const fs = require('fs');
const path = require('path');

let dizer = () => {};
let aoUpsert = null;
let aoConexao = null;

function configurar({ log, upsert, conexao } = {}) {
  if (log) dizer = log;
  if (upsert) aoUpsert = upsert;
  if (conexao) aoConexao = conexao;
}

// ---------------- Fila serial ----------------
//
// Dois envios nunca se sobrepoem. Sem isso, dois triggers de follow-up
// paralelos leem `followUpEnviado: false`, os dois enviam, e a pessoa recebe
// a mesma mensagem 2x.
let fila = Promise.resolve();
let filaPendentes = 0;

function emFila(tarefa) {
  filaPendentes++;
  const resultado = fila.then(tarefa);
  fila = resultado.then(
    () => {},
    () => {}
  );
  return resultado.finally(() => {
    filaPendentes--;
  });
}

function pendentes() {
  return filaPendentes;
}

// ---------------- Agendador de tick unico ----------------
//
// Uma tarefa por vez, consultada de tempo em tempo. Nada de N setIntervals
// nascendo em N reconexoes.
let tickTimer = null;
let tarefas = [];
let proximoId = 1;

function proximaOcorrenciaDiaria(hora, agoraMs = Date.now()) {
  const alvo = atendimento.emMinutos(hora);
  const agora = atendimento.agora();
  let diff = alvo - agora.minutos;
  if (diff <= 0) diff += 24 * 60;
  return agoraMs + diff * 60000;
}

function agendarIntervalo(fn, ms, nome = 'intervalo') {
  const id = proximoId++;
  tarefas.push({ id, nome, tipo: 'intervalo', fn, intervaloMs: ms, proximoMs: Date.now() + ms });
  return id;
}

function agendarDiario(fn, hora, nome = 'diario') {
  const id = proximoId++;
  tarefas.push({ id, nome, tipo: 'diario', fn, hora, proximoMs: proximaOcorrenciaDiaria(hora) });
  return id;
}

function agendarUnico(fn, quandoMs, nome = 'unico') {
  const id = proximoId++;
  tarefas.push({ id, nome, tipo: 'unico', fn, proximoMs: quandoMs });
  return id;
}

function cancelar(id) {
  tarefas = tarefas.filter((t) => t.id !== id);
}

function tarefasAtivas() {
  return tarefas.length;
}

// Executa o que estiver vencido. `agoraMs` e injetavel para teste.
function tick(agoraMs = Date.now()) {
  for (const t of tarefas) {
    if (t.proximoMs > agoraMs) continue;
    try {
      t.fn();
    } catch (e) {
      dizer(`Erro na tarefa "${t.nome}": ${e.message}`);
    }
    if (t.tipo === 'intervalo') t.proximoMs = agoraMs + t.intervaloMs;
    else if (t.tipo === 'diario') t.proximoMs = proximaOcorrenciaDiaria(t.hora, agoraMs);
    else t.concluida = true;
  }
  tarefas = tarefas.filter((t) => !t.concluida);
}

function iniciarAgendador(ms = 30000) {
  if (tickTimer) return; // idempotente: uma vez so
  tickTimer = setInterval(tick, ms);
  if (tickTimer.unref) tickTimer.unref();
}

function pararAgendador() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  tarefas = [];
}

// ---------------- PID ----------------
function adquirirTrava() {
  return trava.adquirir();
}
function liberarTrava() {
  return trava.liberar();
}

// ---------------- Conexao ----------------
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');

const pinoLogger = (() => {
  try {
    return require('pino')({ level: 'silent' });
  } catch {
    // silencio-ok: pino e opcional; sem ele o Baileys usa o proprio logger.
    return undefined;
  }
})();

let sockAtual = null;
let estadoSocket = 'desconhecido';
let tentativaReconexao = 0;
// Fecha o socket por decisao NOSSA (nao por queda). Sem esta marca, o close
// cai no ramo de loggedOut e marca "precisa religar" sem o WhatsApp ter
// desvinculado nada.
let reconexaoManual = false;

// O contador de tentativas so zera depois que a conexao FICOU de pe um tempo.
//
// Zerar no 'open' instantaneo fazia o backoff nunca crescer: o socket abria
// e caia em segundos (428), o contador voltava a zero e a Bia reconectava sem
// parar. Em 19/10 foram 8 boots e 17 tentativas de pareamento em 80 minutos
// - o bot nao estava morrendo, estava tropeçando no proprio backoff.
const ESTABILIDADE_SEGUNDOS = 60;
let timerEstabilidade = null;

function marcarEstavel() {
  if (timerEstabilidade) clearTimeout(timerEstabilidade);
  timerEstabilidade = setTimeout(() => {
    timerEstabilidade = null;
    tentativaReconexao = 0;
  }, ESTABILIDADE_SEGUNDOS * 1000);
  if (timerEstabilidade.unref) timerEstabilidade.unref();
}

function cancelarEstavel() {
  if (timerEstabilidade) clearTimeout(timerEstabilidade);
  timerEstabilidade = null;
}

// ---------------- Marca "precisa religar" ----------------
//
// Escrita quando o WhatsApp desvincula o aparelho (loggedOut). E o que segura
// o watchdog: sem re-parear, nao adianta reiniciar. Depois de um re-parear
// (pelo painel ou manual), a marca e velha e trava a Bia fora do ar para
// sempre - por isso ela se apaga quando a conexao volta.
const ARQUIVO_PRECISA_RELIGAR = 'precisa-religar';

function caminhoReligar() {
  return path.join(config.dataFolder, ARQUIVO_PRECISA_RELIGAR);
}

function marcarReligar() {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.writeFileSync(caminhoReligar(), new Date().toISOString(), 'utf8');
    return true;
  } catch {
    // silencio-ok: se nao der para marcar, o pior caso e o watchdog tentar de novo.
    return false;
  }
}

function limparMarcaReligar() {
  try {
    if (fs.existsSync(caminhoReligar())) {
      fs.unlinkSync(caminhoReligar());
      dizer('Marca de "precisa religar" removida: a conexao voltou.');
    }
  } catch (e) {
    dizer(`Falha ao remover a marca de religar: ${e.message}`);
  }
}

function estado() {
  return estadoSocket;
}
function socket() {
  return sockAtual;
}

// Reinicia o socket sem trocar de sessao. Usado quando a Bia esta "surda"
// (socket open e nenhuma mensagem entrando): derrubar e reconectar e a unica
// acao local que costuma destravar a entrega de mensagens.
function reconectarAgora(motivo = 'manual') {
  if (reconexaoManual) return false;
  reconexaoManual = true;
  tentativaReconexao = 0;
  dizer(`Reconexao forcada (${motivo}).`);
  if (sockAtual) {
    try {
      sockAtual.end();
    } catch (e) {
      dizer(`Falha ao fechar o socket para reconectar: ${e.message}`);
      reconexaoManual = false;
    }
  } else {
    setTimeout(() => {
      reconexaoManual = false;
      conectar().catch((e) => dizer(`Erro ao reconectar: ${e.message}`));
    }, 1000);
  }
  return true;
}

// Reinicio de PROCESSO: a cura confirmada da cegueira. Reconectar o socket no
// MESMO processo (reconectarAgora) NAO resolve - relatos de producao na issue
// Baileys #2491 mostram a sessao voltando cega; so um processo NOVO limpa o
// estado travado. Aqui gravamos a marca para o supervisor e encerramos: o
// watchdog reergue a Bia limpa. Se o reinicio nao curar, o watchdog escala
// para re-link (precisa-religar).
function reiniciarProcesso(motivo = 'cego') {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.writeFileSync(
      path.join(config.dataFolder, 'precisa-reiniciar'),
      `${motivo}\n${new Date().toISOString()}\n`,
      'utf8'
    );
  } catch {
    // silencio-ok: o watchdog percebe a queda pelo processo; a marca so carrega
    // o motivo, entao perder a marca nao impede o reinicio.
  }
  dizer(`Reiniciando o processo (${motivo}) - o supervisor sobe a Bia de novo.`);
  parar();
  process.exit(1);
}

async function conectar() {
  // Fecha o socket anterior. Sem isto, os handlers do socket velho seguem
  // vivos e o mesmo evento pode ser tratado duas vezes.
  if (sockAtual) {
    try {
      sockAtual.end();
    } catch (e) {
      dizer(`Falha ao fechar o socket antigo: ${e.message}`);
    }
    sockAtual = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pinoLogger,
    // Identidade canonica: rotulo inventado faz o WhatsApp recusar o codigo (PR #2559).
    browser: Browsers.windows('Chrome'),
    // Opcoes de estabilidade (issue Baileys #2491: sessao fica "cega" quando uma
    // query pendurada trava o mutex de mensagens). Os defaults do 6.7.24 ja sao
    // estes, mas ficam EXPLICITOS para nao depender de mudanca de default:
    //   - defaultQueryTimeoutMs: uma query sem prazo trava a fila e cega a
    //     sessao; 60s libera.
    //   - keepAliveIntervalMs: ping da conexao; se demora o WhatsApp derruba.
    //   - fireInitQueries: sem as queries iniciais o WhatsApp responde 408.
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    fireInitQueries: true,
    markOnlineOnConnect: true,
    // syncFullHistory: puxar o historico INTEIRO joga muita coisa pelo mesmo
    // mutex logo no boot - justamente a janela onde a sessao costuma travar.
    // Fica false (default do Baileys) para reduzir a carga. Mensagem recente
    // ainda pode entrar pelo evento messaging-history.set.
    syncFullHistory: false,
  });
  sockAtual = sock;
  const meu = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (sockAtual !== meu) return; // socket velho: ignora
    const { connection, lastDisconnect } = update;
    if (connection) {
      estadoSocket = connection;
      if (connection === 'open') {
        // Conectou de verdade: o aparelho esta vinculado. A marca de
        // "precisa religar" e o que segura o watchdog; sem esta limpeza a
        // Bia ficava presa fora do ar depois de um re-parear feito fora do
        // painel.
        limparMarcaReligar();
        marcarEstavel();
      }
      const status = lastDisconnect?.error?.output?.statusCode;
      if (aoConexao) aoConexao({ estado: connection, status, loggedOut: status === DisconnectReason.loggedOut });
    }
    if (connection === 'close') {
      // A conexao nao segurou: o backoff tem que crescer, entao o contador
      // NAO volta a zero aqui.
      cancelarEstavel();
      // Fechamento que NOS pedimos (reconectarAgora): nao e loggedOut.
      if (reconexaoManual && sockAtual === meu) {
        reconexaoManual = false;
        dizer('Socket reiniciado de proposito (surdez). Reconectando em 2s...');
        setTimeout(() => conectar().catch((e) => dizer(`Erro ao reconectar: ${e.message}`)), 2000);
        return;
      }
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status !== DisconnectReason.loggedOut && lastDisconnect?.error !== undefined) {
        // Backoff exponencial: um loop de 408 a cada 3s so agrava (e ajuda o
        // WhatsApp a tratar como suspeito). 3s, 6s, 12s... ate 60s.
        tentativaReconexao++;
        const espera = Math.min(60000, 3000 * Math.pow(2, tentativaReconexao - 1));
        dizer(`Conexao fechada (${status}). Reconectando em ${espera / 1000}s (tentativa ${tentativaReconexao})...`);
        setTimeout(() => conectar().catch((e) => dizer(`Erro ao reconectar: ${e.message}`)), espera);
      } else {
        // loggedOut: o WhatsApp desvinculou o aparelho. Nao adianta reiniciar -
        // precisa religar pelo painel. Deixa a marca para o watchdog parar.
        marcarReligar();
        dizer('APARELHO DESVINCULADO (loggedOut). Religue pelo painel: "Conectar / Trocar numero".');
        process.exit(0);
      }
    }
  });

  sock.ev.on('messages.upsert', async (evento) => {
    if (sockAtual !== meu) return;
    if (!aoUpsert) return;
    try {
      await aoUpsert(evento, meu);
    } catch (e) {
      dizer(`Erro ao tratar upsert: ${e.message}`);
    }
  });

  // Historico/offline (syncFullHistory). Entra como um upsert do tipo
  // 'history' para o bot aplicar o mesmo filtro de recencia e responder.
  sock.ev.on('messaging-history.set', async (set) => {
    if (sockAtual !== meu) return;
    if (!aoUpsert) return;
    const messages = Array.isArray(set && set.messages) ? set.messages : [];
    if (!messages.length) return;
    try {
      await aoUpsert({ messages, type: 'history' }, meu);
    } catch (e) {
      dizer(`Erro ao tratar historico: ${e.message}`);
    }
  });

  return sock;
}

function parar() {
  pararAgendador();
  if (sockAtual) {
    try {
      sockAtual.end();
    } catch {
      // silencio-ok: encerramento best-effort; se o socket ja morreu, nada a fazer.
    }
  }
  sockAtual = null;
}

module.exports = {
  configurar,
  emFila,
  pendentes,
  agendarIntervalo,
  agendarDiario,
  agendarUnico,
  cancelar,
  tarefasAtivas,
  tick,
  iniciarAgendador,
  pararAgendador,
  adquirirTrava,
  liberarTrava,
  conectar,
  reconectarAgora,
  reiniciarProcesso,
  parar,
  estado,
  socket,
};
