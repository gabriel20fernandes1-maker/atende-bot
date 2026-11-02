'use strict';

// ============================================================
// TODO ENVIO DA Bia PASSA POR AQUI.
//
// Este modulo existe porque o mesmo envio estava escrito em dois lugares.
// O bot.js tinha `enviarTexto`; o send.js refazia a mesma coisa na mao, e a
// reimplementacao esqueceu a trava de idempotencia. Consequencia medida: o
// data/envios.json nunca existiu - ou seja, aquele caminho nunca registrou
// marca nenhuma - e o `npm run send` podia mandar a mesma abertura duas vezes.
// E o defeito que o envio.guard.js foi criado para impedir.
//
// Dois call sites que precisam "lembrar" de chamar a guarda e a forma
// garantida de o mesmo bug voltar. Aqui tem UM caminho, e ele nao tem como
// ser pulado.
//
// ------------------------------------------------------------
// ORDEM: reserva -> tentativa -> commit ou rollback.
//
// A reserva (envio.registrarEnvio) vem ANTES do envio, senao dois disparos
// simultaneos leriao "ainda nao mandei" e os dois mandariam. Mas se o
// sendMessage lancar - socket caiu, rede caiu, sessao morta -, a reserva precisa
// ser DESFEITA: senao a janela de 10 minutos fica queimada num envio que
// ninguem recebeu, e a retentativa sai barrada como 'duplicado'. A pessoa
// receberia o re-ask 10 minutos depois, ou nunca.
//
// O erro RELANCA. Quem chamou decide o que fazer com a falha - o repicar.js,
// por exemplo, nao marca o numero como repicado quando o envio quebra.
// ============================================================

