'use strict';

// ============================================================
// Rajada: uma resposta por silencio de 8 segundos.
//
// O defeito real de 26/09 nao foi so o timer do follow-up. Foi tambem a
// rajada: a pessoa manda "oi" e "quanto custa" colados, o bot.js tratava as
// duas na hora e respondia as duas. A pessoa recebe duas respostas que nao
// conversam entre si.
//
// A regra: cada mensagem inbound vira uma "nota" e NAO gera resposta. Quando
// a pessoa cala por config.rajadaSegundos, o que chegou vira UMA resposta. Os
// 8s nao sao arredondados: sao o que a pessoa digita com calma.
//
// Escolha de intent na rajada: classificar CADA mensagem separadamente e
// escolher pela ORDEM_PRIORIDADE. "oi" e "quero visitar" na mesma rajada ->
// responde sobre a visita, nao "bom dia". Isso importa porque a pessoa que
// manda varias mensagens juntas ja esta Asking algo, mesmo que comece com
// "oi".
//
// Sem rajada e sem fila, este arquivo seria inutil: o ganho vem de traitrResposta
// rodar uma vez por rajada, nao uma por mensagem.
// ============================================================

const config = require('./config');

const MS_POR_SEGUNDO = 1000;

// Em memoria: jid -> { notas: [...], timer: Timeout, aoDisparar: fn }
// Nao vai para disco de proposito. Perder a rajada em andamento no boot
// significa so que a pessoa vai ter que escrever de novo - que e o
// comportamento seguro. Persistir exigiria decidir o que fazer com um timer
// que nao sobrevive ao processo.
const rajadas = new Map();

function agoraMs() {
  return Date.now();
}

function janelaMs() {
  const seg = config.rajadaSegundos;
  return (Number.isFinite(seg) && seg > 0 ? seg : 8) * MS_POR_SEGUNDO;
}

// Empilha uma mensagem e reagenda o disparo. Chamar isto e o suficiente: quem
// passa `aoDisparar` recebe UMA vez, depois do silencio.
//
// O timer mora AQUI, e nao no chamador, por um motivo concreto. Quando ele
// vivia no bot.js E dentro daqui ao mesmo tempo, existiam dois timers para a
// mesma rajada: o do bot.js disparava e o daqui so se limpava. "Reiniciar a
// rajada" passava a depender de dois clearTimeout em dois arquivos, e
// esquecer um deles significa responder a pessoa no meio da frase. Um timer
// so, num lugar so.
function empilhar(jid, nota, aoDisparar) {
  let r = rajadas.get(jid);
  if (!r) {
    r = { notas: [], timer: null, aoDisparar: null };
    rajadas.set(jid, r);
  }

  // Cada nota e { texto, chave, nome, em }. `chave` e o m.key.id, para o
  // dedupe poder rodar uma unica vez: empilhar duas vezes o mesmo id (o Baileys
  // reentrega apos reconectar) nao pode virar duas notas. `nome` e o pushName
  // do WhatsApp, usado no aviso a equipe quando a lista nao tem nome.
  r.notas.push({ texto: nota.texto, chave: nota.chave, nome: nota.nome || null, em: agoraMs() });
  if (typeof aoDisparar === 'function') r.aoDisparar = aoDisparar;

  if (r.timer) clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    // O mapa e limpo ANTES do callback. Se o callback reentrar - e uma
    // resposta da Bia pode fazer o socket emitir algo - a rajada ja nao
    // existe, e nao ha caminho para responder duas vezes a mesma nota.
    const disparavel = rajadas.get(jid);
    rajadas.delete(jid);
    if (!disparavel) return;
    const cb = disparavel.aoDisparar;
    if (typeof cb === 'function') cb(jid, disparavel.notas);
  }, janelaMs());
  if (r.timer.unref) r.timer.unref(); // nao segura o processo vivo

  return { deadline: agoraMs() + janelaMs(), pendentes: r.notas.length };
}

// Devolve a rajada acumulada e limpa a memoria, SEM disparar. Usado por quem
// decide responder na hora (e pelos testes, que precisam olhar as notas).
function drenar(jid) {
  const r = rajadas.get(jid);
  if (!r) return null;
  if (r.timer) clearTimeout(r.timer);
  rajadas.delete(jid);
  return r.notas;
}

// Descarta a rajada sem responder e sem disparar. E o "cancela" de verdade:
// o que o shutdown e o opt-out usam, porque timer vivo depois da conversa
// acabar e o tipo de coisa que manda mensagem fora de hora.
function cancelar(jid) {
  const r = rajadas.get(jid);
  if (!r) return false;
  if (r.timer) clearTimeout(r.timer);
  rajadas.delete(jid);
  return true;
}

// Le sem limpar. Usado para log e para o proprio guard.
function espiar(jid) {
  const r = rajadas.get(jid);
  return r ? r.notas.slice() : [];
}

function pendente(jid) {
  return rajadas.has(jid);
}

function quantas(jid) {
  const r = rajadas.get(jid);
  return r ? r.notas.length : 0;
}

// Descarta tudo, sem responder. Usado no shutdown e nos testes: deixar timer
// vivo depois que o bot parou e o tipo de coisa que duplica mensagem.
function limparTudo() {
  for (const r of rajadas.values()) if (r.timer) clearTimeout(r.timer);
  rajadas.clear();
}

function tamanho() {
  return rajadas.size;
}

module.exports = {
  empilhar,
  drenar,
  cancelar,
  espiar,
  pendente,
  quantas,
  limparTudo,
  tamanho,
  janelaMs,
  MS_POR_SEGUNDO,
};
