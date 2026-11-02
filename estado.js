'use strict';

// ============================================================
// Estado de contato, em cima do store.js.
//
// O I/O (write atomico, identidade canonica) mora no store. Aqui ficam so as
// transicoes de estado do repique:
//
//   marcarRepiqueEnviado - o repique saiu. Trava "1 por numero, na vida".
//   marcarInteresse      - respondeu que tem interesse. Libera o aviso a equipe.
//   marcarNegacao        - recusou. Nunca mais e contatado.
//   marcarNeutro         - respondeu outra coisa. 1a = protocolo, 2a = despedida.
//   marcarEquipeNotificada - a equipe ja foi avisada deste interesse.
//   marcarResposta      - a pessoa escreveu e a conversa seguiu (endereco,
//                         escola, pergunta de informacao). So o horario.
// ============================================================

const store = require('./store');
const supressoes = require('./supressoes');
const { STATUS } = require('./escopo.guard');

function get(jid) {
  return store.get(jid);
}

function atualizar(jid, patch) {
  return store.atualizar(jid, patch);
}

function listar() {
  return store.listar();
}

const agora = () => new Date().toISOString();

// O repique saiu (via repicar.js). E isto que autoriza a pessoa a receber
// resposta e que a impede de receber o repique uma segunda vez.
function marcarRepiqueEnviado(jid) {
  return store.atualizar(jid, {
    status: STATUS.CONTATADO,
    repiqueEnviadoEm: agora(),
    suprimido: false,
  });
}

// Quem respondeu. `respostaEm` marca o horario para o relatorio.
function marcarInteresse(jid) {
  return store.atualizar(jid, { status: STATUS.INTERESSADO, respostaEm: agora() });
}

// Ficou em duvida ("talvez", "vou pensar", "estou analisando"). E lead morno:
// registra a resposta e marca o status. Nao rebaixa quem ja demonstrou
// interesse firme - interesse ganha de talvez.
function marcarTalvez(jid) {
  const contato = store.get(jid) || {};
  if (contato.status === STATUS.INTERESSADO) return contato;
  return store.atualizar(jid, { status: STATUS.TALVEZ, respostaEm: agora() });
}

// Recusou: agradeceu e se despediu. O status 'negou' fecha a porta para
// contato espontaneo E para resposta - a pessoa pediu para nao seguir.
//
// A supressao vai TAMBEM para data/supridos.txt (hash): o estado some com a
// sessao, a memoria de quem pediu para sair nao.
function marcarNegacao(jid) {
  supressoes.adicionar(jid);
  return store.atualizar(jid, { status: STATUS.NEGOU, respostaEm: agora() });
}

// Resposta que nao e sim nem nao. Conta quantas vezes para o bot saber se
// manda o protocolo (1a) ou a despedida (2a). Nao rebaixa quem ja demonstrou
// interesse.
function marcarNeutro(jid) {
  const contato = store.get(jid) || {};
  if (contato.status === STATUS.INTERESSADO || contato.status === STATUS.NEGOU) {
    return contato;
  }
  return store.atualizar(jid, {
    status: STATUS.NEUTRO,
    respostaEm: agora(),
    neutrosCount: (contato.neutrosCount || 0) + 1,
  });
}

// A equipe foi avisada deste interesse (o aviso so sai uma vez por pessoa).
function marcarEquipeNotificada(jid) {
  return store.atualizar(jid, { equipeNotificadoEm: agora() });
}

// A pessoa escreveu e a conversa seguiu (endereco, escola ou pergunta de
// informacao que a equipe assume). Marca o horario da resposta SEM mexer no
// status: nao e "neutro" (a pessoa nao ficou confusa) e nao e "interesse" (a
// Bia nao vendeu nada). O que isso garante e o que ja valia: quem respondeu
// nao recebe repique espontaneo de novo.
function marcarResposta(jid) {
  return store.atualizar(jid, { respostaEm: agora() });
}

function marcarSuprimido(jid) {
  supressoes.adicionar(jid);
  return store.atualizar(jid, { suprimido: true });
}

// Toda vez que a Bia envia texto, guardar o texto e o horario.
function registrarEnvio(jid, texto) {
  return store.atualizar(jid, {
    ultimaMensagem: texto,
    ultimaMensagemEm: agora(),
  });
}

// Volta o contato para "pode receber repique de novo", sem perder o historico
// de supressao anterior. Usado pelo reset manual (node estado.js --reset).
// O opt-out tambem sai da memoria permanente - se nao saisse, o reset nao
// liberaria ninguem para um novo contato.
function resetar(jid) {
  supressoes.remover(jid);
  return store.atualizar(jid, {
    suprimido: false,
    status: STATUS.CONTATADO,
    repiqueEnviadoEm: agora(),
    respostaEm: null,
    neutrosCount: 0,
    equipeNotificadoEm: null,
  });
}

module.exports = {
  get,
  atualizar,
  listar,
  marcarRepiqueEnviado,
  marcarInteresse,
  marcarTalvez,
  marcarNegacao,
  marcarNeutro,
  marcarEquipeNotificada,
  marcarResposta,
  marcarSuprimido,
  registrarEnvio,
  resetar,
};

//(node estado.js --reset <numero>) para liberar um numero para novo repique
//sem editar o estado.json na mao - que e exatamente o que corrompe o arquivo.
if (require.main === module) {
  const i = process.argv.indexOf('--reset');
  const bruto = i !== -1 ? process.argv[i + 1] : null;
  if (!bruto) {
    console.error('Uso: node estado.js --reset <numero E.164>');
    process.exit(1);
  }

  const jid = store.e164ParaJid(bruto);
  if (!jid) {
    console.error(`Numero invalido: "${bruto}". Use E.164, so digitos (ex: 5511900000000).`);
    process.exit(1);
  }

  const antes = store.get(jid);
  if (!antes) {
    console.error(`Numero ${bruto} nao esta no estado. Nada a fazer.`);
    process.exit(1);
  }
  const depois = resetar(jid);
  console.log(
    `${jid}: status=${antes.status} repique=${antes.repiqueEnviadoEm ? 'enviado' : 'nao'} -> ` +
      `status=${depois.status} repique=${depois.repiqueEnviadoEm ? 'enviado' : 'nao'}`
  );
}
