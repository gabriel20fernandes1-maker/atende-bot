'use strict';

// ============================================================
// Trava de instancia unica.
//
// Dois `npm run bot` ao mesmo tempo = cada mensagem respondida duas vezes.
// Nao havia nada impedindo: cada processo tinha o proprio socket e o proprio
// setInterval, e ambos respondiam.
//
// A trava e um arquivo com o PID. Se o PID do arquivo estiver VIVO, o novo
// processo recusa. Se o arquivo existir mas o processo NAO existir (crash,
// reboot, kill -9), o arquivo e orfao: tem de ser limpo e o bot sobe. Sem
// isso, um unico travamento deixa o bot apagado para sempre e ninguem
// descobre o motivo.
//
// O caminho e resolvido a CADA chamada, a partir de `config.dataFolder`, e
// nao capturado no load. Motivo: o teste 'com o proprio bot rodando' precisa
// apontar para uma pasta temporaria, senao colide com a Bia de producao e
// falha sempre que ela esta de pe - foi o que aconteceu em 29/09.
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

// ============================================================
// Boot ID: o Windows REUSA PID.
//
// Ate 20/10 a trava era so o PID. Apos um ciclo de energia, o PID antigo
// (10024) podia pertencer a outro processo: a trava parecia "viva" e a Bia
// se recusava a subir - exatamente no dia seguinte ao corte de energia, que e
// quando ela PRECISA subir. Por isso a trava carrega tambem o instante do
// boot: se o boot mudou, o PID gravado e de outro dia e nao bloqueia nada.
//
// O instante do boot vem de `Date.now() - os.uptime()`. Ele e FIXO durante o
// boot (nao e um relogio que anda), mas tem jitter de alguns ms entre
// chamadas - por isso a comparacao tem tolerancia de 60 s. Dois boots com
// menos de 60 s de intervalo nao existem na pratica.
const TOLERANCIA_BOOT_MS = 60000;
let bootCache = null;

function bootId() {
  if (bootCache === null) {
    bootCache = Math.round(Date.now() - os.uptime() * 1000);
  }
  return bootCache;
}

function mesmoBoot(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return true; // sem informacao: nao bloqueia
  return Math.abs(a - b) <= TOLERANCIA_BOOT_MS;
}

function arquivo() {
  return path.join(config.dataFolder, 'bot.pid');
}

// Le a trava. Aceita os dois formatos:
//   - JSON { pid, boot }  (formato atual)
//   - numero puro        (formato antigo, de antes do boot ID)
function lerTrava() {
  let bruto;
  try {
    bruto = fs.readFileSync(arquivo(), 'utf8').trim();
  } catch {
    // silencio-ok: sem arquivo de trava nao ha PID; o chamador trata null como
    // "pode subir".
    return null;
  }
  if (bruto.startsWith('{')) {
    try {
      const o = JSON.parse(bruto);
      const pid = Number(o.pid);
      return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, boot: o.boot ?? null };
    } catch {
      // silencio-ok: trava corrompida e tratada como "sem trava" - o bot
      // escreve a dele em cima e sobe. Trava quebrada nao pode derrubar a Bia.
      return null;
    }
  }
  const pid = Number(bruto);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, boot: null };
}

function existe() {
  const t = lerTrava();
  if (!t || !t.pid) return false;
  // Trava de outro boot: o PID e de outro dia (ou foi reusado). O processo
  // que ela protege nao existe mais.
  if (!mesmoBoot(t.boot, bootId())) return false;
  try {
    process.kill(t.pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe mas e de outro usuario. Existe.
    return e.code === 'EPERM';
  }
}

function ler() {
  const t = lerTrava();
  return t ? t.pid : null;
}

// Tenta tomar a trava.
//   { ok: true,  orfao: pid|null } -> pode subir
//   { ok: false, pid: number }     -> ja tem bot rodando
function adquirir() {
  const arq = arquivo();
  fs.mkdirSync(config.dataFolder, { recursive: true });
  let orfao = null;

  if (fs.existsSync(arq)) {
    const t = lerTrava();
    if (t && t.pid) {
      if (existe()) return { ok: false, pid: t.pid };
      // Arquivo orfao: o processo nao existe mais (crash/reboot/kill -9) ou a
      // trava e de outro boot.
      orfao = t.pid;
    }
    try {
      fs.rmSync(arq, { force: true });
    } catch {
      // silencio-ok: o writeFileSync logo abaixo sobrescreve o arquivo de
      // qualquer forma. Se a remocao falhou por permissao, a escrita tambem
      // falha e o erro aparece no boot, com contexto.
    }
  }

  fs.writeFileSync(
    arq,
    JSON.stringify({ pid: process.pid, boot: bootId(), em: new Date().toISOString() }),
    'utf8'
  );
  return { ok: true, orfao };
}

// Solta a trava, mas so se ela ainda for nossa.
function liberar() {
  try {
    const t = lerTrava();
    if (t && t.pid === process.pid) fs.rmSync(arquivo(), { force: true });
  } catch {
    // silencio-ok: se nao der para remover, a trava fica e e tratada como orfa
    // no proximo boot (PID morto -> limpa e sobe). Nao ha o que reportar aqui.
  }
}

module.exports = { adquirir, liberar, existe, ler, arquivo, bootId };

// Compatibilidade: quem lia `pidLock.ARQUIVO` continua lendo o caminho atual.
Object.defineProperty(module.exports, 'ARQUIVO', { get: arquivo, enumerable: true });
