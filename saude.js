'use strict';

// ============================================================
// Saude da Bia.
//
// O incidente de 29/09 mostrou que a Bia falha em silencio de duas formas:
//
//   1. o processo morre (o `amanho` indefinido derrubou o boot) e ninguem ve;
//   2. o processo fica VIVO e conectado, mas cego: o libsignal nao decripta
//      mais nada e a Bia nunca mais "ouve" - ela envia e nao responde.
//
// A segunda e a pior, porque parece saudavel. Nao havia nem log de inbound
// para denunciar. Este modulo existe para transformar isso em numero:
//
//   - ultimoInboundEm   -> quando foi a ultima mensagem que a Bia conseguiu LER
//   - ultimoEnvioEm     -> quando foi o ultimo envio que saiu
//   - falhasDecrypt     -> quantas vezes o libsignal cuspiu "Failed to decrypt"
//   - conectadoEm       -> desde quando a sessao esta de pe
//
// `status.js` le esses campos e responde a unica pergunta que importa:
// "a Bia esta funcionando agora?".
//
// O ruido: o libsignal (node_modules/libsignal/src/session_cipher.js) chama
// `console.error` direto, sem passar pelo logger do Baileys. Nao da para
// silenciar pelo `logger` do socket. Entao a gente embrulha o console: o que
// e ruido conhecido vira contador, o resto continua aparecendo.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');

const ARQ = path.join(config.dataFolder, 'health.json');

// Assinaturas do ruido do libsignal. Sao literais de
// node_modules/libsignal/src/session_cipher.js - se o pacote mudar o texto,
// o filtro deixa passar e a gente percebe pelo log, nunca o contrario.
const RUIDO = [
  'Failed to decrypt message with any known session',
  'Session error:',
  'Decrypted message with closed session',
];

let cache = null;
let gravacaoAgendada = null;
let filtroInstalado = false;

function carregar() {
  if (cache) return cache;
  try {
    const cru = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    cache = cru && typeof cru === 'object' && !Array.isArray(cru) ? cru : {};
  } catch {
    // silencio-ok: health.json ausente ou corrompido comeca vazio; a saude
    // nunca pode derrubar a Bia.
    cache = {};
  }
  return cache;
}

function gravar() {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.writeFileSync(ARQ, JSON.stringify(carregar()), 'utf8');
  } catch {
    // silencio-ok: saude nunca pode derrubar a Bia. Se nao deu para gravar, o
    // `status` vai dizer que o arquivo esta velho - que e a informacao correta.
  }
}

// Falha de decrypt chega as centenas. Gravar a cada uma seria I/O a toa;
// agendar uma gravacao so ja preserva o contador (ele vive em memoria).
function gravarLogo() {
  if (gravacaoAgendada) return;
  gravacaoAgendada = setTimeout(() => {
    gravacaoAgendada = null;
    gravar();
  }, 2000);
  if (gravacaoAgendada.unref) gravacaoAgendada.unref();
}

function atualizar(campos) {
  Object.assign(carregar(), campos);
  gravar();
  return cache;
}

function agora() {
  return new Date().toISOString();
}

function marcarBoot(pid) {
  const e = carregar();
  // A regra antiga usava `falhasDecrypt` GLOBAL (poluido por grupo/status) como
  // evidencia de cegueira. Essa evidencia foi aposentada: uma marca que veio SO
  // dela e falso positivo e nao deve sobreviver ao boot - era ela que fazia o
  // painel pedir re-pareamento para sempre com a visao funcionando. Se a sessao
  // continuar quebrada, o sem_corpo 1:1 (ou a sonda) remarca em minutos.
  const cegueiraObsoleta = Boolean(e.cegueira) && e.cegueiraEvidencia === 'falhas_decrypt';
  return atualizar({
    pid: pid || process.pid,
    iniciadoEm: agora(),
    conectadoEm: null,
    desconectadoEm: null,
    // ultimoInboundEm e ultimoEnvioEm NAO sao zerados: sao "a ultima vez que a
    // Bia ouviu/falou", de qualquer sessao. Zerar aqui fazia o status dizer que
    // ela nunca ouviu ninguem - e escondia justamente o que precisa ser visto.
    // A surdez da sessao atual e contada a partir de conectadoEm (avaliarSurdez).
    falhasDecrypt: 0,
    inbounds: 0,
    envios: 0,
    upserts: 0,
    upsertsNaoNotify: 0,
    upsertsSemTexto: 0,
    ultimoUpsertEm: null,
    ultimoHeartbeatEm: null,
    descartes: {},
    surdo: false,
    ultimaSondaEm: null,
    sondaResultado: null,
    // O contador de falhas da sonda NAO e zerado aqui, como a cegueira: ele
    // conta "falhadas seguidas desde o ultimo teste bem-sucedido", e essa
    // sequencia e do APARELHO, nao do processo. Zerar no boot fazia a
    // cegueira confirmada voltar a ser "suspeita" a cada reinicio.
    surdoConfirmado: false,
    // A cegueira NAO e zerada aqui: o estado quebrado esta no disco (auth/),
    // nao no processo. O bot novo precisa herdar esse "eu estou cego" para
    // nao sair disparando repique num buraco. A referencia (janela de
    // evidencia), essa sim, comeca do zero.
    ...(cegueiraObsoleta
      ? { cegueira: false, cegueiraConfirmada: false, cegueiraDesde: null, cegueiraEvidencia: null }
      : {}),
    cegueiraRef: { em: agora(), upserts: 0, inbounds: 0, falhasDecrypt: 0, semCorpo: 0 },
  });
}

