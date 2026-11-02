'use strict';

// ============================================================
// npm run check - o portao de qualidade e de seguranca do projeto.
//
// Roda em tres camadas:
//
//   1. TESTES    - node --test tests/*.test.js (privacidade, estado, textos);
//   2. HIGIENE   - o repositorio nao pode ter sessao, lista, backup, zip,
//                  telefone em claro nem nome de cliente;
//   3. ESTRUTURA - guards importados, config lida, arquivos obrigatorios.
//
// Sai com codigo 1 na primeira falha. AVISO nao derruba: e coisa para olhar.
// Este script NAO migra legado (BIA_MIGRAR=0): rodar o check nunca deve mexer
// nos dados de uma instalacao real.
// ============================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BIA_MIGRAR = '0';

const RAIZ = path.join(__dirname, '..');
const IGNORAR = new Set(['node_modules', 'runtime', 'data', 'backups', 'legado', '.git', 'auth']);

const falhas = [];
const avisos = [];

function ok(msg) {
  console.log(`  \x1b[32mOK\x1b[0m     ${msg}`);
}
function falha(msg) {
  falhas.push(msg);
  console.log(`  \x1b[31mFALHA\x1b[0m  ${msg}`);
}
function aviso(msg) {
  avisos.push(msg);
  console.log(`  \x1b[33mAVISO\x1b[0m  ${msg}`);
}

// Arquivos que entram no repositorio/pacote. Fora daqui: dependencias,
// runtime portatil, pastas de sessao e backup.
const EXT = /\.(js|json|md|txt|ps1|bat|sh|service|example)$/i;

function listar(dir, saida = []) {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(entrada.name)) continue;
    if (/^auth[-_]/.test(entrada.name)) continue;
    if (entrada.name === 'package-lock.json') continue;
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) listar(completo, saida);
    else if (EXT.test(entrada.name)) saida.push(completo);
  }
  return saida;
}

const arquivos = listar(RAIZ);

// ---------------- 1. Testes ----------------
console.log('\n== testes ==');
const arquivosTeste = fs
  .readdirSync(path.join(RAIZ, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join('tests', f));
try {
  const saida = execFileSync(process.execPath, ['--test', ...arquivosTeste], {
    cwd: RAIZ,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BIA_MIGRAR: '0' },
  });
  const passou = /# pass (\d+)/.exec(saida);
  const falhou = /# fail (\d+)/.exec(saida);
  if (Number(falhou ? falhou[1] : 0) > 0) falha(`testes: ${falhou[1]} falharam`);
  else ok(`${passou ? passou[1] : '?'} testes passaram`);
} catch (e) {
  const saida = `${e.stdout || ''}`;
  const falhou = /# fail (\d+)/.exec(saida);
  falha(`testes falharam${falhou ? ` (${falhou[1]})` : ''}`);
}

// ---------------- 2. Higiene ----------------
console.log('\n== dado pessoal ==');

const privacidade = require('../privacidade');
const achados = privacidade.varrerPII(arquivos);
if (achados.length === 0) {
  ok('nenhum telefone em claro no codigo');
} else {
  for (const a of achados.slice(0, 8)) {
    falha(`${path.relative(RAIZ, a.arquivo)}:${a.linha} tem ${a.tipo}`);
  }
  if (achados.length > 8) falha(`... e mais ${achados.length - 8} ocorrencia(s)`);
}

// Nome de cliente nao volta para o codigo. A lista e curta de proposito: sao
// os termos que ja estiveram aqui uma vez.
const TERMOS = [
  { termo: 'Allnet', rx: /allnet/i },
  // "Conecta" maiusculo e a marca; "conecta" minusculo e o verbo ("ela
  // conecta"), que aparece em comentario legitimo.
  { termo: 'Conecta', rx: /\bConecta\b/ },
  { termo: 'Katiucha', rx: /katiucha/i },
  { termo: 'Taboao', rx: /tabo[aã]o/i },
  { termo: 'Takeuti', rx: /takeuti/i },
];
const sujos = [];
for (const arquivo of arquivos) {
  const rel = path.relative(RAIZ, arquivo);
  // A lista de termos mora aqui; config/privacidade guardam o fallback
  // ALLNET_* (compatibilidade com instalacao antiga), que nao e vazamento.
  if (rel === 'tests/check.js' || rel === 'config.js' || rel === 'privacidade.js') continue;
  const texto = fs.readFileSync(arquivo, 'utf8');
  for (const { termo, rx } of TERMOS) {
    if (rx.test(texto)) sujos.push(`${rel} (${termo})`);
  }
}
if (sujos.length === 0) ok('nenhum nome de cliente no codigo');
else for (const s of sujos.slice(0, 8)) falha(`nome de cliente em ${s}`);

