'use strict';

// ============================================================
// Campanha diaria de repique.
//
// O bot manda ate `config.repique.porDia` numeros novos por dia, num ritmo
// humano (segundos entre um e outro, ver bot.js). Duas coisas moram AQUI:
//
//   data/campanha.json   -> { dia: "YYYY-MM-DD", enviados: n }   (contador)
//   data/campanha.ligada -> existe = campanha ligada (pausa = ausente)
//
// O interruptor e um ARQUIVO de proposito: a equipe liga e desliga pelo
// painel (painel.js) e o bot le a cada volta, sem precisar reiniciar. Nada
// envia se o arquivo nao existir.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');
const atendimento = require('./atendimento');
const numeros = require('./numeros');
const escopo = require('./escopo.guard');
const store = require('./store');

function arquivoEstado() {
  return path.join(config.dataFolder, 'campanha.json');
}
function arquivoLigada() {
  return path.join(config.dataFolder, 'campanha.ligada');
}

function ligada() {
  return fs.existsSync(arquivoLigada());
}

function ligar() {
  fs.mkdirSync(config.dataFolder, { recursive: true });
  fs.writeFileSync(arquivoLigada(), new Date().toISOString(), 'utf8');
  return true;
}

function desligar() {
  try {
    fs.rmSync(arquivoLigada(), { force: true });
  } catch {
    // silencio-ok: se nao deu para remover, o arquivo fica e a campanha segue
    // ligada - o unico efeito e nao pausar, que e o lado seguro.
  }
  return false;
}

// Contador do dia, ja zerado se virou a data (fuso de config.fuso).
function ler() {
  let guardado = { dia: null, enviados: 0 };
  try {
    guardado = JSON.parse(fs.readFileSync(arquivoEstado(), 'utf8'));
  } catch {
    // silencio-ok: sem arquivo (primeiro dia) ou JSON corrompido: comeca do zero.
  }
  const hoje = atendimento.hojeISO();
  if (guardado.dia !== hoje) return { dia: hoje, enviados: 0 };
  return { dia: guardado.dia, enviados: Number(guardado.enviados) || 0 };
}

function registrarEnvio() {
  const e = ler();
  const novo = { dia: e.dia, enviados: e.enviados + 1, atualizadoEm: new Date().toISOString() };
  fs.writeFileSync(arquivoEstado(), JSON.stringify(novo), 'utf8');
  return novo;
}

function restantesHoje() {
  return Math.max(0, config.repique.porDia - ler().enviados);
}

// Primeiro numero da lista que ainda pode receber o repique.
function proximoPendente() {
  const { entradas } = numeros.carregar();
  for (const entrada of entradas) {
    const jid = `${entrada.numero}@s.whatsapp.net`;
    const contato = store.get(jid);
    const portaria = escopo.podeReceberRepique({ ...(contato || {}), jid });
    if (portaria.ok) return { ...entrada, jid };
  }
  return null;
}

function pendentes() {
  const { entradas } = numeros.carregar();
  let total = 0;
  for (const entrada of entradas) {
    const jid = `${entrada.numero}@s.whatsapp.net`;
    const contato = store.get(jid);
    if (escopo.podeReceberRepique({ ...(contato || {}), jid }).ok) total++;
  }
  return total;
}

// Resumo para o painel.
function resumo() {
  const e = ler();
  const janela = atendimento.emAtendimento();
  return {
    ligada: ligada(),
    dia: e.dia,
    enviadosHoje: e.enviados,
    porDia: config.repique.porDia,
    restantesHoje: restantesHoje(),
    pendentes: pendentes(),
    janelaAberta: janela.aberto,
    janela: janela.motivo,
  };
}

module.exports = {
  ligada,
  ligar,
  desligar,
  ler,
  registrarEnvio,
  restantesHoje,
  proximoPendente,
  pendentes,
  resumo,
};