// Diagnostico do "a Bia esta cega?". Separa dois casos que parecem iguais:
//
//   upserts sobe, inbounds nao  -> a mensagem CHEGOU e nao deu para decriptar
//                                  (sessao Signal quebrada)
//   upserts nao sobe            -> a mensagem nem chegou ao socket
//                                  (problema de vinculo/entrega, nao de sessao)
//
// Sem essa separacao a gente chutava o remedio. Nao e contador de vaidade:
// e o que decide entre limpar sessao e re-parear.
function contarUpsert(tipo, quantos) {
  const e = carregar();
  e.upserts = (e.upserts || 0) + 1;
  e.ultimoUpsertEm = agora();
  if (tipo !== 'notify') e.upsertsNaoNotify = (e.upsertsNaoNotify || 0) + 1;
  e.ultimaLeva = quantos || 0;
  gravarLogo();
}

function contarUpsertSemTexto() {
  const e = carregar();
  e.upsertsSemTexto = (e.upsertsSemTexto || 0) + 1;
  gravarLogo();
}

// Por que a mensagem foi descartada ANTES de virar resposta. `inbounds` conta o
// que chegou e deu para ler; `descartes` separa "chegou e era fromMe/sem texto"
// de "nem chegou". Sem isso, "nao recebe" e "recebe e joga fora" parecem iguais.
function contarDescarte(motivo) {
  const e = carregar();
  if (!e.descartes || typeof e.descartes !== 'object') e.descartes = {};
  e.descartes[motivo] = (e.descartes[motivo] || 0) + 1;
  gravarLogo();
}

// ============================================================
// Heartbeat e surdez.
//
// O estado que enganou o dia inteiro: socket "open", tudo verde, e nenhuma
// mensagem entrando. O `status.js` detecta isso quando alguem olha; o
// heartbeat detecta sozinho, no log, enquanto ninguem olha.
// ============================================================

const LIMITE_SURDEZ_MIN = 30;

// Puro, para poder testar sem socket. `ultimoInboundEm` nulo significa "nunca
// ouviu": nesse caso a conta comeca do `conectadoEm`, senao a Bia nasceria
// "surda" no primeiro segundo de vida.
function avaliarSurdez({
  conectado,
  ultimoInboundEm = null,
  conectadoEm = null,
  agoraMs = Date.now(),
  limiteMin = LIMITE_SURDEZ_MIN,
} = {}) {
  if (!conectado) return { surdo: false, minutos: null };
  // A referencia e a MAIS RECENTE entre o ultimo inbound e o inicio desta
  // conexao. Motivo: se a Bia ouviu alguem ontem (ultimoInboundEm preservado no
  // boot), a surdez de hoje ainda tem de contar desde que ela conectou - senao
  // o alerta dispararia no primeiro minuto de uma sessao nova.
  const ref = maisRecente(ultimoInboundEm, conectadoEm);
  if (!ref) return { surdo: false, minutos: null };
  const t = Date.parse(ref);
  if (Number.isNaN(t)) return { surdo: false, minutos: null };
  const minutos = (agoraMs - t) / 60000;
  return { surdo: minutos > limiteMin, minutos };
}

function maisRecente(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? null : b;
  if (Number.isNaN(tb)) return a;
  return ta >= tb ? a : b;
}

