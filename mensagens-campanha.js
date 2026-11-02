'use strict';

// ============================================================
// A mensagem da campanha, editavel pelo painel.
//
// O texto padrao mora em templates.js (e o que o check protege). Quando o
// operador salva pelo painel, este modulo grava data/campanha-mensagens.json
// e passa a valer NA HORA, sem reiniciar o bot: a campanha le o arquivo a
// cada envio.
//
// Duas versoes, de proposito:
//   comNome  - usa o marcador {nome}, trocado pelo primeiro nome da lista;
//   semNome  - usada quando a lista nao trouxe nome (nunca "{nome}" vazio).
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');
const templates = require('./templates');

const LIMITE = 1000;

function arquivo() {
  return path.join(config.dataFolder, 'campanha-mensagens.json');
}

function lerCustom() {
  try {
    const j = JSON.parse(fs.readFileSync(arquivo(), 'utf8'));
    if (typeof j.comNome !== 'string' || typeof j.semNome !== 'string') return null;
    return { comNome: j.comNome, semNome: j.semNome };
  } catch {
    // silencio-ok: sem arquivo (padrao) ou JSON invalido (cai no padrao).
    return null;
  }
}

// O que o painel mostra: sempre um texto (personalizado ou padrao) + se ha
// personalizacao. Assim a tela nunca aparece vazia para quem nunca salvou.
function ler() {
  const custom = lerCustom();
  const padrao = templates.repiqueModelo();
  return {
    comNome: custom ? custom.comNome : padrao.comNome,
    semNome: custom ? custom.semNome : padrao.semNome,
    personalizado: Boolean(custom),
  };
}

function salvar({ comNome, semNome } = {}) {
  const a = String(comNome || '').trim();
  const b = String(semNome || '').trim();
  if (!a || !b) throw new Error('preencha as duas mensagens');
  if (a.length > LIMITE || b.length > LIMITE) {
    throw new Error('mensagem muito longa (máximo de ' + LIMITE + ' caracteres)');
  }
  if (!a.includes('{nome}')) {
    throw new Error('a mensagem "com nome" precisa ter o marcador {nome}');
  }
  fs.mkdirSync(config.dataFolder, { recursive: true });
  fs.writeFileSync(arquivo(), JSON.stringify({ comNome: a, semNome: b, atualizadoEm: new Date().toISOString() }, null, 2), 'utf8');
  return { ok: true, ...ler() };
}

function restaurar() {
  try {
    fs.rmSync(arquivo(), { force: true });
  } catch {
    // silencio-ok: sem arquivo ja e o estado padrao.
  }
  return { ok: true, ...ler() };
}

// Usado pela campanha. Devolve null quando nao ha personalizacao: quem chama
// cai no templates.repique() (texto padrao, coberto pelo check).
function para(nome) {
  const custom = lerCustom();
  if (!custom) return null;
  const curto = templates.primeiroNome(nome);
  return curto ? custom.comNome.split('{nome}').join(curto) : custom.semNome;
}

module.exports = { ler, salvar, restaurar, para, LIMITE };
