#!/usr/bin/env node
'use strict';

// ============================================================
// npm run pack - gera o .zip para distribuir.
//
// Whitelist, nunca blacklist: so entra o que esta em INCLUIR. Sessao do
// WhatsApp, lista de contatos, estado, backup, config pessoal e node_modules
// nao tem como entrar por esquecimento.
//
// Depois de zipar, o script LE o zip e falha se encontrar qualquer caminho
// proibido. E a ultima barreira entre um deslize e a sessao de um cliente
// indo para a internet.
// ============================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const SLUG = pkg.name || 'bot';
const VERSAO = pkg.version || '0.0.0';
const SAIDA = path.join(RAIZ, 'dist');

// Arquivos e pastas que compoem o programa.
const INCLUIR = [
  'atendimento.js',
  'avisar.js',
  'backup.js',
  'boot-check.js',
  'bot.js',
  'campanha.js',
  'classificador.js',
  'config.js',
  'config.local.example.js',
  'connect.js',
  'controle.js',
  'decisoes.js',
  'dedupe.guard.js',
  'desvincular.js',
  'enviar.js',
  'envio.guard.js',
  'escopo.guard.js',
  'estado.js',
  'falar.js',
  'imagens.js',
  'importar.js',
  'lifecycle.js',
  'log-cli.js',
  'mensagens-campanha.js',
  'mensagens.js',
  'nomes.js',
  'numeros.js',
  'painel.js',
  'pid.lock.js',
  'plataforma.js',
  'privacidade.js',
  'qr-live.js',
  'rajada.guard.js',
  'repicar.js',
  'respostas-cli.js',
  'restaurar.js',
  'saude.js',
  'simulate.js',
  'status.js',
  'store.js',
  'supressoes.js',
  'supervisor.js',
  'templates.js',
  'package.json',
  'README.md',
  'LEIA-ME.txt',
  'INSTALACAO.md',
  'LICENSE',
  '.gitignore',
  'tests',
  'scripts',
  'systemd',
  'INICIAR.bat',
  'INSTALAR.bat',
  'BACKUP.bat',
  'RESTAURAR.bat',
  'instalar.ps1',
  'ligar-bia.ps1',
  'desligar-bia.ps1',
  'painel.ps1',
  'watchdog.ps1',
  'iniciar.sh',
  'parar.sh',
  'numeros.exemplo.txt',
];

// Qualquer caminho que comece com um destes NAO pode estar no zip.
const PROIBIDOS = [/^auth/, /^data\//, /^backups\//, /^legado\//, /config\.local\.js$/, /^\.env/, /^node_modules\//, /^runtime\//, /\.zip$/];

const existentes = INCLUIR.filter((nome) => fs.existsSync(path.join(RAIZ, nome)));
const ausentes = INCLUIR.filter((nome) => !fs.existsSync(path.join(RAIZ, nome)));
if (ausentes.length > 0) {
  console.log(`(ignorados por nao existirem: ${ausentes.join(', ')})`);
}

fs.mkdirSync(SAIDA, { recursive: true });
for (const arquivo of fs.readdirSync(SAIDA)) {
  if (arquivo.startsWith(`${SLUG}-v`) && arquivo.endsWith('.zip')) fs.rmSync(path.join(SAIDA, arquivo));
}

const zip = path.join(SAIDA, `${SLUG}-v${VERSAO}.zip`);
execFileSync('zip', ['-r', '-X', '-q', zip, ...existentes], { cwd: RAIZ });

// Conferencia: le o conteudo real do zip.
const lista = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

const vazados = lista.filter((entrada) => PROIBIDOS.some((rx) => rx.test(entrada)));
if (vazados.length > 0) {
  fs.rmSync(zip, { force: true });
  console.error('\n\x1b[31mPACK ABORTADO:\x1b[0m o zip teria conteudo proibido:');
  for (const v of vazados.slice(0, 10)) console.error(`  - ${v}`);
  process.exit(1);
}

const tamanho = (fs.statSync(zip).size / 1024).toFixed(0);
console.log(`\x1b[32mPacote gerado:\x1b[0m ${path.relative(RAIZ, zip)} (${tamanho} KB, ${lista.length} arquivos)`);
console.log('Nada de auth/, data/, config.local.js ou node_modules entrou.');