// ============================================================
// Cegueira: o discriminador que decide entre "ninguem falou" e
// "falou e eu nao consegui ler".
//
// A sessao quebrada do Signal nao e silencio: sao mensagens CHEGANDO sem
// corpo, porque o libsignal nao decriptou. De 19/10: 2176 mensagem assim e
// 16 lidas. O socket esta "open", o heartbeat esta verde, e a Bia envia e
// nunca ouve.
//
// A evidencia e contada desde a REFERENCIA: o instante em que a Bia leu
// alguma coisa pela ultima vez (ou em que conectou, se nunca leu). A
// referencia e zerada a cada inbound lido - a partir dali a hipotese de
// cegueira volta a valer do zero.
//
// O que NAO prova cegueira: nada de falha e nada de mensagem sem corpo. Isso
// e so silencio, e silencio e o estado normal de uma empresa fechada.
//
// O que NAO resolve cegueira: reiniciar o processo. O estado quebrado esta
// no disco (auth/pre-key-*.json); so um device novo conserta.
// ============================================================

const LIMITE_CEGUEIRA_MIN = 10;

// Fotografia dos contadores no instante da referencia.
function referenciaCegueira(e) {
  return {
    em: agora(),
    upserts: e.upserts || 0,
    inbounds: e.inbounds || 0,
    falhasDecrypt: e.falhasDecrypt || 0,
    semCorpo: (e.descartes && e.descartes.sem_corpo) || 0,
  };
}

// Puro, para poder testar sem socket e sem disco.
function avaliarCegueira({
  conectado = false,
  ref = null,
  upserts = 0,
  inbounds = 0,
  falhasDecrypt = 0,
  semCorpo = 0,
  agoraMs = Date.now(),
  limiteMin = LIMITE_CEGUEIRA_MIN,
} = {}) {
  const base = ref || {};
  const deltas = {
    upserts: upserts - (base.upserts || 0),
    inbounds: inbounds - (base.inbounds || 0),
    falhasDecrypt: falhasDecrypt - (base.falhasDecrypt || 0),
    semCorpo: semCorpo - (base.semCorpo || 0),
  };

  if (!conectado) return { cega: false, motivo: 'desconectado', minutos: null, deltas };
  if (!ref || !ref.em) return { cega: false, motivo: 'sem_referencia', minutos: null, deltas };

  const t = Date.parse(ref.em);
  if (Number.isNaN(t)) return { cega: false, motivo: 'referencia_invalida', minutos: null, deltas };

  const minutos = (agoraMs - t) / 60000;
  if (minutos < limiteMin) return { cega: false, motivo: 'janela', minutos, deltas };
  // Leu alguma coisa na janela: a sessao decripta, nao esta cega.
  if (deltas.inbounds > 0) return { cega: false, motivo: 'ouviu', minutos, deltas };

  // A evidencia que separa "quebrou" de "ninguem falou": mensagem 1:1 de
  // cliente que chegou SEM CORPO (nao decriptou). So isso.
  //
  // `falhasDecrypt` deixou de ser evidencia: o libsignal falha em massa para
  // trafego LATERAL (grupos, status, newsletter - sender keys) sem que a
  // conversa 1:1 esteja quebrada. Usar o contador global fazia a Bia parecer
  // cega e pedir re-pareamento mesmo lendo os clientes normalmente. Ele
  // continua sendo coletado como diagnostico (status mostra "DECRYPT"), mas
  // nao decide mais o veredito.
  const evidencia = deltas.semCorpo > 0 ? 'sem_corpo' : null;
  if (!evidencia) return { cega: false, motivo: 'silencio', minutos, deltas };

  return { cega: true, motivo: evidencia, minutos, deltas };
}

// O estado que SOBREVIVE ao boot: a sessao quebrada esta no disco, nao no
// processo. Reiniciar o bot nao conserta, entao o bot novo precisa saber que
// a sessao continua quebrada - senao ele sai mandando repique para um buraco.
function registrarCegueira(cega, evidencia, confirmada = false) {
  const e = carregar();
  if (cega) {
    if (!e.cegueira) {
      return atualizar({
        cegueira: true,
        cegueiraConfirmada: Boolean(confirmada),
        cegueiraDesde: agora(),
        cegueiraEvidencia: evidencia || null,
      });
    }
    // A confirmacao nunca se perde sozinha: ela so sai com prova de cura
    // (leu uma mensagem) ou com re-pareamento.
    const confirmadaAgora = Boolean(confirmada) || Boolean(e.cegueiraConfirmada);
    return atualizar({
      cegueiraConfirmada: confirmadaAgora,
      cegueiraEvidencia: evidencia || e.cegueiraEvidencia || null,
    });
  }
  if (!e.cegueira) return e;
  return atualizar({
    cegueira: false,
    cegueiraConfirmada: false,
    cegueiraDesde: null,
    cegueiraEvidencia: null,
  });
}

