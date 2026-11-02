'use strict';

// ============================================================
// Privacidade: onde os dados moram e o que sobrevive a sessao.
//
// Regra do projeto:
//
//   1. NADA de dado do cliente dentro da pasta do codigo. Sessao do WhatsApp,
//      lista de contatos, estado e backups vivem na pasta de dados do usuario
//      (LOCALAPPDATA no Windows, ~/.local/share no Linux). O repositorio e o
//      .zip ficam limpos por construcao - nao por disciplina de quem empacota.
//
//   2. Nome e telefone sao dado de SESSAO. A lista importada, o feed de
//      mensagens e os logs sao apagados quando a sessao termina (ou quando
//      ficam velhos). O que precisa sobreviver - quem pediu para sair - fica
//      em `suprimidos.txt` como HASH, nunca como numero.
//
//   3. O estado.json nao guarda telefone em claro: as chaves sao hashes
//      (ver store.js). Sem o `sal`, o arquivo nao volta a virar numero.
//
// Consequencia assumida: quem apagar o `sal` perde a memoria de supressao.
// Por isso o sal fica na pasta de dados, junto do estado, e o backup leva os
// dois. Nao e segredo criptografico - e para o arquivo nao ser um cadastro.
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Pasta de dados do usuario. `BIA_HOME` (ou `ALLNET_HOME`, legado) manda;
// sem ela, segue o padrao de cada sistema.
function pastaPadrao() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
    return path.join(base, 'bia-bot');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'bia-bot');
}

function env(nome, legado) {
  if (process.env[nome] != null && process.env[nome] !== '') return process.env[nome];
  if (legado && process.env[legado] != null && process.env[legado] !== '') return process.env[legado];
  return null;
}

const HOME_DIR = env('BIA_HOME', 'ALLNET_HOME') || pastaPadrao();

// Arquivos que contem dado pessoal e morrem com a sessao. Tudo o que a Bia
// precisa para OPERAR (estado hasheado, contador da campanha) fica de fora.
const ARQUIVOS_DE_SESSAO = [
  'numeros.txt',
  'mensagens.json',
  'mensagens.json.tmp',
  'bot.log',
  'connect.log',
  'decisoes.jsonl',
  'dedupe.json',
  'envios.json',
  'health.json',
  'qr.png',
  'pair_code.txt',
  'numero-pareamento.txt',
  'connected.txt',
  'precisa-religar',
  'pareamento-ok',
  'ultimo-erro-boot.json',
];

const MAX_IDADE_SESSAO_H = 24;

function garantirPasta() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  return HOME_DIR;
}

// ---------------- Sal ----------------
//
// 32 bytes aleatorios, gravados uma vez. Sem ele, hash nao e reversivel e o
// estado perde a utilidade - por isso ele nasce junto com a pasta de dados.
let _sal = null;
function sal() {
  if (_sal) return _sal;
  const arquivo = path.join(garantirPasta(), 'sal');
  try {
    _sal = fs.readFileSync(arquivo, 'utf8').trim();
    if (_sal) return _sal;
  } catch {
    // silencio-ok: primeira execucao, o sal ainda nao existe.
  }
  _sal = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(arquivo, _sal + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    console.error(`[privacidade] nao consegui gravar o sal em ${arquivo}: ${e.message}`);
  }
  return _sal;
}

function soDigitos(texto) {
  return String(texto == null ? '' : texto).replace(/\D/g, '');
}

// Hash estavel de um numero. Usado como chave do estado e da lista de
// supressao: dois lugares onde o numero em claro nao pode aparecer.
function hash(numero) {
  const d = soDigitos(numero);
  if (!d) return null;
  return crypto.createHash('sha256').update(`${sal()}:${d}`).digest('hex').slice(0, 24);
}

function ehHash(chave) {
  return typeof chave === 'string' && /^[0-9a-f]{24}$/.test(chave);
}

// ---------------- Sessao ----------------

function arquivo(nome) {
  return path.join(HOME_DIR, 'data', nome);
}

