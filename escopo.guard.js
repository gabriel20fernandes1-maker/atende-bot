'use strict';

// ============================================================
// Porteiro: a Bia so fala com quem esta na lista de repique.
//
// Sem isso, o bot respondia qualquer numero que mandasse texto no numero
// dele. A lista mora em data/numeros.txt (ver numeros.js) e e a UNICA
// autorizacao. `status: 'contatado'` no estado e historico, nunca permissao.
//
// PAPEIS:
//   lead   - quem esta em numeros.txt. Recebe UM repique e pode responder.
//   equipe - a equipe (config.escopo.equipe). Trabalha aqui: NUNCA entra em
//            campanha. So recebe o aviso interno de quem demonstrou interesse.
//            Se o numero dela aparecer em numeros.txt, numeros.js recusa.
//
// FALHA FECHADA: lista vazia (ou arquivo ausente) nao autoriza ninguem.
// ============================================================

const config = require('./config');
const numeros = require('./numeros');
const supressoes = require('./supressoes');

const STATUS = {
  CONTATADO: 'contatado', // recebeu o repique
  INTERESSADO: 'interessado', // respondeu que tem interesse
  TALVEZ: 'talvez', // ficou em duvida ("vou pensar", "talvez")
  NEUTRO: 'neutro', // respondeu outra coisa; ainda pode virar interesse
  NEGOU: 'negou', // recusou: nunca mais e contatado
};

// Status em que a Bia AINDA responde uma mensagem inbound. 'negou' fica de
// fora: quem recusou recebeu a despedida e nao e mais incomodado.
const RESPONDE = [STATUS.CONTATADO, STATUS.INTERESSADO, STATUS.TALVEZ, STATUS.NEUTRO];

const digitos = (jid) => String(jid || '').replace(/\D/g, '');

function entradasLead() {
  return numeros.carregar().entradas.map((e) => ({
    numero: e.numero,
    papel: 'lead',
    nome: e.nome,
  }));
}

function entradasEquipe() {
  const bruto = (config.escopo && config.escopo.equipe) || [];
  return bruto
    .map((e) => (typeof e === 'string' ? { numero: e, nome: null } : e))
    .filter((e) => e && e.numero)
    .map((e) => ({ numero: digitos(e.numero), papel: 'equipe', nome: e.nome || null }))
    .filter((e) => e.numero);
}

// Lista completa: leads (arquivo) + equipe (config).
function entradas() {
  return [...entradasLead(), ...entradasEquipe()];
}

function listaBranca() {
  return entradasLead().map((e) => e.numero);
}

// Indice numero -> entrada, para `achar` ser O(1).
//
// A campanha e o painel perguntam por contato (5.000 deles). Reconstruir a
// lista e varrer linha a linha a cada pergunta era O(N) por contato = O(N^2)
// no total (mais de 10s com 5.000). O indice e reconstruido so quando o
// arquivo muda: a chave e a IDENTIDADE do array que numeros.carregar()
// devolve, que so troca quando o arquivo muda (ou `invalidar()`).
let _indice = null; // { leads, mapa: Map<digitos, entrada> }

function indice() {
  const leads = numeros.carregar().entradas;
  if (_indice && _indice.leads === leads) return _indice.mapa;
  const mapa = new Map();
  for (const e of entradasEquipe()) mapa.set(e.numero, e);
  for (const e of leads) mapa.set(e.numero, { numero: e.numero, papel: 'lead', nome: e.nome });
  _indice = { leads, mapa };
  return mapa;
}

function achar(jid) {
  const d = digitos(jid);
  if (!d) return null;
  return indice().get(d) || null;
}

function papelDe(jid) {
  const e = achar(jid);
  return e ? e.papel : null;
}

function nomeDe(jid) {
  const e = achar(jid);
  return e ? e.nome : null;
}

function isEquipe(jid) {
  return papelDe(jid) === 'equipe';
}

function emListaBranca(jid) {
  const e = achar(jid);
  return e !== null;
}

// Verifica a lista no boot. Lista vazia, arquivo ausente ou numero invalido
// sao problemas explicitos: melhor a Bia nao subir do que subir sem saber com
// quem pode falar.
function auditar() {
  const problemas = [];
  const n = numeros.auditar();
  problemas.push(...n.problemas);

  if (n.total === 0) {
    problemas.push(`lista de repique VAZIA: crie ${config.numerosArquivo} com um numero por linha.`);
  }

  const equipe = entradasEquipe();
  const vistos = new Set();
  for (const e of equipe) {
    if (vistos.has(e.numero)) problemas.push(`numero de equipe duplicado: ${e.numero}`);
    vistos.add(e.numero);
    if (!/^\d{12,13}$/.test(e.numero) || !e.numero.startsWith('55') || Number(e.numero.slice(2, 4)) < 11) {
      problemas.push(`${e.nome || e.numero}: numero de EQUIPE invalido "${e.numero}"`);
    }
  }

  return { ok: problemas.length === 0, problemas, total: n.total, equipe: equipe.length };
}