// Atalho: avalia a cegueira com o estado que esta gravado no health.json.
function avaliarCegueiraAtual({ conectado = false, agoraMs = Date.now() } = {}) {
  const e = carregar();
  return avaliarCegueira({
    conectado,
    ref: e.cegueiraRef || null,
    upserts: e.upserts || 0,
    inbounds: e.inbounds || 0,
    falhasDecrypt: e.falhasDecrypt || 0,
    semCorpo: (e.descartes && e.descartes.sem_corpo) || 0,
    agoraMs,
  });
}

// O re-pareamento e a cura de verdade: o aparelho novo refaz as chaves do
// Signal. O connect.js deixa o marcador data/pareamento-ok; se ele for mais
// novo que a marca de cegueira, a sessao foi refeita e a cegueira acabou.
function curarSeRepareou() {
  const e = carregar();
  if (!e.cegueira) return false;
  let m;
  try {
    m = fs.statSync(path.join(config.dataFolder, 'pareamento-ok')).mtimeMs;
  } catch {
    // silencio-ok: sem marcador de pareamento nao ha re-pareamento a curate.
    return false;
  }
  const desde = Date.parse(e.cegueiraDesde || '');
  if (Number.isNaN(desde) || m <= desde) return false;
  marcarCegueiraCurada();
  return true;
}

// O estado de cegueira e "queda", nao "piscada": a sessao so cura com um
// re-pareamento ou com um inbound lido. Ler uma mensagem e a prova de que a
// sessao decripta de novo.
function marcarCegueiraCurada() {
  const e = carregar();
  if (!e.cegueira) return e;
  return atualizar({
    cegueira: false,
    cegueiraConfirmada: false,
    cegueiraDesde: null,
    cegueiraEvidencia: null,
  });
}

function registrarHeartbeat(dados) {
  return atualizar({ ultimoHeartbeatEm: agora(), ...dados });
}

// ============================================================
// Sonda de visao (issue Baileys #2491).
//
// A cegueira se cura reiniciando o PROCESSO, mas so vale reiniciar quando ha
// certeza. `avaliarSondagem` decide SE vale testar (conectada e quieta ha
// tempo); `marcarSonda` registra o resultado. A sonda leve (onWhatsApp) so
// dispara a pesada (mensagem a si mesma + espera do eco); apenas a pesada sem
// eco marca surdoConfirmado.
// ============================================================

const LIMITE_SONDAGEM_MIN = 15;

// "Quieta" aqui significa SEM MENSAGEM LEGIVEL - nao "sem upsert".
//
// A sessao quebrada produz upsert sem parar (de 19/10: 2176 em pocas horas).
// Se a quietude fosse contada por upsert, a sonda nunca rodaria justamente
// na cegueira que ela existe para detectar. O que interessa e o ultimo
// inbound QUE A BIA CONSEGUIU LER.
function avaliarSondagem({
  conectado = false,
  ultimoInboundEm = null,
  conectadoEm = null,
  agoraMs = Date.now(),
  limiteMin = LIMITE_SONDAGEM_MIN,
} = {}) {
  const r = avaliarSurdez({ conectado, ultimoInboundEm, conectadoEm, agoraMs, limiteMin });
  return { sondar: r.surdo, minutos: r.minutos };
}

// `contar: false` marca a tentativa sem contar como falha: um teste que nao
// pode ser feito (o socket caiu) nao e cegueira, e nao pode empilhar com o
// teste de verdade para "confirmar" uma cegueira que nao existe.
function marcarSonda({ tipo = 'desconhecida', ok = false, contar = true } = {}) {
  const e = carregar();
  if (ok) {
    // Eco voltou: a sessao PROVOU que decripta agora. Isso e a mesma prova de um
    // inbound lido, entao cura a cegueira e reinicia a janela de evidencia (sem
    // o reset do cegueiraRef, um sem_corpo antigo reagendaria a marca no
    // heartbeat seguinte). O estado real de pareamento (precisa-religar) NAO e
    // tocado aqui: quem cuida dele e o lifecycle/connect.
    return atualizar({
      ultimaSondaEm: agora(),
      sondaResultado: `${tipo}:ok`,
      sondaFalhas: 0,
      surdoConfirmado: false,
      cegueira: false,
      cegueiraConfirmada: false,
      cegueiraDesde: null,
      cegueiraEvidencia: null,
      cegueiraRef: referenciaCegueira(e),
    });
  }
  return atualizar({
    ultimaSondaEm: agora(),
    sondaResultado: `${tipo}:${ok ? 'ok' : 'falha'}`,
    sondaFalhas: contar ? (e.sondaFalhas || 0) + 1 : e.sondaFalhas || 0,
    surdoConfirmado: !ok && tipo === 'confirmacao',
  });
}

