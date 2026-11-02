'use strict';

// ============================================================
// Log de decisao: uma linha por mensagem, dizendo o que a Bia decidiu.
//
// O bot.log diz o que ACONTECEU ("Nota na rajada", "Resposta enviada"), mas
// nao da para contar. Este arquivo responde sem abrir codigo: quantas
// recebidas, quantas respondidas, quantas bloqueadas e por qual guarda, quebra
// por intent. `npm run log:today` le daqui.
//
// Formato JSONL: uma linha = um JSON. Append-only, nunca reescreve. Cada linha
// tem `dia` (YYYY-MM-DD no fuso configurado), entao "hoje" e comparacao de
// string.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');
const atendimento = require('./atendimento');

function arquivo() {
  return path.join(config.dataFolder, 'decisoes.jsonl');
}

// Registra e devolve a linha (com `em` e `dia`), para quem quiser encadear.
function registrar(linha) {
  const registro = { em: new Date().toISOString(), dia: atendimento.hojeISO(), ...linha };
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.appendFileSync(arquivo(), JSON.stringify(registro) + '\n', 'utf8');
  } catch (e) {
    console.error(`[decisoes] falha ao gravar: ${e.message}`);
  }
  return registro;
}

function ler() {
  let cru;
  try {
    cru = fs.readFileSync(arquivo(), 'utf8');
  } catch {
    // silencio-ok: sem arquivo ainda, nao ha decisao nenhuma para ler.
    return [];
  }
  const linhas = [];
  for (const l of cru.split('\n')) {
    if (!l.trim()) continue;
    try {
      linhas.push(JSON.parse(l));
    } catch {
      // silencio-ok: linha truncada (processo morreu no meio da escrita) e
      // ignorada; o resto do arquivo continua valendo.
    }
  }
  return linhas;
}

function deHoje(base = new Date()) {
  const dia = atendimento.hojeISO(base);
  return ler().filter((l) => l.dia === dia);
}

module.exports = { registrar, ler, deHoje, arquivo };