function existeSessao() {
  try {
    return fs.existsSync(arquivo('numeros.txt'));
  } catch {
    return false;
  }
}

// Marca de atividade da sessao.
//
// Nao da para usar o mtime de numeros.txt: a lista so muda quando alguem
// importa, entao um bot rodando ha tres dias pareceria "parado ha tres dias" e
// o boot apagaria a lista em uso. A marca e tocada por quem esta vivo (o log
// do bot, com throttle), e so envelhece quando NINGUEM esta rodando.
const ARQUIVO_MARCA = 'sessao.marca';
let _ultimoToque = 0;

function marcarAtividade(forcar = false) {
  const agora = Date.now();
  if (!forcar && agora - _ultimoToque < 60000) return false;
  _ultimoToque = agora;
  try {
    fs.mkdirSync(path.join(HOME_DIR, 'data'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, 'data', ARQUIVO_MARCA), new Date(agora).toISOString(), 'utf8');
    return true;
  } catch {
    // silencio-ok: sem marca, o boot trata como "primeira sessao" e nao apaga.
    return false;
  }
}

function idadeSessaoHoras() {
  const marca = arquivo(ARQUIVO_MARCA);
  try {
    const info = fs.statSync(marca);
    return (Date.now() - info.mtimeMs) / 36e5;
  } catch {
    return 0; // sem marca = sessao que nunca rodou aqui; nao e "velha".
  }
}

// Apaga o que e dado pessoal e devolve a lista do que saiu. Roda no "Desligar"
// e no boot quando a sessao anterior ficou velha. Nunca toca em estado.json
// (hasheado) nem no contador da campanha.
function limparSessao() {
  const apagados = [];
  const pasta = path.join(HOME_DIR, 'data');
  let arquivos = [];
  try {
    arquivos = fs.readdirSync(pasta);
  } catch {
    return apagados;
  }

  for (const nome of arquivos) {
    const deSessao = ARQUIVOS_DE_SESSAO.includes(nome) || /^bot-.*\.(out|err)$/.test(nome);
    if (!deSessao) continue;
    try {
      fs.rmSync(path.join(pasta, nome), { force: true });
      apagados.push(nome);
    } catch (e) {
      console.error(`[privacidade] nao consegui apagar ${nome}: ${e.message}`);
    }
  }
  return apagados;
}

// Boot: se a sessao anterior ficou velha (o operador esqueceu o painel aberto
// ou o PC ficou desligado), o dado pessoal dela vai embora antes de comecar.
// 0 desliga a checagem (fica so a limpeza no "Desligar").
function limparSessaoAntiga(maxHoras = MAX_IDADE_SESSAO_H) {
  if (!(maxHoras > 0)) return [];
  if (!existeSessao()) return [];
  if (idadeSessaoHoras() < maxHoras) return [];
  return limparSessao();
}

// ---------------- Legado ----------------
//
// Versoes anteriores gravavam auth/, data/ e backups/ DENTRO do projeto. Isso
// deixava a sessao do WhatsApp no meio do codigo (e no zip). Aqui os tres sao
// movidos para a pasta de dados na primeira execucao. Idempotente: se o
// destino ja existe, nao mexe.
const LEGADO = [
  ['auth', 'auth'],
  ['data', 'data'],
  ['backups', 'backups'],
];

function mover(de, para) {
  try {
    if (!fs.existsSync(de)) return false;
    if (fs.existsSync(para)) return false;
    fs.mkdirSync(path.dirname(para), { recursive: true });
    fs.renameSync(de, para);
    return true;
  } catch (e) {
    console.error(`[privacidade] nao consegui mover ${de} para ${para}: ${e.message}`);
    return false;
  }
}

