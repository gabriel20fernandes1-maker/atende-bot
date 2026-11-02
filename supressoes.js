'use strict';

// ============================================================
// Memoria de supressao: quem pediu para sair nunca mais e contatado.
//
// E a UNICA coisa que sobrevive ao fim da sessao, e sobrevive como hash -
// nunca como numero. Sem isso, reiniciar o bot faria a Bia recontatar quem
// respondeu "nao quero" no dia anterior, que e o pior erro possivel aqui.
//
// O arquivo e uma lista de hashes (um por linha) em data/supridos.txt. O hash
// usa o mesmo sal do estado (privacidade.js): se o sal se perde, a memoria se
// perde junto - e por isso o backup leva os dois.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');
const privacidade = require('./privacidade');

let _cache = null; // { arquivo, mtimeMs, size, hashes: Set }

function arquivo() {
  return config.supridosArquivo;
}

function carregar() {
  const alvo = arquivo();
  let info = null;
  try {
    info = fs.statSync(alvo);
  } catch {
    // silencio-ok: primeira execucao, ninguem suprimido ainda.
    return new Set();
  }

  if (_cache && _cache.arquivo === alvo && _cache.mtimeMs === info.mtimeMs && _cache.size === info.size) {
    return _cache.hashes;
  }

  let hashes = new Set();
  try {
    const linhas = fs.readFileSync(alvo, 'utf8').split(/\r?\n/);
    hashes = new Set(linhas.map((l) => l.trim()).filter((l) => privacidade.ehHash(l)));
  } catch (e) {
    console.error(`[supressoes] nao consegui ler ${alvo}: ${e.message}`);
  }

  _cache = { arquivo: alvo, mtimeMs: info.mtimeMs, size: info.size, hashes };
  return hashes;
}

function salvar(hashes) {
  const alvo = arquivo();
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  const tmp = `${alvo}.tmp`;
  fs.writeFileSync(tmp, `${[...hashes].sort().join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, alvo);
  _cache = null; // proxima leitura relê
}

function adicionar(jid) {
  const h = privacidade.hash(jid);
  if (!h) return false;
  const hashes = carregar();
  if (hashes.has(h)) return false;
  hashes.add(h);
  salvar(hashes);
  return true;
}

function remover(jid) {
  const h = privacidade.hash(jid);
  if (!h) return false;
  const hashes = carregar();
  if (!hashes.has(h)) return false;
  hashes.delete(h);
  salvar(hashes);
  return true;
}

function tem(jid) {
  const h = privacidade.hash(jid);
  return h ? carregar().has(h) : false;
}

module.exports = { arquivo, carregar, adicionar, remover, tem };