// Inbound: a pessoa esta autorizada a receber resposta agora?
//
// A LISTA e a autorizacao; o `status` no estado e historico. Por isso o
// segundo parametro (`jid`): quem esta em numeros.txt responde mesmo sem
// entrada em estado.json - o caso de quem escreveu enquanto a Bia estava
// cega/desligada e nunca foi registrado. Antes isso virava
// 'numero_desconhecido' e a pessoa era ignorada em silencio (aconteceu em
// 30/09 e 06/10). O que continua barrando e o que a pessoa PEDIU: 'negou' e
// 'suprimido'. Fora da lista segue barrado.
function podeResponder(contato, jid) {
  const alvo = (contato && contato.jid) || jid || null;
  if (!alvo) return { ok: false, motivo: 'contato_sem_jid' };
  if (!emListaBranca(alvo)) {
    return { ok: false, motivo: contato ? 'fora_da_lista' : 'numero_desconhecido' };
  }
  if (isEquipe(alvo)) return { ok: false, motivo: 'equipe_fora_do_fluxo' };
  // Opt-out vale mesmo sem estado: o estado e por sessao, a supressao nao.
  if (supressoes.tem(alvo)) return { ok: false, motivo: 'suprimido' };
  if (!contato) return { ok: true, motivo: 'lista_sem_estado' };
  if (contato.suprimido) return { ok: false, motivo: 'suprimido' };
  if (contato.status === STATUS.NEGOU) return { ok: false, motivo: 'negou' };
  if (contato.status && !RESPONDE.includes(contato.status)) {
    return { ok: false, motivo: `fora_de_escopo(status=${contato.status})` };
  }
  return { ok: true, motivo: 'dentro_de_escopo' };
}

// Repique: a Bia pode iniciar contato por conta propria?
function podeReceberRepique(contato) {
  if (!contato) return { ok: false, motivo: 'numero_desconhecido' };
  if (!contato.jid) return { ok: false, motivo: 'contato_sem_jid' };
  if (!emListaBranca(contato.jid)) return { ok: false, motivo: 'fora_da_lista' };
  if (isEquipe(contato.jid)) return { ok: false, motivo: 'equipe_nao_recebe_repique' };
  if (contato.suprimido) return { ok: false, motivo: 'suprimido' };
  if (supressoes.tem(contato.jid)) return { ok: false, motivo: 'suprimido' };
  if (contato.status === STATUS.NEGOU) return { ok: false, motivo: 'negou' };
  // Quem ja escreveu para a Bia nao recebe repique: recontatar alguem que ja
  // falou com a gente e o pior tipo de duplicidade - e responde-lo continua
  // valendo (podeResponder), so o repique espontaneo e que nao.
  if (contato.respostaEm) return { ok: false, motivo: 'ja_respondeu' };
  if (contato.repiqueEnviadoEm) return { ok: false, motivo: 'repique_ja_enviado' };

  // Sem corte de 24h por data de importacao. A lista pode ter milhares de
  // numeros e a campanha trabalha uma cota por dia (config.repique.porDia),
  // entao quem espera a vez NAO pode vencer. "Nao respondeu" ja e tratado
  // para sempre: uma vez enviado (repiqueEnviadoEm), nunca e recontatado.
  return { ok: true, motivo: 'pode_repicar' };
}

// Numeros fora da lista branca que estao no estado (diagnostico). Compara
// hashes: a lista da os numeros, o estado so conhece as chaves.
function naoAutorizados() {
  const { listar } = require('./store');
  const privacidade = require('./privacidade');
  const autorizados = new Set(listaBranca().map((n) => privacidade.hash(n)).filter(Boolean));
  return listar()
    .filter((c) => c && c.chave && !autorizados.has(c.chave))
    .map((c) => c.chave);
}

module.exports = {
  STATUS,
  RESPONDE,
  podeResponder,
  podeReceberRepique,
  emListaBranca,
  isEquipe,
  papelDe,
  nomeDe,
  listaBranca,
  entradas,
  entradasLead,
  entradasEquipe,
  naoAutorizados,
  auditar,
};