function migrarLegado(raiz) {
  const movidos = [];
  for (const [de, para] of LEGADO) {
    if (mover(path.join(raiz, de), path.join(HOME_DIR, para))) movidos.push(`${de}/`);
  }

  // Pastas de sessao antiga que o proprio bot criava ao trocar de numero.
  let entradas = [];
  try {
    entradas = fs.readdirSync(raiz);
  } catch {
    return movidos;
  }
  for (const nome of entradas) {
    if (!/^auth[-_](antes|falha|invalid|desvinculado)/.test(nome)) continue;
    if (mover(path.join(raiz, nome), path.join(HOME_DIR, 'legado', nome))) movidos.push(`${nome}/`);
  }
  return movidos;
}

// ---------------- Deteccao (usada pelo npm run check) ----------------
//
// Procura telefone brasileiro em claro nos arquivos versionados. E a rede que
// impede o dado de voltar por descuido.
//
// Numero de exemplo (`(11) 90000-0000`, `5511900000000`) nao conta: o filtro
// descarta quem tem sequencia de 4+ zeros ou digito repetido. Falso negativo
// raro vale mais que um check que grita em todo exemplo de documentacao.
const PADROES_PII = [
  { nome: 'telefone E.164', rx: /(?<!\d)55\d{10,11}(?!\d)/g },
  { nome: 'telefone formatado', rx: /\(\d{2}\)\s?9?\d{4}[-\s]?\d{4}/g },
];

function pareceExemplo(digitos) {
  return /0{4,}/.test(digitos) || /(\d)\1{6,}/.test(digitos);
}

function varrerPII(arquivos) {
  const achados = [];
  for (const arquivo of arquivos) {
    let texto;
    try {
      texto = fs.readFileSync(arquivo, 'utf8');
    } catch {
      continue;
    }
    texto.split(/\r?\n/).forEach((linha, i) => {
      for (const { nome, rx } of PADROES_PII) {
        for (const achado of linha.matchAll(rx)) {
          const digitos = achado[0].replace(/\D/g, '');
          if (pareceExemplo(digitos)) continue;
          achados.push({ arquivo, linha: i + 1, tipo: nome });
        }
      }
    });
  }
  return achados;
}

module.exports = {
  HOME_DIR,
  ARQUIVOS_DE_SESSAO,
  MAX_IDADE_SESSAO_H,
  garantirPasta,
  sal,
  hash,
  ehHash,
  soDigitos,
  arquivo,
  existeSessao,
  marcarAtividade,
  idadeSessaoHoras,
  limparSessao,
  limparSessaoAntiga,
  migrarLegado,
  varrerPII,
};

// ---------------- CLI ----------------
//
//   node privacidade.js --status   onde os dados moram e qual a idade da sessao
//   node privacidade.js --limpar   apaga lista, feed e logs (se config permitir)
//
// O "Desligar Bia" do Windows e o `controle.js descer` chamam `--limpar`.
if (require.main === module) {
  const arg = (process.argv[2] || '').trim();

  if (arg === '--status') {
    const lista = arquivo('numeros.txt');
    const temLista = fs.existsSync(lista);
    console.log(`pasta de dados : ${HOME_DIR}`);
    console.log(`sessao do zap  : ${path.join(HOME_DIR, 'auth')}`);
    console.log(`lista de envio : ${temLista ? lista : '(vazia)'}`);
    console.log(`idade da sessao: ${Number.isFinite(idadeSessaoHoras()) ? idadeSessaoHoras().toFixed(1) + 'h' : '-'}`);
    process.exit(0);
  }

  if (arg === '--limpar') {
    // Require tardio: config.js importa este modulo, entao exigir no topo
    // fecharia o ciclo.
    const config = require('./config');
    if (!config.privacidade || !config.privacidade.limparAoEncerrar) {
      console.log('Limpeza ao encerrar desligada em config.privacidade.limparAoEncerrar.');
      process.exit(0);
    }
    const apagados = limparSessao();
    console.log(apagados.length ? `Sessao apagada: ${apagados.join(', ')}` : 'Nada de sessao para apagar.');
    process.exit(0);
  }

  console.log('Uso: node privacidade.js --limpar | --status');
  process.exit(1);
}
