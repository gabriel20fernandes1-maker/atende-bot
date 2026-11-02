'use strict';

// ============================================================
// Importador de contatos para data/numeros.txt.
//
// A fonte e o painel da empresa: o operador copia a tela e cola aqui. O formato
// colado e em blocos:
//
//   FrioFacebook Curso Gratis empresa     <- origem
//   Ana C. O.                             <- nome
//   +55 (11) 90000-0000                   <- telefone
//   06/10/2026, 11:02:29                  <- data
//   Alterado hoje
//
// O nome e a linha nao-vazia logo acima do telefone. Linhas com data (tem "/")
// sao ignoradas, o que separa telefone de data sem depender de posicao.
//
// A importacao so ACRESCENTA: nunca apaga numero que ja estava na lista. Se o
// operador colar duas vezes, o segundo e contado como repetido, nao duplicado.
// ============================================================

const fs = require('fs');
const config = require('./config');
const numeros = require('./numeros');
const { limparNome } = require('./nomes');
const store = require('./store');

function equipeDigitos() {
  const bruto = (config.escopo && config.escopo.equipe) || [];
  return new Set(
    bruto.map((e) => numeros.soDigitos(typeof e === 'string' ? e : e.numero)).filter(Boolean)
  );
}

// "55 (11) 90000-0000" -> "5511900000000"; null se nao der um numero valido.
function normalizar(token) {
  let d = numeros.soDigitos(token);
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return numeros.numeroValido(d) ? d : null;
}

function ehTelefone(linha) {
  const t = String(linha || '').trim();
  if (!t || t.startsWith('#')) return false;
  if (t.includes('/')) return false; // data
  const d = t.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13 && /\d/.test(t);
}

function nomeAcima(linhas, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = linhas[j].trim();
    if (!c || c.startsWith('#')) continue;
    if (c.includes('/')) continue;
    if (ehTelefone(c)) break;
    return c;
  }
  return null;
}

// Devolve [{ bruto, nome }] no formato colado do painel (blocos).
function parsearBlocos(texto) {
  const linhas = String(texto == null ? '' : texto).split(/\r?\n/);
  const achados = [];
  for (let i = 0; i < linhas.length; i++) {
    if (!ehTelefone(linhas[i])) continue;
    achados.push({ bruto: linhas[i].trim(), nome: nomeAcima(linhas, i) });
  }
  return achados;
}

function detectarDelimitador(linha) {
  if (linha.includes(';')) return ';';
  if (linha.includes(',')) return ',';
  return null;
}

// CSV x texto colado: o painel colado nao tem delimitador na linha do telefone;
// a data tem virgula, mas nao e telefone. Entao basta uma linha com 2+ colunas
// e um telefone em alguma delas (ou um cabecalho conhecido) para ser CSV.
function ehCsv(texto) {
  const linhas = String(texto == null ? '' : texto)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const primeira = linhas[0] || '';
  const delim = detectarDelimitador(primeira);
  if (delim && /nome|telefone|phone|celular|n[uú]mero|whatsapp|contato|fone/.test(primeira.toLowerCase())) return true;
  return linhas.some((l) => {
    const d = detectarDelimitador(l);
    return d ? l.split(d).some((c) => ehTelefone(c)) : false;
  });
}

// CSV com cabecalho (Nome;Telefone / Telefone,Nome / etc.) ou so colunas.
function parsearCsv(texto) {
  const linhas = String(texto == null ? '' : texto)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!linhas.length) return [];

  const delim = detectarDelimitador(linhas[0]) || ';';
  const cabecalho = linhas[0].toLowerCase();
  const temCabecalho =
    /nome|telefone|phone|celular|n[uú]mero|whatsapp|contato|fone/.test(cabecalho) && !ehTelefone(linhas[0]);

  let idxFone = -1;
  let idxNome = -1;
  let inicio = 0;
  if (temCabecalho) {
    const cols = linhas[0].split(delim).map((c) => c.trim().toLowerCase());
    idxFone = cols.findIndex((c) => /telefone|phone|celular|n[uú]mero|whatsapp|fone/.test(c));
    idxNome = cols.findIndex((c) => /nome|contato|name/.test(c));
    inicio = 1;
  }

  const achados = [];
  for (let i = inicio; i < linhas.length; i++) {
    const celulas = linhas[i].split(delim).map((c) => c.trim());
    let bruto;
    let nome;
    if (idxFone >= 0) {
      bruto = celulas[idxFone] || null;
      nome = idxNome >= 0 ? celulas[idxNome] || null : celulas.find((c) => c && !ehTelefone(c)) || null;
    } else {
      bruto = celulas.find((c) => ehTelefone(c)) || null;
      nome = celulas.find((c) => c && c !== bruto && !ehTelefone(c)) || null;
    }
    if (bruto && ehTelefone(bruto)) achados.push({ bruto, nome });
  }
  return achados;
}