const config = require('./config');
const envio = require('./envio.guard');
const estado = require('./estado');
const store = require('./store');
const escopo = require('./escopo.guard');
const saude = require('./saude');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Um envio NUNCA pode pendurar para sempre.
//
// Em 29/09 a mae mandou "Vo trabalhar", a Bia classificou, e o `sendMessage`
// nunca resolveu: a fila serial ficou travada, o log parou em "Off-topic 1/2",
// e a Bia emudeceu para todo mundo - sem erro, sem timeout, sem nada. Um
// socket "conectado" que nao entrega e o pior estado possivel, porque parece
// saudavel. Aqui o envio tem prazo: estourou, vira excecao, cai no rollback e
// a fila anda.
function comTimeout(promessa, ms, nome) {
  let timer;
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error(`${nome} nao respondeu em ${ms}ms`)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

//   motivo: 'espontaneo' -> repique, aviso a equipe. Passa pela idempotencia:
//            mesma pessoa + mesmo texto em 10 min e recusado.
//   motivo: 'solicitado' -> resposta a um pedido da pessoa. Bypass, porque
//            bloquear aqui mataria a resposta que ela acabou de pedir.
//
// Devolve o resultado do Baileys, ou { barrado: true, motivo }.
async function enviarTexto(sock, jid, texto, { inScope = true, motivo = 'espontaneo', log = null, imagem = null } = {}) {
  const dizer = log || (() => {});

  const permitido = envio.registrarEnvio(jid, texto, { motivo });
  if (!permitido.ok) {
    dizer(`[${jid}] Envio barrado (${permitido.motivo}): "${String(texto).slice(0, 40)}"`);
    return { barrado: true, motivo: permitido.motivo };
  }

  try {
    dizer(`[${jid}] enviando: presence "digitando"...`);
    await comTimeout(sock.sendPresenceUpdate('composing', jid), 15000, 'sendPresenceUpdate');
    const espera = between(config.typingMin, config.typingMax);
    dizer(`[${jid}] presence ok; aguardando ${espera}s de "digitando"...`);
    await delay(espera * 1000);
    const comImagem = Boolean(imagem && imagem.buffer && imagem.buffer.length);
    dizer(`[${jid}] enviando: sendMessage${comImagem ? ` (imagem ${imagem.nome || '?'})` : ''}...`);
    const conteudo = comImagem
      ? { image: imagem.buffer, caption: texto, mimetype: imagem.mimetype || 'image/jpeg' }
      : { text: texto };
    const resultado = await comTimeout(sock.sendMessage(jid, conteudo), comImagem ? 60000 : 30000, 'sendMessage');
    dizer(`[${jid}] sendMessage ok (id ${resultado?.key?.id || 'sem id'})`);

    // O Baileys pode responder com outro JID (@lid). Aponta o vinculo para o
    // suprimido e a ultimaMensagem continuarem casando. Logar sempre: e assim
    // que se descobre se o alias casou ou se a resposta vai cair num contato
    // diferente do que a gente mandou.
    const devolvido = resultado?.key?.remoteJid;
    if (devolvido) {
      if (devolvido !== jid) {
        dizer(`[${jid}] Baileys devolveu outro JID: ${devolvido} (registrando alias)`);
      }
      try {
        store.registrarAlias(jid, devolvido);
      } catch (e) {
        dizer(`[${jid}] Falha ao registrar o alias ${devolvido}: ${e.message}`);
      }
    }

    // A equipe nao e lead. Registrar o envio dela no estado de contato a faz
    // parecer alguem que a Bia "pegou" - e foi assim que a equipe quase
    // virou alvo da campanha depois do estrago de 26/09. O canal operacional
    // nao passa pelo estado de venda.
    //
    // A regra mora AQUI, no unico caminho de envio, e nao no `tratarEquipe`:
    // num call site, o proximo comando novo esqueceria do `semEstado` e ela
    // voltaria a ser lead sem ninguem notar.
    if (!escopo.isEquipe(jid)) {
      estado.registrarEnvio(jid, texto, { inScope });
    }
    saude.marcarEnvio();
    return resultado;
  } catch (e) {
    // Rollback. O envio nao saiu: libera a janela para a retentativa.
    envio.desfazer(jid, texto);
    dizer(`[${jid}] Falha no envio (marca liberada para retentativa): ${e.message}`);
    throw e;
  }
}

// Faz a MESMA consulta de guarda sem enviar. Usado pelo --dry-run do send.js:
// um teste de gate nao pode abrir conexao, mas precisa poder dizer "isto seria
// barrado", senao o --dry-run mente justamente na verificacao que ele existe
// para provar.
function checarEnvio(jid, texto, { motivo = 'espontaneo' } = {}) {
  return envio.consultar(jid, texto, { motivo });
}

// ============================================================
// Sonda de visao (issue Baileys #2491).
//
// A UNICA prova de que a sessao ainda decripta: a Bia manda um token para o
// PROPRIO numero e o eco volta como messages.upsert. Se o eco volta, a sessao
// le. Se nao volta, a sessao esta quebrada.
//
// O que NAO prova: `onWhatsApp`. Aquele pergunta ao servidor se o numero
// EXISTE - nao tem nada a ver com decriptar. Ele sempre devolvia true, e
// como era o portao da sonda pesada, a pesada NUNCA rodou. A cegueira nao era
// detectada porque o teste era uma tautologia.
//
// O que prova o eco: o TOKEN. Sem token, "voltou alguma coisa" e indistinguivel
// de "voltou a MINHA mensagem" - o WhatsApp produz upsert de app-state a todo
// momento, e era esse o falso positivo que confirmava cegueira inexistente.
//
// Volume: a Bia conversando com ela mesma. Nenhum cliente e envolvido.
// ============================================================

const ECO_TIMEOUT_MS = 30000;

// Reentrancia: duas sondas ao mesmo tempo mandam duas mensagens e confundem
// a leitura. A segunda volta na hora, sem mandar nada.
let sondaEmCurso = false;

// Token unico por sonda. Nao e so marcador de texto: e a PROVA de que o
// upsert que voltou e o eco da nossa mensagem.
function novoTokenSonda() {
  return `sonda-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// O JID da propria Bia. Vem da SESSAO (sock.user.id), nao do config: quando a
// Bia troca de numero, o config fica velho e a sonda mandaria a mensagem para
// um estranho - o silencio dele confirmaria uma "cegueira" que nao existe.
// O config so e usado como ultimo recurso (testes e socket sem identidade).
function jidDaBia(sock = null) {
  const eu = sock && sock.user ? sock.user.id || sock.user.lid : null;
  if (eu && String(eu).includes('@')) {
    const [usuario, servidor] = String(eu).split('@');
    return `${usuario.split(':')[0]}@${servidor}`;
  }
  return `${String(config.numeroPareamento || '').replace(/\D/g, '')}@s.whatsapp.net`;
}

// Envia o token para o PROPRIO numero.
async function enviarSonda(sock, { log = null, token = null } = {}) {
  const dizer = log || (() => {});
  const jid = jidDaBia(sock);
  const marca = token || novoTokenSonda();
  dizer(`[sonda] enviando teste de visao para si mesma (${jid})...`);
  const resultado = await comTimeout(
    sock.sendMessage(jid, { text: `ping ${marca}` }),
    20000,
    'sendMessage(sonda)'
  );
  dizer(`[sonda] teste enviado (id ${resultado?.key?.id || 'sem id'}).`);
  return { token: marca, resultado };
}

// A sonda real: manda o token e espera o eco. O eco so volta se a sessao
// CONSEGUIU decriptar.
//
// Devolve { ok, motivo }: 'eco' (voltou), 'sem_eco' (nao voltou), 'envio_falhou'
// (nao conseguiu nem mandar) ou 'ja_sondando' (outra sonda em andamento).
async function testarVisao(sock, { log = null, timeoutMs = ECO_TIMEOUT_MS } = {}) {
  const dizer = log || (() => {});
  if (sondaEmCurso) {
    dizer('[sonda] ja existe uma sonda em andamento; esta foi dispensada.');
    return { ok: false, motivo: 'ja_sondando' };
  }
  sondaEmCurso = true;
  const token = novoTokenSonda();
  let eco = false;

  const aoReceber = (dados) => {
    if (eco) return;
    if (!dados || !Array.isArray(dados.messages)) return;
    // O token e unico e nao aparece em nenhum outro trafego: se ele esta no
    // upsert, o upsert e o eco da nossa mensagem. Serializar o upsert inteiro
    // evita depender do formato exato do texto (conversation, extendedText...).
    const veio = dados.messages.some((m) => {
      try {
        return JSON.stringify(m).includes(token);
      } catch (e) {
        dizer(`[sonda] nao deu para ler o upsert: ${e.message}`);
        return false;
      }
    });
    if (veio) eco = true;
  };

  try {
    if (sock && sock.ev && typeof sock.ev.on === 'function') {
      sock.ev.on('messages.upsert', aoReceber);
    }
    try {
      await enviarSonda(sock, { log: dizer, token });
    } catch (e) {
      dizer(`[sonda] falha ao enviar o teste: ${e.message}`);
      return { ok: false, motivo: 'envio_falhou', erro: e.message };
    }
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite && !eco) {
      await delay(500);
    }
    return { ok: eco, motivo: eco ? 'eco' : 'sem_eco', token };
  } finally {
    sondaEmCurso = false;
    if (sock && sock.ev && typeof sock.ev.off === 'function') {
      sock.ev.off('messages.upsert', aoReceber);
    }
  }
}

module.exports = { enviarTexto, checarEnvio, testarVisao, enviarSonda, jidDaBia };
