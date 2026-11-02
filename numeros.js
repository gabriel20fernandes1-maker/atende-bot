'use strict';

// ============================================================
// Lista de repique, lida de config.numerosArquivo (data/numeros.txt).
//
// Formato, uma linha por pessoa:
//
//   5511900000000;Dona Maria
//   5511900000000;Leon
//   # linha com # e comentario
//   (linha em branco e ignorada)
//
// O nome depois do ';' e opcional. O numero pode vir com +, espacos,
// parenteses ou tracos - a validacao olha so os digitos.
//
// A lista e a UNICA autorizacao para o repique (ver escopo.guard.js). Numero
// invalido nao e ignorado em silencio: vira problema em `auditar()`, senao o
// usuario acha que o numero entrou e ele nunca recebe nada.
//
// Numero da equipe em numeros.txt e recusado: a equipe trabalha aqui e nao
// entra em campanha, em hipotese nenhuma (ver config.escopo.equipe).
// ============================================================

const fs = require('fs');
const config = require('./config');
const { limparNome } = require('./nomes');

const E164 = /^\d{12,13}$/;

// Cache da ultima leitura, chaveada por caminho + mtime + tamanho.
//
// A lista e lida a cada mensagem e, na campanha, uma vez por contato. Sem o
// cache, 5.000 contatos significam 5.000 leituras de arquivo por rodada do
// painel (que chama o resumo a cada 5s) - segundos de atraso a toa.
//
// O `statSync` tambem nao e de graca (no Windows passa pelo antivirus): ~0,6ms
// por chamada x 5.000 contatos = segundos. Por isso o cache tem um TTL curto:
// dentro da janela devolve na memoria sem tocar no disco; passado o TTL, o
// mtime detecta troca por outro processo (o painel troca a lista, o bot le).
// `invalidar()` cobre a gravacao no proprio processo, sem esperar o TTL.
const TTL_MS = 1000;
let _cache = null; // { arquivo, mtimeMs, size, checadoEm, resultado }

function invalidar() {
  _cache = null;
}

function limpar(texto) {
  return String(texto == null ? '' : texto).trim();
}

// "55 (11) 90000-0000" -> "5511900000000"
function soDigitos(texto) {
  return limpar(texto).replace(/\D/g, '');
}

function numeroValido(digitos) {
  if (!E164.test(digitos)) return false;
  if (!digitos.startsWith('55')) return false;
  const ddd = digitos.slice(2, 4);
  if (ddd === '00' || Number(ddd) < 11) return false;
  return true;
}

function equipeDigitos() {
  const bruto = (config.escopo && config.escopo.equipe) || [];
  return bruto.map((e) => soDigitos(typeof e === 'string' ? e : e.numero)).filter(Boolean);
}

// Le e valida. Nunca lanca: arquivo ausente devolve lista vazia + um problema
// explicito, para o boot dizer "numeros.txt nao existe" em vez de a Bia subir
// muda.
function carregar() {
  const arquivo = config.numerosArquivo;
  const agora = Date.now();
  if (_cache && _cache.arquivo === arquivo && agora - _cache.checadoEm < TTL_MS) {
    return _cache.resultado;
  }

  const entradas = [];
  const problemas = [];
  let cru;
  let info;

  try {
    info = fs.statSync(arquivo);
    cru = fs.readFileSync(arquivo, 'utf8');
  } catch (e) {
    return {
      entradas,
      problemas: [{ linha: 0, texto: null, motivo: `nao consegui ler ${arquivo}: ${e.message}` }],
    };
  }

  if (_cache && _cache.arquivo === arquivo && _cache.mtimeMs === info.mtimeMs && _cache.size === info.size) {
    _cache.checadoEm = agora;
    return _cache.resultado;
  }

  const vistos = new Set();
  const equipe = new Set(equipeDigitos());
  const linhas = cru.split(/\r?\n/);

  linhas.forEach((linha, i) => {
    const numeroLinha = i + 1;
    const texto = limpar(linha);
    if (!texto || texto.startsWith('#')) return;

    const partes = texto.split(';');
    const digitos = soDigitos(partes[0]);
    // Emoji nao e nome: "Maria 🌸" vira "Maria" e "🌸🌸" vira null (a pessoa
    // continua na lista - quem nao tem nome recebe a fala sem nome). A
    // limpeza e na LEITURA: o arquivo fica como o operador colou.
    const nome = limparNome(partes.slice(1).join(';'));

    if (!numeroValido(digitos)) {
      problemas.push({ linha: numeroLinha, texto, motivo: 'numero invalido (esperado 55 + DDD + numero, 12-13 digitos)' });
      return;
    }
    if (equipe.has(digitos)) {
      problemas.push({ linha: numeroLinha, texto, motivo: 'numero da equipe: nao entra em campanha' });
      return;
    }
    if (vistos.has(digitos)) {
      problemas.push({ linha: numeroLinha, texto, motivo: 'numero duplicado na lista' });
      return;
    }

    vistos.add(digitos);
    entradas.push({ numero: digitos, nome });
  });

  const resultado = { entradas, problemas };
  _cache = { arquivo, mtimeMs: info.mtimeMs, size: info.size, checadoEm: agora, resultado };
  return resultado;
}

// { ok, problemas:[{linha,motivo}], total } - mesma forma do escopo.auditar.
function auditar() {
  const { entradas, problemas } = carregar();
  return {
    ok: problemas.length === 0,
    problemas: problemas.map((p) => `numeros.txt:${p.linha} ${p.motivo}${p.texto ? ` - "${p.texto}"` : ''}`),
    total: entradas.length,
  };
}

module.exports = { carregar, invalidar, auditar, numeroValido, soDigitos, limpar };
