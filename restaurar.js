'use strict';

// ============================================================
// Restauracao da Bia a partir de um backup.
//
//   node restaurar.js "<caminho do bia-backup-....zip>"
//
// Devolve auth/ + data/ + config.js para o lugar. A sessao volta junto, entao
// a Bia acorda conectada - sem reparear. O que existir e substituido vai para
// um .antes-restore-<ts> (nao apaga nada sem guardar).
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const plataforma = require('./plataforma');

const RAIZ = __dirname;
const zip = process.argv[2];

if (!zip) {
  console.error('Uso: node restaurar.js "<bia-backup-....zip>"');
  process.exit(1);
}
if (!fs.existsSync(zip)) {
  console.error(`Arquivo nao encontrado: ${zip}`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atende-restore-'));

try {
  // Windows: Expand-Archive. Linux/macOS: unzip. A escolha esta em plataforma.js.
  plataforma.deszipar(zip, tmp);

  for (const nome of ['auth', 'data', 'config.js']) {
    const src = path.join(tmp, nome);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(RAIZ, nome);
    if (fs.existsSync(dst)) fs.renameSync(dst, `${dst}.antes-restore-${Date.now()}`);
    fs.cpSync(src, dst, { recursive: true });
    console.log(`Restaurado: ${nome}`);
  }

  console.log('\nPronto. Agora: npm install (se for maquina nova) e npm run bot.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
