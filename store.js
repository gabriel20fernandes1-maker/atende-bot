'use strict';

// ============================================================
// Persistencia do estado de contato.
//
// Dois problemas que este arquivo resolve:
//
// 1) Write atomico. O writeFileSync direto deixava o estado.json truncado
//    se o processo morresse no meio da escrita (acontece: o connect.log
//    mostra varios "restart required" do Baileys). Com o arquivo corrompido,
//    o catch do JSON.parse devolvia { contatos: {} } e a Bia ESQUECIA todos
//    os opt-outs - voltava a escrever para quem ja tinha pedido SAIR.
//    Aqui escrevemos num .tmp, dá fsync e faz rename (rename e atomico no
//    mesmo volume no Windows e no POSIX).
//
// 2) Identidade canonica. O send.js envia para <numero>@s.whatsapp.net e a
//    resposta chega como <id>@lid. Sao chaves diferentes, entao "suprimido"
//    e "ultimaMensagem" nao casavam. Aponhamos os dois para a mesma chave.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');
const privacidade = require('./privacidade');

const ESTADO_VAZIO = { contatos: {}, aliases: {} };

// Chave do contato no estado: hash do numero, nunca o numero.
//
// O estado guarda HISTORICO (repique enviado, opt-out, quantas respostas),
// e esse historico precisa sobreviver ao restart - senao a Bia recontata quem
// pediu para sair. O que nao precisa sobreviver e o telefone em si: o arquivo
// so precisa reconhecer o numero de novo, e hash resolve isso sem ser um
// cadastro. O `sal` fica na pasta de dados (privacidade.js).
function chaveDe(jid) {
  const d = digitos(jid);
  return d ? privacidade.hash(d) : null;
}

// Estado gravado por versao antiga tem JID como chave ("5511...@s.whatsapp.net").
// Converte na leitura, uma vez, sem perder historico nem opt-out.
function migrarChaves(estado) {
  let mudou = false;

  const contatos = {};
  for (const [chave, dados] of Object.entries(estado.contatos)) {
    const k = privacidade.ehHash(chave) ? chave : chaveDe(chave);
    if (!k) {
      mudou = true;
      continue;
    }
    if (k !== chave) mudou = true;
    contatos[k] = { ...(contatos[k] || {}), ...dados };
  }
  estado.contatos = contatos;

  const aliases = {};
  for (const [de, para] of Object.entries(estado.aliases || {})) {
    const kd = privacidade.ehHash(de) ? de : chaveDe(de);
    const kp = privacidade.ehHash(para) ? para : chaveDe(para);
    if (!kd || !kp) {
      mudou = true;
      continue;
    }
    if (kd !== de || kp !== para) mudou = true;
    aliases[kd] = kp;
  }
  estado.aliases = aliases;

  return mudou;
}

// Cache do estado lido, chaveado por caminho + mtime + tamanho.
//
// `carregar()` e chamado por contato (get/canonico). Sem cache, uma campanha
// de 5.000 contatos reparseia o estado.json inteiro 5.000 vezes por rodada -
// era o que fazia o resumo do painel levar mais de um minuto. O `statSync`
// tambem pesa (antivirus no Windows), entao o cache tem TTL curto: dentro da
// janela, devolve da memoria; passado o TTL, o mtime detecta gravacao de OUTRO
// processo (bot x painel). `salvar()` atualiza o cache na hora, entao quem
// grava no proprio processo nunca le versao velha.
const TTL_MS = 1000;
let _cache = null; // { arquivo, mtimeMs, size, checadoEm, estado }

// Campos que todo contato tem. Aplicados na leitura, entao um estado.json
// antigo (sem `repiqueEnviadoEm`, sem `neutrosCount`) continua valendo.
const CAMPOS_PADRAO = {
  suprimido: false,
  status: null,
  repiqueEnviadoEm: null, // quando o repique saiu (1x por numero, na vida)
  respostaEm: null, // ultima resposta da pessoa
  neutrosCount: 0, // quantas respostas neutras (1a = protocolo, 2a = despedida)
  equipeNotificadoEm: null, // quando a equipe foi avisada do interesse
  ultimaMensagem: null,
  ultimaMensagemEm: null,
  adicionadoEm: null, // quando entrou na lista (via importação)
};

function garantirPasta() {
  fs.mkdirSync(config.dataFolder, { recursive: true });
}

function estadoVazio() {
  return { contatos: {}, aliases: {} };
}

function comPadroes(estado) {
  for (const [jid, contato] of Object.entries(estado.contatos)) {
    estado.contatos[jid] = { ...CAMPOS_PADRAO, ...contato };
  }
  return estado;
}