// Aceita os dois formatos: texto colado do painel ou CSV.
function parsear(texto) {
  return ehCsv(texto) ? parsearCsv(texto) : parsearBlocos(texto);
}

// Le a lista atual preservando os comentarios do topo.
function lerArquivo(arquivo) {
  const entradas = [];
  const cabecalho = [];
  let existia = false;
  try {
    const cru = fs.readFileSync(arquivo, 'utf8');
    existia = true;
    for (const linha of cru.split(/\r?\n/)) {
      const t = linha.trim();
      if (!t) continue;
      if (t.startsWith('#')) {
        cabecalho.push(linha);
        continue;
      }
      const partes = t.split(';');
      const d = numeros.soDigitos(partes[0]);
      if (!numeros.numeroValido(d)) continue;
      entradas.push({ numero: d, nome: (partes.slice(1).join(';') || '').trim() || null });
    }
  } catch {
    // silencio-ok: arquivo ainda nao existe; a lista simplesmente comeca vazia.
  }
  return { entradas, cabecalho, existia };
}

const CABECALHO_PADRAO = [
  '# Lista de repique empresa - um numero por linha.',
  '# Formato: 55 + DDD + numero;Nome opcional',
  '# Linhas em branco e linhas com # sao ignoradas.',
  '# Numero da equipe (config.escopo.equipe) NAO entra aqui.',
];

// Importa. Devolve { novos, repetidos, invalidos, equipe, total, arquivo }.
function importar(texto, { arquivo = config.numerosArquivo, substituir = false, dryRun = false } = {}) {
  const achados = parsear(texto);
  const equipe = equipeDigitos();
  const atual = substituir ? { entradas: [], cabecalho: [], existia: false } : lerArquivo(arquivo);

  const porNumero = new Map(atual.entradas.map((e) => [e.numero, e]));
  const resultado = { novos: [], repetidos: [], invalidos: [], equipe: [], arquivo };
  const agora = new Date().toISOString();
  const jidsNovos = [];

  for (const a of achados) {
    const d = normalizar(a.bruto);
    if (!d) {
      resultado.invalidos.push({ numero: a.bruto, nome: a.nome });
      continue;
    }
    if (equipe.has(d)) {
      resultado.equipe.push({ numero: d, nome: a.nome });
      continue;
    }
    if (porNumero.has(d)) {
      const existente = porNumero.get(d).nome;
      resultado.repetidos.push({ numero: d, nome: limparNome(existente || a.nome) });
      continue;
    }
    // O que ENTRA ja entra limpo: emoji nao e nome. Se so havia emoji, entra
    // sem nome - a fala cai no texto sem nome em vez de "Oi, 🌸!".
    const entrada = { numero: d, nome: limparNome(a.nome) };
    porNumero.set(d, entrada);
    atual.entradas.push(entrada);
    resultado.novos.push(entrada);
    // O estado (adicionadoEm) e gravado UMA vez, no fim: por contato eram
    // 5.000 gravacoes do estado.json inteiro na importacao de 5.000 numeros.
    const jid = store.e164ParaJid(d);
    if (jid) jidsNovos.push(jid);
  }

  resultado.total = atual.entradas.length;

  if (dryRun) return resultado;

  try {
    if (atual.existia && fs.existsSync(arquivo)) {
      fs.copyFileSync(arquivo, `${arquivo}.bak-${Date.now()}`);
    }
  } catch {
    // silencio-ok: backup e rede de seguranca, nao pode impedir a importacao.
  }

  const cab = (atual.cabecalho.length ? atual.cabecalho : CABECALHO_PADRAO).join('\n');
  const corpo = atual.entradas.map((e) => `${e.numero}${e.nome ? ';' + e.nome : ''}`).join('\n');
  fs.writeFileSync(arquivo, `${cab}\n\n${corpo}\n`, 'utf8');
  numeros.invalidar();

  if (jidsNovos.length) store.marcarAdicionadosEm(jidsNovos, agora);

  return resultado;
}