function marcarConexao() {
  const e = carregar();
  // Conectar zera a janela de evidencia: a duvida vale para esta sessao.
  return atualizar({ conectadoEm: agora(), desconectadoEm: null, cegueiraRef: referenciaCegueira(e) });
}

function marcarDesconexao(motivo) {
  const e = carregar();
  // Historico das quedas (ultimos 10): e o que permite ver o padrao do 428
  // (WhatsApp cortando por limite de taxa) em vez de um evento solto.
  const hist = Array.isArray(e.desconexoes) ? e.desconexoes.slice(-9) : [];
  hist.push({ em: agora(), motivo: motivo || null });
  return atualizar({
    desconectadoEm: agora(),
    motivoDesconexao: motivo || null,
    desconexoes: hist,
  });
}

// ============================================================
// Conta sob limitacao (428).
//
// O WhatsApp fecha a conexao com 428 quando o numero entra em limite de
// taxa. Em 22/10 foram 25 cortes em um dia: a sessao sobe, cai, sobe de
// novo - e nesse va e vem nada de leitura acontece. Isso NAO e cegueira de
// criptografia: e o WhatsApp barrando o numero. A cura e re-parear (ponte
// nova) E reduzir o ritmo de envio - por isso e um veredito separado.
// ============================================================

const LIMITE_428_MIN = 30;
const LIMITE_428_QUANTIDADE = 2;

function avaliarLimitacao({
  agoraMs = Date.now(),
  janelaMin = LIMITE_428_MIN,
  minimo = LIMITE_428_QUANTIDADE,
} = {}) {
  const e = carregar();
  const hist = Array.isArray(e.desconexoes) ? e.desconexoes : [];
  const janela = agoraMs - janelaMin * 60000;
  const cortes = hist.filter(
    (d) => d && String(d.motivo) === '428' && Date.parse(d.em) >= janela
  );
  return {
    limitado: cortes.length >= minimo,
    quantidade: cortes.length,
    ultimoEm: cortes.length ? cortes[cortes.length - 1].em : null,
  };
}

function marcarInbound() {
  const e = carregar();
  e.inbounds = (e.inbounds || 0) + 1;
  // Leu uma mensagem: a sessao decripta. A evidencia de cegueira volta a
  // valer do zero e a marca de cegueira (se houver) e curada.
  return atualizar({
    ultimoInboundEm: agora(),
    inbounds: e.inbounds,
    cegueiraRef: referenciaCegueira(e),
    cegueira: false,
    cegueiraConfirmada: false,
    cegueiraDesde: null,
    cegueiraEvidencia: null,
  });
}

function marcarEnvio() {
  const e = carregar();
  return atualizar({ ultimoEnvioEm: agora(), envios: (e.envios || 0) + 1 });
}

function contarFalhaDecrypt() {
  const e = carregar();
  e.falhasDecrypt = (e.falhasDecrypt || 0) + 1;
  gravarLogo();
  return e.falhasDecrypt;
}

// Embrulha console.error/console.warn: ruido conhecido do libsignal vira
// contador e nao aparece; qualquer outra coisa passa intacta.
function instalarFiltroDeRuido() {
  if (filtroInstalado) return;
  filtroInstalado = true;
  for (const metodo of ['error', 'warn']) {
    const original = console[metodo].bind(console);
    console[metodo] = (...args) => {
      const texto = args.map((a) => (typeof a === 'string' ? a : String(a && a.message) || '')).join(' ');
      if (RUIDO.some((r) => texto.includes(r))) {
        contarFalhaDecrypt();
        return;
      }
      original(...args);
    };
  }
}

function ler() {
  return carregar();
}

module.exports = {
  ARQ,
  RUIDO,
  carregar,
  gravar,
  marcarBoot,
  marcarConexao,
  marcarDesconexao,
  marcarInbound,
  marcarEnvio,
  contarFalhaDecrypt,
  contarUpsert,
  contarUpsertSemTexto,
  contarDescarte,
  avaliarSurdez,
  avaliarSondagem,
  avaliarCegueira,
  avaliarCegueiraAtual,
  avaliarLimitacao,
  referenciaCegueira,
  registrarCegueira,
  marcarCegueiraCurada,
  curarSeRepareou,
  marcarSonda,
  registrarHeartbeat,
  LIMITE_SURDEZ_MIN,
  LIMITE_SONDAGEM_MIN,
  LIMITE_CEGUEIRA_MIN,
  LIMITE_428_MIN,
  LIMITE_428_QUANTIDADE,
  instalarFiltroDeRuido,
  ler,
};