function carregar() {
  const arquivo = config.estadoArquivo;
  const agora = Date.now();
  if (_cache && _cache.arquivo === arquivo && agora - _cache.checadoEm < TTL_MS) {
    return _cache.estado;
  }

  let info = null;
  try {
    info = fs.statSync(arquivo);
  } catch {
    // silencio-ok: arquivo ausente (primeiro boot) - o read abaixo devolve
    // estado vazio, que e o resultado correto aqui.
  }
  if (_cache && info && _cache.arquivo === arquivo && _cache.mtimeMs === info.mtimeMs && _cache.size === info.size) {
    _cache.checadoEm = agora;
    return _cache.estado;
  }

  let estado;
  try {
    estado = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (e) {
    // Arquivo ainda nao existe: e o estado normal do primeiro boot, nao um
    // defeito - segue com o estado vazio sem assustar ninguem.
    if (e.code === 'ENOENT') return estadoVazio();
    // Arquivo presente mas ilegivel: o .bak pode salvar, e se o estado
    // corromper de verdade a gente PRECISA saber - e aqui que moram os leads
    // e as supressoes.
    console.error(`[store] estado.json ilegivel (${e.message}); tentando o backup.`);
    estado = recuperarBackup() || estadoVazio();
  }
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) estado = estadoVazio();
  if (!estado.contatos || typeof estado.contatos !== 'object' || Array.isArray(estado.contatos)) {
    estado.contatos = {};
  }
  if (!estado.aliases || typeof estado.aliases !== 'object' || Array.isArray(estado.aliases)) {
    estado.aliases = {};
  }

  // Migracao de chave (JID -> hash) e um evento unico por instalacao. Grava na
  // hora: se ficasse so na memoria, o proximo processo leria o formato velho
  // de novo e a migracao nunca terminaria.
  if (migrarChaves(estado)) {
    try {
      escreverAtomic(config.estadoArquivo, JSON.stringify(estado, null, 2));
    } catch (e) {
      console.error(`[store] falha ao gravar o estado migrado: ${e.message}`);
    }
  }

  comPadroes(estado);
  if (info) _cache = { arquivo, mtimeMs: info.mtimeMs, size: info.size, checadoEm: Date.now(), estado };
  return estado;
}

function recuperarBackup() {
  try {
    const raw = fs.readFileSync(config.estadoArquivo + '.bak', 'utf8');
    return JSON.parse(raw);
  } catch {
    // silencio-ok: sem backup, quem chamou decide o que fazer (cai no estado
    // vazio) - o erro do arquivo principal ja foi registrado acima.
    return null;
  }
}

// Write atomico reaproveitado pelo estado.
//
// Por que nao writeFileSync direto: um processo morto no meio da escrita
// deixa o arquivo truncado. Com o JSON invalido, o catch abaixo devolvia
// { contatos: {} } e a Bia ESQUECIA todos os opt-outs - voltava a escrever
// para quem ja tinha pedido para sair. Aqui: escreve num .tmp, da fsync e
// renomeia (rename e atomico no mesmo volume, no Windows e no POSIX).
//
// O .bak guarda a versao ANTERIOR, que e a que importa quando a atual
// corrompe. Na primeira escrita da vida nao ha versao anterior, mas ja
// plantamos a reserva para a proxima.
function escreverAtomic(alvo, dados) {
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  const tmp = alvo + '.tmp';
  const bak = alvo + '.bak';

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, dados, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    if (fs.existsSync(alvo)) fs.copyFileSync(alvo, bak);
    else fs.copyFileSync(tmp, bak);
  } catch (e) {
    // O backup importa: e a rede de seguranca antes de sobrescrever o estado.
    // Se ele falha, a gravacao segue - mas quem le o log precisa saber.
    console.error(`[store] falha ao gravar o backup antes de salvar: ${e.message}`);
  }

  fs.renameSync(tmp, alvo);
}

function salvar(estado) {
  garantirPasta();
  escreverAtomic(config.estadoArquivo, JSON.stringify(estado, null, 2));
  try {
    const info = fs.statSync(config.estadoArquivo);
    _cache = {
      arquivo: config.estadoArquivo,
      mtimeMs: info.mtimeMs,
      size: info.size,
      checadoEm: Date.now(),
      estado,
    };
  } catch {
    _cache = null; // silencio-ok: sem stat, a proxima leitura recarrega.
  }
}

// Grava `adicionadoEm` de uma vez so para uma leva de contatos novos.
//
// A importacao chamava `atualizar()` por contato: com 5.000 numeros isso e
// 5.000 gravacoes do estado.json inteiro (cada uma maior que a anterior) - a
// importacao levava minutos. Aqui: uma leitura, um ajuste, uma gravacao.
function marcarAdicionadosEm(jids, quando) {
  const estado = carregar();

  // Com a chave hasheada, achar o contato e O(1): o hash do numero E a chave.
  // (O indice digitos -> chave que existia aqui era para varrer chaves-JID.)
  const agora = new Date().toISOString();
  let mudou = false;
  for (const jid of jids) {
    const k = chaveDe(jid);
    if (!k) continue;
    const chave = estado.aliases[k] || k;

    const atual = estado.contatos[chave] || {};
    if (atual.adicionadoEm) continue;
    estado.contatos[chave] = { ...atual, adicionadoEm: quando, atualizadoEm: agora };
    mudou = true;
  }
  if (mudou) salvar(estado);
  return mudou;
}

