'use strict';

// ============================================================
// Idempotencia de envio: a mesma pessoa nao recebe o mesmo texto 2x.
//
// Sintoma: "a mesma mensagem chegou 2x para a mesma pessoa". Um disparo
// repetido do repique, dois processos bot, e o envio lido por varios antes de
// qualquer um gravar - a impressao digital por jid + hash e o que fecha isso.
//
// A garantia e por impressao digital: jid + hash do texto, numa janela de
// 10 minutos.
//
// ------------------------------------------------------------
// BYPASS - e aqui esta o ponto que o usuario levantou:
//
//   A regra e para envio ESPONTANEO (repique, aviso interno). Nao e para o que
//   a PESSOA pediu. Se a Bia reenviasse uma string identica a pedido, a
//   idempotencia bloquearia a resposta que a pessoa acabou de pedir.
//
//   Por isso o motivo e explicito no call site, e nao inferido:
//
//     espontaneo -> passa pela impressao digital. Protege contra corrida.
//     solicitado -> passa direto. E a resposta a uma mensagem da pessoa.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ARQUIVO = path.join(config.dataFolder, 'envios.json');
const JANELA_MS = 10 * 60 * 1000; // 10 minutos
const MAX = 2000;

// Envelope de bypass. Texto exato: quem chama decide o que e espontaneo.
const MOTIVOS = ['espontaneo', 'solicitado'];
const BYPASS = new Set(['solicitado']);

let cache = null;

function carregar() {
  if (cache) return cache;
  let cru = null;
  try {
    cru = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch {
    // silencio-ok: arquivo ausente ou corrompido cai no estado vazio; a
    // idempotencia degradada nao pode derrubar o envio.
    cru = null;
  }
  cache = cru && typeof cru === 'object' && cru.marcos && typeof cru.marcos === 'object' ? cru : { marcos: {} };
  return cache;
}

function salvar() {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(cache), 'utf8');
  } catch {
    // silencio-ok: perder a marca degrada a idempotencia, mas nao pode
    // derrubar o envio. A janela de 10 min segue valendo em memoria.
  }
}

function impressao(jid, texto) {
  const d = String(jid || '').replace(/\D/g, '');
  const h = crypto.createHash('sha1').update(String(texto == null ? '' : texto), 'utf8').digest('hex').slice(0, 16);
  return `${d}:${h}`;
}

function limparVencidos(agora) {
  for (const [k, ts] of Object.entries(cache.marcos)) {
    if (typeof ts !== 'number' || agora - ts > JANELA_MS) delete cache.marcos[k];
  }
}

function podar() {
  const ks = Object.keys(cache.marcos);
  if (ks.length <= MAX) return;
  ks.sort((a, b) => cache.marcos[a] - cache.marcos[b]);
  for (const k of ks.slice(0, ks.length - MAX)) delete cache.marcos[k];
}

// Devolve { ok, motivo }.
//   ok=false, motivo='duplicado'         -> espontaneo, mesma impressao dentro da janela
//   ok=false, motivo='motivo_desconhecido'
//   ok=true,  motivo='solicitado'        -> bypass por pedido
//   ok=true,  motivo='enviado'           -> marcado
function registrarEnvio(jid, texto, { motivo = 'espontaneo', agora = Date.now() } = {}) {
  if (!MOTIVOS.includes(motivo)) {
    return { ok: false, motivo: 'motivo_desconhecido' };
  }

  if (BYPASS.has(motivo)) {
    return { ok: true, motivo: 'solicitado' };
  }

  const marca = impressao(jid, texto);
  const d = carregar();
  limparVencidos(agora);

  if (d.marcos[marca]) {
    return { ok: false, motivo: 'duplicado' };
  }

  d.marcos[marca] = agora;
  podar();
  salvar();
  return { ok: true, motivo: 'enviado' };
}

// So para teste.
function limpar() {
  cache = { marcos: {} };
  try {
    fs.rmSync(ARQUIVO, { force: true });
  } catch {
    // silencio-ok: cache em memoria ja limpo; o arquivo e reescrito na proxima marca.
  }
}

// Consulta a trava SEM gravar. Para o --dry-run: um teste de gate nao abre
// conexao, mas precisa poder dizer "isto seria barrado". Sem isto o dry-run
// mente justamente na verificacao que ele existe para provar.
function consultar(jid, texto, { motivo = 'espontaneo' } = {}) {
  if (!MOTIVOS.includes(motivo)) return { ok: false, motivo: 'motivo_desconhecido' };
  if (BYPASS.has(motivo)) return { ok: true, motivo: 'solicitado' };
  const marca = impressao(jid, texto);
  return carregar().marcos[marca] ? { ok: false, motivo: 'duplicado' } : { ok: true, motivo: 'enviado' };
}

// Desfaz a marca quando o envio falhou. Reserva -> tentativa -> rollback.
//
// Sem isto, uma queda de rede no meio do envio consome a janela de 10 minutos
// inteira: a retentativa e barrada como 'duplicado' mesmo tendo entregado
// zero mensagens, e a pessoa receberia o re-ask 10 minutos depois, ou nunca.
//
// So remove a marca que ESTA tentativa criou: um duplicado nunca chega aqui
// (e recusado em registrarEnvio, antes de qualquer envio), entao nao ha como
// esta funcao apagar o registro de um envio que deu certo.
function desfazer(jid, texto) {
  const marca = impressao(jid, texto);
  const d = carregar();
  if (!d.marcos[marca]) return false;
  delete d.marcos[marca];
  salvar();
  return true;
}

module.exports = { registrarEnvio, consultar, desfazer, impressao, limpar, MOTIVOS, BYPASS, JANELA_MS, ARQUIVO };