// Remove UM contato da lista (por numero), preservando o resto e o cabecalho.
//
// Mesma familia de `limparLista`: a lista e a UNICA autorizacao, entao tirar um
// numero dali faz a Bia parar de responder a ele - mas NAO mexe em
// data/estado.json, entao o historico (inclusive opt-outs como "sair") fica.
// Guarda um .bak antes de reescrever, como todo o resto do modulo.
//
// Devolve { removido, numero, antes, agora }.
function removerContato(numero, { arquivo = config.numerosArquivo } = {}) {
  const alvo = numeros.soDigitos(numero);
  const atual = lerArquivo(arquivo);
  const antes = atual.entradas.length;

  if (!alvo) return { removido: false, numero: null, antes, agora: antes };

  const restantes = atual.entradas.filter((e) => e.numero !== alvo);
  if (restantes.length === antes) {
    return { removido: false, numero: alvo, antes, agora: antes };
  }

  try {
    if (fs.existsSync(arquivo)) fs.copyFileSync(arquivo, `${arquivo}.bak-${Date.now()}`);
  } catch {
    // silencio-ok: backup e rede de seguranca; nao pode impedir a remocao.
  }

  const cab = (atual.cabecalho.length ? atual.cabecalho : CABECALHO_PADRAO).join('\n');
  const corpo = restantes.map((e) => `${e.numero}${e.nome ? ';' + e.nome : ''}`).join('\n');
  fs.writeFileSync(arquivo, `${cab}\n\n${corpo}${corpo ? '\n' : ''}`, 'utf8');
  numeros.invalidar();

  return { removido: true, numero: alvo, antes, agora: restantes.length };
}

// Limpa a lista: grava so o cabecalho e guarda a versao anterior num .bak.
//
// A lista e a UNICA autorizacao (escopo.guard), entao limpar = a Bia para de
// responder a todos - e o bot que estiver rodando para na hora, porque le a
// lista a cada mensagem. NAO mexe em data/estado.json: o historico e, acima de
// tudo, os opt-outs ("sair", "nao quero") sao preservados. Um numero que voltar
// na proxima lista continua respeitando quem pediu para sair.
//
// Devolve { antes, agora, arquivo }.
function limparLista({ arquivo = config.numerosArquivo } = {}) {
  const atual = lerArquivo(arquivo);
  const antes = atual.entradas.length;

  try {
    if (fs.existsSync(arquivo)) fs.copyFileSync(arquivo, `${arquivo}.bak-${Date.now()}`);
  } catch {
    // silencio-ok: backup e rede de seguranca; nao pode impedir a limpeza.
  }

  const cab = (atual.cabecalho.length ? atual.cabecalho : CABECALHO_PADRAO).join('\n');
  fs.writeFileSync(arquivo, `${cab}\n\n`, 'utf8');
  numeros.invalidar();

  return { antes, agora: 0, arquivo };
}

module.exports = { importar, limparLista, removerContato, parsear, parsearCsv, normalizar };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const substituir = args.includes('--substituir');
  const entrada = args.find((a) => !a.startsWith('--'));
  if (!entrada) {
    console.error('Uso: node importar.js <arquivo> [--dry-run] [--substituir]');
    process.exit(1);
  }
  const texto = fs.readFileSync(entrada, 'utf8');
  const r = importar(texto, { substituir, dryRun });
  console.log(
    `Importar${dryRun ? ' (dry-run)' : ''}: ${r.novos.length} novo(s), ` +
      `${r.repetidos.length} repetido(s), ${r.invalidos.length} invalido(s), ${r.equipe.length} da equipe.`
  );
  for (const n of r.novos) console.log(`  + ${n.numero}${n.nome ? ' (' + n.nome + ')' : ''}`);
  for (const n of r.invalidos) console.log(`  ! invalido: ${n.numero}`);
  for (const n of r.equipe) console.log(`  ! equipe (nao entra): ${n.numero}`);
  if (!dryRun) console.log(`  lista agora com ${r.total} numero(s).`);
}