// ---------------- Identidade canonica ----------------

function normalizarJid(jid) {
  return String(jid || '').trim().toLowerCase();
}

// Converte o que o humano digita ("+55 11 99970-3778", "5511900000000") na
// chave @s.whatsapp.net que o estado realmente usa. Sem isto, digitos() nem
// acha os digitos (ela exige "@") e o reset por E.164 falha dizendo que o
// numero "nao esta no estado" mesmo com o contato la.
function e164ParaJid(numero) {
  const soDigitos = String(numero || '').replace(/\D/g, '');
  if (soDigitos.length < 10) return null;
  if (soDigitos.includes('@')) return normalizarJid(numero);
  return `${soDigitos}@s.whatsapp.net`;
}

function digitos(jid) {
  const j = normalizarJid(jid);
  // Com '@' (JID normal ou @lid opaco): comportamento original.
  const comArroba = /(\d{6,})@/.exec(j);
  if (comArroba) return comArroba[1];
  // E.164 puro, sem '@': e assim que o humano digita, mas o estado guarda
  // sempre com '@'. Sem este segundo caso, canonico() nao achava o contato e
  // o reset por numero dizia "nao esta no estado" com o contato la.
  const puro = /^(\d{10,15})$/.exec(j);
  return puro ? puro[1] : null;
}

// O mesmo numero pode aparecer como <num>@s.whatsapp.net num envio e <id>@lid
// na resposta. Resolve os dois para a mesma chave de contato. Com a chave
// hasheada, a comparacao "por digitos" do estado antigo virou comparacao de
// hash - que e a mesma conta, so que sem guardar o numero.
function canonico(estado, jid) {
  const k = chaveDe(jid);
  if (!k) return null;
  return estado.aliases[k] || k;
}

// Chamado depois de cada envio: o Baileys devolve no resultado o JID que ele
// realmente usou. Se for diferente do alvo, anotamos o vinculo.
function registrarAlias(jidAlvo, jidResolvido) {
  const alvo = normalizarJid(jidAlvo);
  const resolvido = normalizarJid(jidResolvido);
  if (!alvo || !resolvido || alvo === resolvido) return;

  const kAlvo = chaveDe(alvo);
  const kResolvido = chaveDe(resolvido);
  if (!kAlvo || !kResolvido || kAlvo === kResolvido) return;

  const estado = carregar();
  if (estado.aliases[kAlvo] === kResolvido) return;
  if (estado.contatos[kAlvo] && estado.contatos[kResolvido]) return; // dois contatos reais: nao junta

  estado.aliases[kAlvo] = kResolvido;
  salvar(estado);
}

// ---------------- Contatos ----------------

function get(jid) {
  const estado = carregar();
  const chave = canonico(estado, jid);
  if (!chave) return null;
  const contato = estado.contatos[chave];
  // `jid` devolvido e o de verdade (quem chamou precisa dele para enviar e
  // para o escopo.guard). A chave hasheada fica so dentro do estado.
  return contato ? { ...contato, jid: normalizarJid(jid) } : null;
}

function atualizar(jid, patch) {
  const estado = carregar();
  const chave = canonico(estado, jid);
  if (!chave) return null;
  const atual = estado.contatos[chave] || {};
  estado.contatos[chave] = { ...atual, ...patch, atualizadoEm: new Date().toISOString() };
  salvar(estado);
  return { ...estado.contatos[chave], jid: normalizarJid(jid) };
}

// Apaga o contato de verdade, junto com qualquer alias apontando para ele.
// Usar isto em vez de editar o estado.json na mao: a mao corrompe o arquivo e
// nao passa pelo write atomico nem pelo .bak.
function remover(jid) {
  const estado = carregar();
  const chave = canonico(estado, jid);
  if (!chave || !estado.contatos[chave]) return null;

  const removido = estado.contatos[chave];
  delete estado.contatos[chave];

  // Alias que apontavam para o contato apagado viram lixo: se o numero
  // voltar, o alias antigo ressuscitaria o registro deletado.
  for (const [de, para] of Object.entries(estado.aliases || {})) {
    if (para === chave) delete estado.aliases[de];
  }
  salvar(estado);
  return removido;
}

function listar() {
  // Devolve a CHAVE (hash), nao um jid: o estado nao tem mais o numero em
  // claro. Quem precisa do numero usa numeros.txt (lista da sessao).
  return Object.entries(carregar().contatos).map(([chave, dados]) => ({ chave, ...dados }));
}

module.exports = {
  ESTADO_VAZIO,
  CAMPOS_PADRAO,
  carregar,
  salvar,
  escreverAtomic,
  get,
  atualizar,
  marcarAdicionadosEm,
  remover,
  listar,
  canonico,
  digitos,
  normalizarJid,
  e164ParaJid,
  registrarAlias,
};
