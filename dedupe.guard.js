'use strict';

// ============================================================
// Dedupe de entrada: cada mensagem do Baileys e tratada UMA vez.
//
// Sintoma reportado em 26/09: a mesma mensagem chegou 2x para a mesma pessoa.
//
// Causa: `messages.upsert` nao guardava o `m.key.id`. O Baileys reentrega
// mensagens antigas quando reconecta (o log mostra 4 reconexoes em 26/09
// sozinho), e cada reentrega era tratada como mensagem nova -> resposta nova.
//
// Persistido em disco de proposito: se fosse so em memoria, qualquer
// reinicio faria a Bia re-responder o backlog inteiro.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');

const ARQUIVO = path.join(config.dataFolder, 'dedupe.json');
const TTL_MS = 6 * 60 * 60 * 1000; // 6h: folga para qualquer reconexao
const MAX = 5000; // teto de memoria/disco

let cache = null;

function carregar() {
  if (cache) return cache;
  let cru = null;
  try {
    cru = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch {
    // silencio-ok: arquivo ausente ou corrompido cai no estado vazio; dedupe
    // degradado nao pode derrubar o bot.
    cru = null;
  }
  cache = cru && typeof cru === 'object' && cru.vistos && typeof cru.vistos === 'object' ? cru : { vistos: {} };
  return cache;
}

function salvar() {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(cache), 'utf8');
  } catch {
    // silencio-ok: dedupe degradado nao pode derrubar o bot. A janela de 10 min
    // do envio.guard.js continua segurando a duplicacao.
  }
}

function limparVencidos(agora) {
  const vistos = cache.vistos;
  for (const [id, ts] of Object.entries(vistos)) {
    if (typeof ts !== 'number' || agora - ts > TTL_MS) delete vistos[id];
  }
}

function podar(agora) {
  const ids = Object.keys(cache.vistos);
  if (ids.length <= MAX) return;
  ids.sort((a, b) => cache.vistos[a] - cache.vistos[b]);
  for (const id of ids.slice(0, ids.length - MAX)) delete cache.vistos[id];
}

// Registra a mensagem. Devolve:
//   true  -> nunca vista antes, pode tratar
//   false -> ja foi tratada, DESCARTAR
//
// `id` ausente (mensagem sem m.key.id, que nao deveria acontecer) passa: o
// envio.guard.js ainda segura o dup, e negar aqui derrubaria mensagens
// legitimas.
function registrar(id, { agora = Date.now(), ttlMs = TTL_MS } = {}) {
  if (!id) return true;
  const d = carregar();
  limparVencidos(agora);
  if (d.vistos[id]) return false;
  d.vistos[id] = agora;
  if (ttlMs !== TTL_MS) {
    // so para teste
    for (const [k, ts] of Object.entries(d.vistos)) {
      if (k !== id && agora - ts > ttlMs) delete d.vistos[k];
    }
  }
  podar(agora);
  salvar();
  return true;
}

function jaVista(id, { agora = Date.now() } = {}) {
  if (!id) return false;
  const ts = carregar().vistos[id];
  return typeof ts === 'number' && agora - ts <= TTL_MS;
}

function tamanho() {
  return Object.keys(carregar().vistos).length;
}

// So para teste.
function limpar() {
  cache = { vistos: {} };
  try {
    fs.rmSync(ARQUIVO, { force: true });
  } catch {
    // silencio-ok: o cache em memoria ja foi zerado acima; o arquivo e reescrito
    // na proxima gravacao. Nao ha estado inconsistente a reportar.
  }
}

module.exports = { registrar, jaVista, tamanho, limpar, TTL_MS, MAX, ARQUIVO };