console.log('\n== sessao fora do projeto ==');
const dentroDoProjeto = fs
  .readdirSync(RAIZ)
  .filter((nome) => ['auth', 'data', 'backups', 'legado'].includes(nome) || /^auth[-_]/.test(nome));
if (dentroDoProjeto.length === 0) ok('auth/, data/ e backups/ nao estao no projeto');
else falha(`dado de execucao dentro do projeto: ${dentroDoProjeto.join(', ')} (rode o bot uma vez para migrar)`);

const zips = fs.readdirSync(RAIZ).filter((nome) => nome.endsWith('.zip'));
if (zips.length === 0) ok('nenhum .zip na raiz');
else aviso(`zip na raiz: ${zips.join(', ')} - use "npm run pack"`);

if (fs.existsSync(path.join(RAIZ, 'config.local.js'))) {
  ok('config.local.js presente (configuracao pessoal, fora do git)');
} else {
  aviso('sem config.local.js: rodando com a identidade generica');
}

if (fs.existsSync(path.join(RAIZ, 'runtime'))) {
  aviso('runtime/ presente (Node portatil do Windows, fora do git)');
}

// ---------------- 3. Estrutura ----------------
console.log('\n== config ==');
// Le os PADROES num filho, com pasta de dados temporaria: o config.local.js
// do dono nao pode fazer o check acusar identidade de cliente.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bia-check-'));
try {
  const saida = execFileSync(
    process.execPath,
    [
      '-e',
      'const c=require("./config");console.log(JSON.stringify({empresa:c.empresa,botNome:c.botNome,equipe:c.escopo.equipe,porDia:c.repique.porDia,endereco:c.endereco}))',
    ],
    {
      cwd: RAIZ,
      encoding: 'utf8',
      env: { ...process.env, BIA_HOME: tmp, BIA_MIGRAR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const padrao = JSON.parse(saida.trim());

  if (/allnet|conecta|katiucha/i.test(`${padrao.empresa} ${padrao.botNome}`)) {
    falha('padrao do config ainda cita cliente');
  } else {
    ok(`identidade padrao generica (${padrao.botNome} / ${padrao.empresa})`);
  }
  if (Array.isArray(padrao.equipe) && padrao.equipe.length === 0) ok('equipe vazia por padrao');
  else falha('config.js (padrao) nao pode ter numero de equipe');

  if (padrao.porDia > 50) falha(`repique.porDia padrao = ${padrao.porDia} (acima de 20 o risco e alto)`);
  else if (padrao.porDia > 20) aviso(`repique.porDia padrao = ${padrao.porDia} (recomendado: 20 para numero novo)`);
  else ok(`teto diario padrao = ${padrao.porDia}`);
} catch (e) {
  falha(`nao consegui ler o config: ${e.message}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n== guards ==');
const guards = fs
  .readdirSync(RAIZ)
  .filter((f) => f.endsWith('.guard.js'));
const codigo = arquivos.filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}tests${path.sep}`));
for (const guard of guards) {
  const modulo = guard.replace(/\.js$/, '');
  const usa = codigo.filter((f) => path.basename(f) !== guard && fs.readFileSync(f, 'utf8').includes(modulo));
  if (usa.length === 0) falha(`guard orfao: ${guard} nao e importado por ninguem`);
  else ok(`${guard} usado por ${usa.length} arquivo(s)`);
}

console.log('\n== arquivos obrigatorios ==');
const OBRIGATORIOS = [
  'README.md',
  'LICENSE',
  '.gitignore',
  'config.js',
  'config.local.example.js',
  'privacidade.js',
  'supressoes.js',
  'templates.js',
  'store.js',
];
for (const nome of OBRIGATORIOS) {
  if (fs.existsSync(path.join(RAIZ, nome))) ok(nome);
  else falha(`${nome} ausente`);
}

console.log('\n== scripts do package.json ==');
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
if (/allnet/i.test(`${pkg.name} ${pkg.description}`)) falha('package.json cita cliente');
else ok(`pacote generico (${pkg.name})`);

const ALVOS = {
  test: 'tests/privacidade.test.js',
  check: 'tests/check.js',
  simulate: 'simulate.js',
  pack: 'scripts/pack.js',
};
for (const [script, alvo] of Object.entries(ALVOS)) {
  if (!pkg.scripts || !pkg.scripts[script]) {
    falha(`script "${script}" ausente no package.json`);
    continue;
  }
  if (!fs.existsSync(path.join(RAIZ, alvo))) falha(`script "${script}" aponta para ${alvo}, que nao existe`);
  else ok(`npm run ${script}`);
}

// ---------------- Resumo ----------------
console.log('');
if (falhas.length > 0) {
  console.log(`\x1b[31m${falhas.length} falha(s).\x1b[0m Corrija antes de publicar.`);
  process.exit(1);
}
console.log(`\x1b[32mTudo certo.\x1b[0m ${avisos.length} aviso(s).`);
