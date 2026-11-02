'use strict';

// ============================================================
// As mensagens que chegaram na Bia.
//
// O operador precisa dar uma olhada: quem escreveu, o que escreveu, e se a
// equipe (a equipe) ja foi avisada. O bot grava cada mensagem LIDA aqui e o
// painel mostra as ultimas.
//
// Por que um arquivo e nao o estado.json: o estado e por CONTATO (o que a
// Bia fez com a pessoa: repique, interesse, resposta). Aqui e por MENSAGEM
// (o que chegou agora). Misturar os dois faria o estado.json crescer sem
// limite e esconderia o que a Bia respondeu.
//
// O texto vem de ESTRANGOS (a lista tem 5 mil e um, e qualquer um pode
// escrever). Quem mostra isso no painel tem que escapar - ver o `esc()` do
// painel.js. Aqui o texto e guardado cru, como no WhatsApp.
//
// Ring buffer de 100: o que importa e o RECENTE. Mais que isso e lixo em
// disco (e um arquivo que o painel le a cada 5 s).
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');

const ARQ = path.join(config.dataFolder, 'mensagens.json');
const MAX = 100;

// Write atomico, como no store.js: um arquivo truncado no meio da escrita
// (o processo morreu) deixaria o painel sem feed nenhum.
function salvar(lista) {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    const tmp = `${ARQ}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lista), 'utf8');
    fs.renameSync(tmp, ARQ);
    return true;
  } catch {
    // silencio-ok: perder o historico de mensagens e ruim, derrubar o bot
    // por causa disso e pior.
    return false;
  }
}

function carregar() {
  try {
    const cru = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    return Array.isArray(cru) ? cru : [];
  } catch {
    // silencio-ok: arquivo ausente (primeiro boot) ou corrompido = vazio.
    return [];
  }
}

// Grava uma mensagem recebida. Devolve o id (para marcar "equipe avisada").
function registrar({ jid = null, nome = null, numero = null, texto = '', intent = null, deOnde = null } = {}) {
  const em = new Date().toISOString();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lista = carregar();
  lista.push({
    id,
    em,
    jid,
    nome: nome || null,
    numero: numero || String(jid || '').replace(/@.*/, '') || null,
    texto: String(texto || '').slice(0, 500),
    intent: intent || null,
    deOnde: deOnde || null,
    avisouEquipe: false,
  });
  while (lista.length > MAX) lista.shift();
  salvar(lista);
  return id;
}

// Marca a mensagem como "a equipe ja foi avisada". Sem id, marca a ultima
// mensagem da pessoa (o caso normal: a olhada acontece logo apos a leitura).
function marcarAvisada(id = null, jid = null) {
  const lista = carregar();
  let alvo = null;
  if (id) alvo = lista.find((m) => m && m.id === id);
  if (!alvo && jid) {
    for (let i = lista.length - 1; i >= 0; i--) {
      if (lista[i] && lista[i].jid === jid) {
        alvo = lista[i];
        break;
      }
    }
  }
  if (!alvo) return false;
  alvo.avisouEquipe = true;
  salvar(lista);
  return true;
}

// As ultimas mensagens, mais recentes primeiro.
function listar(limite = 20) {
  const lista = carregar();
  return lista.slice(-Math.max(1, limite)).reverse();
}

module.exports = { ARQ, MAX, registrar, marcarAvisada, listar };
