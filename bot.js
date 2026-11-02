'use strict';

const fs = require('fs');
const path = require('path');
const { classificar, INTENTS, ORDEM_PRIORIDADE } = require('./classificador');

// Posicao do intent na tabela de prioridade. Menor = ganha. NEUTRO (fora da
// tabela) vai para o fim: numa rajada, "sim" nunca pode perder de "oi".
function ordemDe(intent) {
  const i = ORDEM_PRIORIDADE.indexOf(intent);
  return i === -1 ? ORDEM_PRIORIDADE.length : i;
}

const templates = require('./templates');
const imagens = require('./imagens');
const mensagensCampanha = require('./mensagens-campanha');
const escopo = require('./escopo.guard');
const { podeResponder, isEquipe } = escopo;
const dedupe = require('./dedupe.guard');
const rajada = require('./rajada.guard');
const { enviarTexto, testarVisao } = require('./enviar');
const lifecycle = require('./lifecycle');
const config = require('./config');
const privacidade = require('./privacidade');
const atendimento = require('./atendimento');
const estado = require('./estado');
const store = require('./store');
const saude = require('./saude');
const decisoes = require('./decisoes');
const campanha = require('./campanha');
const backup = require('./backup');
const mensagens = require('./mensagens');

const botLogFile = path.join(config.dataFolder, 'bot.log');
function log(msg) {
  const linha = `[${new Date().toISOString()}] ${msg}`;
  console.log(linha);
  // Toca a marca de atividade (no maximo 1x por minuto): e assim que o boot
  // sabe se a sessao ficou parada tempo demais para valer a pena manter.
  privacidade.marcarAtividade();
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.appendFileSync(botLogFile, linha + '\n', 'utf8');
  } catch (e) {
    console.error(`[log] falha ao gravar bot.log: ${e.message}`);
  }
}

// Janela de envio = horario de funcionamento da empresa (ver atendimento.js).
// A forcagem BIA_FORCAR pula SO este check; o escopo.guard nunca e pulado.
function checarJanela() {
  return atendimento.podeEnviar();
}

function textoDaMensagem(m) {
  const msg = m.message || {};
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
}

function ehConversaLateral(jid) {
  return jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter');
}

// Resolve o remetente para o numero de telefone.
//
// O WhatsApp migrou parte dos contatos para @lid (identificador opaco, sem
// relacao com o numero). A lista e o estado sao por numero, entao um @lid nao
// casa com ninguem e o portao barra a pessoa legitima. O Baileys manda o
// numero real em `senderPn` (e, em alguns casos, `remoteAlt`) ao lado do @lid.
// Se nao vier nada, devolve o proprio @lid - falha para o lado de "nao sei
// quem e", nunca para o lado de "respondo para quem nao devia".
function jidDeEscopo(key) {
  const bruto = key && key.remoteJid;
  if (!bruto) return bruto;
  if (!bruto.endsWith('@lid')) return bruto;
  for (const alt of [key.senderPn, key.remoteJidAlt, key.participantPn]) {
    if (alt && alt.endsWith('@s.whatsapp.net')) return alt;
  }
  return bruto;
}

// ============================================================
// O socket, os timers, o PID e a fila serial moram no lifecycle.js.
// Aqui fica so a decisao: o que fazer com a mensagem.
// ============================================================

// ============================================================
// Rajada: agrupar o que a pessoa escreveu.
//
// A pessoa manda "sim" e "quanto custa" colados. Tratar cada uma na hora
// produziria duas respostas. Aqui cada inbound so vira uma NOTA; a resposta
// sai quando a pessoa cala por config.rajadaSegundos.
//
// NAO envolver isto em `emFila`. A fila serial e do ENVIO (ver `enviar`).
// ============================================================
function processarRajada(sock, jid, notas) {
  return (async () => {
    if (!notas || !notas.length) return;

    const texto = notas.length === 1 ? notas[0].texto : notas.map((n) => n.texto).join(' / ');
    log(`[${jid}] Rajada de ${notas.length} mensagem(ns) -> uma resposta.`);

    const chaves = new Set();
    const novas = notas.filter((n) => {
      if (!n.chave) return true;
      if (chaves.has(n.chave)) return false;
      chaves.add(n.chave);
      return true;
    });
    if (novas.length === 0) {
      log(`[${jid}] Rajada sem nota nova (dedupe). Sem resposta.`);
      return;
    }

    // Nome do WhatsApp (pushName) da ultima nota que trouxe um. Serve de
    // reserva quando a lista nao tem nome; o nome da lista tem prioridade.
    const nomeWhatsapp = [...novas].reverse().find((n) => n.nome)?.nome || null;

    await tratarResposta(sock, jid, texto, {
      rajada: novas.length,
      partes: novas.map((n) => n.texto),
      chaves: novas.map((n) => n.chave),
      nomeWhatsapp,
    });
  })();
}

// ============================================================
// Envio: todo envio da Bia passa por aqui. Este wrapper so junta a fila
// serial do lifecycle: dois envios nunca se sobrepoem.
//
//   motivo: 'espontaneo' -> repique, aviso interno. Passa pela idempotencia.
//   motivo: 'solicitado' -> resposta a um pedido da pessoa. Bypass.
// ============================================================
function enviar(sock, jid, texto, opts = {}) {
  return lifecycle.emFila(() => enviarTexto(sock, jid, texto, { log, ...opts }));
}

// ============================================================
// Aviso a equipe (a equipe).
//
// Duas coisas diferentes usam este caminho:
//
// 1. LEAD - a pessoa confirmou que quer (interesse), ficou em duvida (talvez)
//    ou respondeu algo ambiguo (indefinido). Um aviso por pessoa
//    (`equipeNotificadoEm`), mesmo que a pessoa mande "sim" cinco vezes.
//
// 2. A OLHADA - mensagem que nao e lead (duvida, pergunta, reclamacao) ou
//    mensagem de quem nem esta na lista. A Bia leu e nao sabe se aquilo e
//    para ela ou para uma pessoa: quem olha e a equipe. Estes avisos saem
//    NA HORA, sem esperar a janela de trabalho e sem o ritmo de envio para
//    pessoas diferentes - o ritmo existe para nao queimar a lista em disparo
//    em lote, e nao para atrasar quem esta na sua frente.
//
// O nome vai junto (primeiro nome): a equipe precisa saber de quem e.
// Prioridade: o nome da lista importada; se nao houver, o pushName do
// WhatsApp.
//
// Nao passa pelo podeResponder: a equipe nao esta no fluxo de lead, ela e
// quem atende. E o unico caminho de envio para fora da lista de repique.
// ============================================================

// Tipos que sao "lead": um aviso por pessoa, para sempre.
const TIPOS_DE_LEAD = new Set(['interesse', 'talvez', 'indefinido']);

// A olhada: no maximo um aviso por PESSOA a cada 5 min. Duas pessoas
// diferentes sao avisadas na mesma hora - o limite e por pessoa, nao global.
// (Vive em memoria de proposito: gente de fora da lista nao tem registro de
// contato no estado.json, e nao ha motivo para criar um so por isso.)
const AVISO_POR_PESSOA_MS = 5 * 60 * 1000;
const ultimoAvisoPorPessoa = new Map();
// Os avisos que NAO sao sinal de dinheiro: a equipe recebe no maximo 1 por
// pessoa a cada 5 min. Interesse/talvez ficam de fora do limite (sao a razao
// de existir do aviso) - e ja saem uma vez por pessoa.
const TIPOS_COM_COOLDOWN = new Set(['mensagem', 'fora_da_lista', 'indefinido', 'informacao']);

async function notificarEquipe(sock, jid, textoResposta, { tipo = 'interesse', nomeWhatsapp = null } = {}) {
  if (!jid) return false;
  const contato = estado.get(jid) || {};
  const equipe = escopo.entradasEquipe();
  if (!equipe.length) {
    log(`[${jid}] Mensagem recebida, mas nao ha numero de equipe em config.escopo.equipe.`);
    return false;
  }

  if (TIPOS_COM_COOLDOWN.has(tipo)) {
    const ultimo = ultimoAvisoPorPessoa.get(jid) || 0;
    if (Date.now() - ultimo < AVISO_POR_PESSOA_MS) return false;
  }
  if (TIPOS_DE_LEAD.has(tipo)) {
    // A equipe ja sabe deste interesse: repetir nao ajuda.
    if (contato.equipeNotificadoEm) return false;
  }

  // Nome para a equipe saber quem e: o da lista (importada) manda; se a
  // lista nao tiver, usa o pushName do WhatsApp. O corte para o primeiro nome
  // acontece no templates.avisoEquipe.
  const nome = escopo.nomeDe(jid) || nomeWhatsapp;
  const numero = String(jid).replace(/@.*/, '');
  const texto = templates.avisoEquipe({ nome, numero, texto: textoResposta, tipo });

  let saiu = false;
  for (const pessoa of equipe) {
    const jidEquipe = `${pessoa.numero}@s.whatsapp.net`;
    try {
      await enviar(sock, jidEquipe, texto, { motivo: 'espontaneo' });
      saiu = true;
      log(`[${jid}] Equipe avisada em ${pessoa.numero} (${tipo}).`);
    } catch (e) {
      log(`[${jid}] Falha ao avisar a equipe (${pessoa.numero}): ${e.message}`);
    }
  }
  if (!saiu) return false;

  ultimoAvisoPorPessoa.set(jid, Date.now());
  if (TIPOS_DE_LEAD.has(tipo)) estado.marcarEquipeNotificada(jid);
  return true;
}

// ============================================================
// A decisao sobre uma resposta (rajada fechada).
//
//   NEGACAO   -> agradece e se despede; nunca mais contata.
//   INTERESSE -> avisa que a equipe entra em contato e notifica a equipe.
//   TALVEZ    -> acolhe ("vou pensar", "talvez") e notifica a equipe: lead morno.
//   NEUTRO    -> 1a vez: protocolo. 2a vez: avisa a equipe para conferir.
// ============================================================
async function tratarResposta(sock, jid, texto, { rajada: tamanhoRajada = 1, partes = null, chaves = null, nomeWhatsapp = null } = {}) {
  // Contato pode nao existir: quem escreveu enquanto a Bia estava cega nunca
  // foi registrado. O portao decide com a lista (numeros.txt); o estado e
  // criado pelas marcacoes logo abaixo, quando a resposta sai.
  const contato = estado.get(jid) || {};
  const keyId = Array.isArray(chaves) && chaves.length ? chaves[0] : null;
  const decidir = (linha) => decisoes.registrar({ jid, keyId, ...linha });

  // A equipe nunca e atendida automaticamente: e a equipe, que trabalha aqui.
  if (isEquipe(jid)) {
    log(`[${jid}] Mensagem da equipe ignorada (canal operacional).`);
    return decidir({ acao: 'equipe', motivo: 'canal_operacional' });
  }

  // Classificar. Numa rajada, cada mensagem e classificada e a de maior
  // prioridade ganha (NEGACAO > INTERESSE > TALVEZ > NEUTRO).
  //
  // A classificacao vem ANTES do portao de proposito: o aviso para a equipe
  // precisa saber o que a pessoa escreveu (interesse, duvida, recusa) mesmo
  // quando ela nao esta na lista. Classificar e puro - nao toca em estado.
  let intent;
  let confianca;
  if (tamanhoRajada > 1 && Array.isArray(partes) && partes.length > 1) {
    const avaliadas = partes.map((p) => ({ texto: p, ...classificar(p) }));
    avaliadas.sort((a, b) => ordemDe(a.intent) - ordemDe(b.intent));
    const melhor = avaliadas[0];
    intent = melhor.intent;
    confianca = melhor.confianca;
    log(
      `[${jid}] Rajada: ` +
        avaliadas.map((a) => `${a.texto.slice(0, 20)}=>${a.intent}`).join(', ') +
        ` -> escolheu ${intent}`
    );
  } else {
    ({ intent, confianca } = classificar(texto));
    log(`[${jid}] Recebido: "${texto}" -> ${intent} (confianca ${confianca})`);
  }

  // A mensagem fica registrada no feed (data/mensagens.json): e o que o
  // operador ve no painel - quem escreveu, o que escreveu, e se a equipe ja
  // foi avisada.
  const nomeDaPessoa = escopo.nomeDe(jid) || nomeWhatsapp;
  const idMsg = mensagens.registrar({
    jid,
    nome: nomeDaPessoa,
    numero: String(jid).replace(/@.*/, ''),
    texto,
    intent,
  });

  // Um atalho para avisar a equipe e marcar a mensagem como avisada.
  const avisarEquipe = async (tipo) => {
    const avisado = await notificarEquipe(sock, jid, texto, { tipo, nomeWhatsapp });
    if (avisado) mensagens.marcarAvisada(idMsg);
    return avisado;
  };

  // PORTEIRO. Antes de qualquer outra coisa. O `jid` autoriza quem esta na
  // lista sem entrada no estado (resposta de quem escreveu antes).
  const portaria = podeResponder(contato, jid);
  if (!portaria.ok) {
    log(`[${jid}] Ignorado: ${portaria.motivo}. "${texto.slice(0, 40)}"`);
    // A OLHADA de quem esta fora da lista. A Bia nao responde (nao e lead),
    // mas a equipe OLHA: cliente novo perguntando preco e dinheiro na mesa,
    // e a Bia nao tem como decidir isso sozinha. So nao avisa quando a pessoa
    // disse que nao quer - ai ela ja respondeu.
    if (portaria.motivo === 'fora_da_lista' || portaria.motivo === 'numero_desconhecido') {
      // Aviso no WhatsApp so quando configurado; o feed do painel registra
      // a mensagem de qualquer jeito (mensagens.registrar veio antes).
      if (intent !== INTENTS.NEGACAO && config.avisarForaDaLista !== false) {
        await avisarEquipe('fora_da_lista');
      }
    }
    return decidir({ acao: 'bloqueado', guard: 'escopo', motivo: portaria.motivo });
  }

  // Quem pediu para sair cancela qualquer rajada em aberto: uma resposta
  // depois do "sair" ainda chegaria da mesma frase.
  if (intent === INTENTS.NEGACAO) rajada.cancelar(jid);

  // PERGUNTA DE INFORMACAO: a Bia NAO responde - nem o protocolo. Preco,
  // horario, turma, quais cursos, detalhes: quem responde e a equipe, do
  // mesmo celular da Bia. O aviso sai na hora (nao espera a janela) e a
  // mensagem fica no feed marcada como avisada.
  if (intent === INTENTS.INFORMACAO) {
    const avisado = await avisarEquipe('informacao');
    estado.marcarResposta(jid);
    log(
      avisado
        ? `[${jid}] Pergunta de informacao - equipe avisada, sem resposta ao cliente.`
        : `[${jid}] Pergunta de informacao - equipe ja avisada ha pouco.`
    );
    return decidir({ acao: 'escalado', intent, motivo: null });
  }

  const jaInteressado = contato.status === escopo.STATUS.INTERESSADO;
  const ambiguoDeNovo =
    intent === INTENTS.NEUTRO && !jaInteressado && (contato.neutrosCount || 0) >= 1;

  // A pessoa ja mandou uma resposta ambigua e continua confusa. Nao despede e
  // nao insiste: a equipe e avisada para conferir se o contato deve ser
  // encaminhado. O aviso sai uma vez por pessoa (equipeNotificadoEm).
  //
  // O aviso NAO espera a janela de trabalho: a pessoa esta na sua frente
  // perguntando. Quem responde na hora e a equipe, nao a Bia.
  if (ambiguoDeNovo) {
    const avisado = await avisarEquipe('indefinido');
    log(
      avisado
        ? `[${jid}] Resposta indefinida - equipe avisada para conferir.`
        : `[${jid}] Resposta indefinida de novo - equipe ja avisada antes.`
    );
    return decidir({ acao: 'indefinido', intent, motivo: null });
  }

  // A OLHADA. A mensagem que nao e interesse, hesitacao, pergunta de
  // informacao (essa ja foi para a equipe acima) nem endereco/escola (a Bia
  // responde sozinha) e levada a equipe, com o nome da pessoa: duvida,
  // reclamacao - coisas que a Bia nao tem como responder sozinha.
  //
  // Sai NA HORA: sem esperar a janela de trabalho e sem o ritmo de envio
  // para pessoas diferentes. NEGACAO nao avisa: quem disse nao ja respondeu.
  if (intent === INTENTS.NEUTRO) {
    const avisado = await avisarEquipe('mensagem');
    if (avisado) log(`[${jid}] Equipe avisada (olhada).`);
  }

  // Texto da resposta e transicao de estado.
  let resposta;
  if (intent === INTENTS.NEGACAO) {
    resposta = templates.negacao();
  } else if (intent === INTENTS.INTERESSE) {
    // Responde pelo que a mensagem REAL diz, nao pelo status salvo: um "Oi"
    // de quem ja foi marcado como interessado nao e um novo "sim" e nao pode
    // receber o texto de interesse. Quem decide e o classificador do inbound.
    resposta = templates.interesse();
  } else if (intent === INTENTS.TALVEZ) {
    // Hesitacao ("talvez", "vou pensar"): acolhe e adianta que a equipe ajuda.
    resposta = templates.talvez();
  } else if (intent === INTENTS.ENDERECO) {
    // "Onde fica": a Bia responde o endereco, sem esperar a equipe.
    resposta = templates.endereco();
  } else if (intent === INTENTS.ESCOLA) {
    // "De que empresa": a Bia responde o texto de config.textos.respostas.sobre.
    resposta = templates.escola();
  } else {
    resposta = templates.protocolo();
  }

  // Janela de envio. Fora do horario, segura a RESPOSTA automatica sem mexer no
  // estado - quando a pessoa escrever de novo, a decisao e refeita.
  //
  // O AVISO para a equipe NAO espera: um interesse que chega as 19h e negocio
  // na mesa, e a equipe liga amanha. A janela existe para a Bia nao parecer
  // robo de madrugada, nao para esconder o lead.
  const janela = checarJanela();
  if (!janela.ok) {
    log(`[${jid}] Fora do horario - resposta segurada (${janela.motivo}).`);
    if (intent === INTENTS.INTERESSE || intent === INTENTS.TALVEZ) {
      await avisarEquipe(intent === INTENTS.TALVEZ ? 'talvez' : 'interesse');
    }
    return decidir({ acao: 'segurado', guard: 'janela', motivo: janela.motivo, intent });
  }

  // Efeitos de estado. Aplicados so quando a resposta vai sair.
  if (intent === INTENTS.NEGACAO) {
    estado.marcarNegacao(jid);
  } else if (intent === INTENTS.INTERESSE) {
    estado.marcarInteresse(jid);
  } else if (intent === INTENTS.ENDERECO || intent === INTENTS.ESCOLA) {
    // Respondeu o que sabe, sem virar lead: registra a resposta e nao mexe no
    // status (nao e "neutro" - a pessoa nao ficou confusa).
    estado.marcarResposta(jid);
  } else if (jaInteressado) {
    // nada: ja e interessado (interesse firme nao rebaixa para "talvez")
  } else if (intent === INTENTS.TALVEZ) {
    estado.marcarTalvez(jid);
  } else {
    estado.marcarNeutro(jid);
  }

  try {
    await enviar(sock, jid, resposta, { motivo: 'solicitado' });
    log(`[${jid}] Resposta enviada (${intent}).`);
  } catch (e) {
    log(`[${jid}] Falha ao responder (${intent}): ${e.message}`);
    return decidir({ acao: 'falha', intent, motivo: e.message });
  }

  // A equipe e avisada quando ha interesse OU hesitacao ("talvez"). Depois do
  // envio, para o aviso nunca citar uma resposta que nao saiu.
  if (intent === INTENTS.INTERESSE || intent === INTENTS.TALVEZ) {
    const tipo = intent === INTENTS.TALVEZ ? 'talvez' : 'interesse';
    await avisarEquipe(tipo);
  }

  decidir({ acao: 'respondido', intent, motivo: null });
}

// ============================================================
// Uma mensagem inbound, do transporte ate a rajada.
// ============================================================
async function processarMensagem(m, sock) {
  // A ORDEM IMPORTA para o discriminador de cegueira. "sem corpo" (m.message
  // ausente) so e evidencia quando e uma conversa 1:1 de cliente: grupo,
  // status e newsletter falham decrypt o tempo todo (sender keys) e uma
  // mensagem fromMe sem corpo e recibo, nao cegueira. Contar esses casos fazia
  // uma Bia saudavel aparecer CEGA e pedir re-pareamento sem necessidade - o
  // "eco ok, mas o painel manda parear de novo".
  if (!m) {
    saude.contarDescarte('sem_corpo_sem_key');
    return { acao: 'ignorado', motivo: 'sem_corpo' };
  }
  if (m.key && m.key.fromMe) {
    saude.contarDescarte('fromMe');
    return { acao: 'ignorado', motivo: 'fromMe' };
  }

  const jidBruto = m.key && m.key.remoteJid;
  if (!jidBruto || ehConversaLateral(jidBruto)) {
    saude.contarDescarte('conversa_lateral');
    return { acao: 'ignorado', motivo: 'conversa_lateral' };
  }

  if (!m.message) {
    saude.contarDescarte('sem_corpo');
    return { acao: 'ignorado', motivo: 'sem_corpo' };
  }

  const texto = textoDaMensagem(m);
  if (!texto) {
    saude.contarUpsertSemTexto();
    saude.contarDescarte('sem_texto');
    return decisoes.registrar({ jid: jidBruto, acao: 'ignorado', motivo: 'sem_texto' });
  }

  // So chega aqui o que o libsignal conseguiu DECRIPTAR. E o pulso que separa
  // "a Bia esta ouvindo" de "a Bia esta viva e cega".
  saude.marcarInbound();

  const jid = jidDeEscopo(m.key);
  if (jid !== jidBruto) {
    log(`[${jidBruto}] LID resolvido para ${jid}.`);
    try {
      store.registrarAlias(jidBruto, jid);
    } catch (e) {
      log(`Falha ao registrar o alias ${jidBruto} -> ${jid}: ${e.message}`);
    }
  }

  const chave = m.key.id || jid + ':' + (m.messageTimestamp || '');
  if (!dedupe.registrar(chave)) {
    log(`[${jid}] Descartada (dedupe): "${texto.slice(0, 40)}"`);
    return decisoes.registrar({ jid, keyId: chave, acao: 'dedupe', motivo: 'ja_vista' });
  }

  // Rajada: aqui NAO se responde. A mensagem vira nota e a resposta sai quando
  // a pessoa calar por config.rajadaSegundos. O timer mora no guard.
  const janela = rajada.empilhar(jid, { texto, chave, nome: m.pushName }, (_j, notas) => {
    processarRajada(sock, _j, notas).catch((e) => log(`Erro na rajada: ${e.message}`));
  });
  log(`[${jid}] Nota na rajada (${janela.pendentes}). Resposta em ~${config.rajadaSegundos}s de silencio.`);
  return decisoes.registrar({ jid, keyId: chave, acao: 'rajada', motivo: null });
}

// ============================================================
// Um upsert do WhatsApp: transporte -> decisao.
// ============================================================
async function tratarUpsert({ messages, type }, sock) {
  saude.contarUpsert(type, messages.length);
  if (process.env.BIA_DEBUG_INBOUND === '1') {
    log(
      `[upsert] tipo=${type} n=${messages.length} :: ` +
        messages
          .map(
            (m) =>
              `fromMe=${m?.key?.fromMe} jid=${m?.key?.remoteJid} alt=${m?.key?.remoteJidAlt} pn=${m?.key?.senderPn} msg=${m?.message ? Object.keys(m.message).join('|') : 'nulo'}`
          )
          .join(' ; ')
    );
  }

  if (type === 'notify') {
    for (const m of messages) await tratarUmaMensagem(m, sock);
    return;
  }

  // Offline/historico (mensagens que chegaram enquanto a Bia estava cega): so
  // vale responder o que ainda esta dentro de 24h. Sem isto, quem escreveu nao
  // seria atendido nunca, a nao ser que reenviasse - e isso era inaceitavel.
  const agoraSeg = Math.floor(Date.now() / 1000);
  const recentes = messages.filter((m) => {
    const t = Number(m && m.messageTimestamp) || 0;
    return t > 0 && agoraSeg - t <= 24 * 3600;
  });
  if (recentes.length) {
    log(`[offline] ${recentes.length} de ${messages.length} mensagem(ns) recente(s) (ate 24h) para responder.`);
  }
  for (const m of recentes) await tratarUmaMensagem(m, sock);
}

async function tratarUmaMensagem(m, sock) {
  try {
    await processarMensagem(m, sock);
  } catch (e) {
    log(`Erro ao tratar mensagem: ${e.message}`);
  }
}

// ============================================================
// Campanha diaria: ate config.repique.porDia numeros NOVOS por dia, num ritmo
// humano.
//
// Roda no proprio bot (o mesmo socket que ouve). NAO usa o repicar.js, que
// exige o bot parado - por isso a campanha precisa morar aqui. So dispara com
// o interruptor ligado (data/campanha.ligada) e a janela aberta.
// ============================================================
let campanhaExecutando = false;
let campanhaProximoEm = 0; // ms epoch do proximo envio permitido
let campanhaAvisouCega = false;

function intervaloHumano() {
  const min = config.repique.campanhaEntreMin;
  const max = config.repique.campanhaEntreMax;
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

async function rodarCampanha(sock = lifecycle.socket()) {
  if (campanhaExecutando) return { acao: 'ocupado' };
  if (!campanha.ligada()) return { acao: 'pausada' };
  // Sessao cega: nao queima a lista. O repique chega no cliente, a resposta
  // se perde no buraco e o contato fica marcado como "contatado" sem ninguem
  // ter falado com ele. Pausar e o que protege os 5 mil nomes da lista.
  if (saude.ler().cegueira) {
    if (!campanhaAvisouCega) {
      campanhaAvisouCega = true;
      log(
        'Campanha PAUSADA: a sessao esta cega (chegam mensagens e nao decriptam). ' +
          'Re-parear a Bia pelo painel para voltar a trabalhar a lista.'
      );
    }
    return { acao: 'cega' };
  }
  campanhaAvisouCega = false;
  if (!sock) return { acao: 'sem_socket' };
  if (!checarJanela().ok) return { acao: 'fora_janela' };
  if (Date.now() < campanhaProximoEm) return { acao: 'aguardando' };
  if (campanha.restantesHoje() <= 0) return { acao: 'cota_do_dia' };

  const alvo = campanha.proximoPendente();
  if (!alvo) return { acao: 'sem_pendente' };

  campanhaExecutando = true;
  // Reserva o intervalo ANTES de enviar: se o envio demorar ou falhar, nao
  // entra em loop apertado.
  campanhaProximoEm = Date.now() + intervaloHumano();
  try {
    const img = imagens.paraRepique();
    const fala = mensagensCampanha.para(alvo.nome) || templates.repique(alvo.nome);
    await enviar(sock, alvo.jid, fala, { motivo: 'espontaneo', imagem: img });
    estado.marcarRepiqueEnviado(alvo.jid);
    campanha.registrarEnvio();
    log(
      `[campanha] repique enviado para ${alvo.numero}${alvo.nome ? ' (' + alvo.nome + ')' : ''}` +
        `${img ? ' com imagem ' + img.nome : ''}.`
    );
    return { acao: 'enviado', jid: alvo.jid };
  } catch (e) {
    log(`[campanha] falha ao enviar para ${alvo.numero}: ${e.message}`);
    return { acao: 'falha', motivo: e.message };
  } finally {
    campanhaExecutando = false;
  }
}

// Qual biblioteca de imagem o Baileys vai conseguir usar nesta maquina.
// A ordem e a mesma dele (sharp primeiro, jimp depois); devolve null quando
// nenhuma carrega - que e exatamente o caso que quebra o envio de foto.
async function bibliotecaDeImagem() {
  for (const nome of ['sharp', 'jimp']) {
    try {
      await import(nome);
      return nome;
    } catch {
      // silencio-ok: a proxima da lista pode existir.
    }
  }
  return null;
}

async function main() {
  // 0.0) Privacidade, antes de qualquer leitura: sessao parada demais tem o
  //      dado pessoal apagado, e teto diario acima do recomendado avisa.
  const apagados = privacidade.limparSessaoAntiga(config.privacidade.maxHorasSessao);
  if (apagados.length) {
    log(`Privacidade: sessao anterior apagada por inatividade (${apagados.join(', ')}).`);
    log('Importe a lista de contatos de novo no painel antes de ligar a campanha.');
  }
  config.avisarQuota();
  privacidade.marcarAtividade(true);

  // 0) A lista de repique esta sa? Melhor a Bia nao subir do que subir sem
  //    saber com quem pode falar.
  const escopoSaude = escopo.auditar();
  if (!escopoSaude.ok) {
    log('CONFIG INVALIDA - a Bia nao vai subir:');
    for (const p of escopoSaude.problemas) log(`  - ${p}`);
    log('Corrija data/numeros.txt (ou config.escopo.equipe) e rode de novo.');
    process.exit(1);
  }
  log(`Escopo ok: ${escopoSaude.total} numero(s) na lista, ${escopoSaude.equipe} na equipe.`);

  // 0.1) Imagem no repique exige biblioteca de imagem (sharp ou jimp).
  //
  // O Baileys chama sharp/jimp para montar a miniatura de TODA midia; sem
  // nenhuma das duas ele lanca "No image processing library available" e o
  // envio inteiro falha (o texto vai junto). Com imagemChance = 1 isso e a
  // campanha toda - em silencio, porque a falha morre no envio.
  //
  // A pasta de imagens e conferida nas DUAS pastas de proposito: o smoke roda
  // com BIA_DATA_DIR numa pasta temporaria (so com numeros.txt), e sem o
  // fallback para data/ do projeto ele nunca veria que ha imagem configurada.
  if (config.repique.imagemChance > 0) {
    const temImagem = [config.dataFolder, path.join(__dirname, 'data')].some((p) => {
      try {
        return imagens.listar(path.join(p, 'imagens')).length > 0;
      } catch {
        return false;
      }
    });
    if (temImagem) {
      const lib = await bibliotecaDeImagem();
      if (!lib) {
        log('CONFIG INVALIDA - a campanha manda imagem, mas nao ha biblioteca de imagem.');
        log('  Instale o sharp desta maquina:  npm install sharp');
        log('  (sem ela todo envio com foto falha: "No image processing library available")');
        process.exit(1);
      }
      log(`Imagens ok: biblioteca ${lib} carregada.`);
    }
  }

  // --smoke: roda tudo o que o boot roda ATE aqui e sai. Nao abre socket.
  if (process.argv.includes('--smoke')) {
    log('SMOKE OK - escopo passou; nada foi conectado nem enviado.');
    process.exit(0);
  }

  saude.instalarFiltroDeRuido();

  // Instancia unica ANTES de tocar em health.json: um boot recusado (a trava
  // ja pertence a outro bot) nao pode apagar o health de quem esta rodando -
  // era isso que deixava `inbounds: 0` de um processo que so apareceu e saiu.
  const t = lifecycle.adquirirTrava();
  if (!t.ok) {
    log(`Ja existe um bot rodando (PID ${t.pid}). Este processo vai sair.`);
    process.exit(1);
  }
  saude.marcarBoot(process.pid);
  // Re-parear e a cura: se o marcador de pareamento e mais novo que a marca
  // de cegueira, o aparelho novo refez as chaves. Sem esta checagem no boot,
  // a campanha ficava bloqueada ate o primeiro heartbeat (5 min) depois de
  // um re-pareamento.
  if (saude.curarSeRepareou()) {
    log('[cegueira] aparelho re-pareado: a marca de cegueira foi removida.');
  }
  if (t.orfao) {
    log(`Arquivo de trava orfao (PID ${t.orfao} nao existe mais) - limpo.`);
  }

  for (const sinal of ['SIGINT', 'SIGTERM', 'exit']) {
    process.on(sinal, () => {
      // Timer de rajada vivo depois do shutdown dispara mensagem com o socket
      // morto (ou, pior, com o proximo que subir).
      rajada.limparTudo();
      lifecycle.parar();
      lifecycle.liberarTrava();
      if (sinal === 'exit') return;
      process.exit(0);
    });
  }
  process.on('uncaughtException', (e) => {
    log(`Erro fatal: ${e.message}`);
    rajada.limparTudo();
    lifecycle.liberarTrava();
    process.exit(1);
  });
  process.on('unhandledRejection', (motivo) => {
    log(`Promessa rejeitada sem tratamento: ${(motivo && motivo.stack) || motivo}`);
  });

  lifecycle.configurar({
    log,
    upsert: tratarUpsert,
    conexao: ({ estado, status, loggedOut }) => {
      if (estado === 'open') {
        saude.marcarConexao();
        log('Bia conectada e ouvindo respostas...');
      } else if (estado === 'close') {
        saude.marcarDesconexao(loggedOut ? 'loggedOut' : String(status));
      }
    },
  });

  try {
    await lifecycle.conectar();
  } catch (e) {
    log(`Falha na conexao inicial: ${e.message}`);
    lifecycle.liberarTrava();
    process.exit(1);
  }

  // O agendador nasce AQUI, uma vez so. Nada mais no projeto cria setInterval.
  lifecycle.iniciarAgendador();
  lifecycle.agendarIntervalo(
    () => {
      try {
        heartbeat();
      } catch (e) {
        log(`Erro no heartbeat: ${e.message}`);
      }
    },
    5 * 60 * 1000,
    'heartbeat'
  );
  log(`Agendador ativo (tick unico): heartbeat 5min. PID ${process.pid}.`);

  // Sonda de visao: roda de 5 em 5 min, mas so testa de fato quando a Bia esta
  // quieta (sem upsert) ha tempo. Separa "quieta" de "cega" e, confirmada a
  // cegueira, reinicia o processo (issue Baileys #2491).
  lifecycle.agendarIntervalo(
    () => {
      sondarVisao().catch((e) => log(`Erro na sonda: ${e.message}`));
    },
    5 * 60 * 1000,
    'sonda'
  );

  // Sonda de visao NO BOOT: 15 s depois de subir. A sonda periodica espera 15
  // min de silencio; no boot nao se espera nada - a sessao acabou de subir e
  // a pergunta "esta Bioga le?" e a primeira coisa a responder. E o que segura
  // a campanha antes de queimar a lista com uma sessao cega.
  lifecycle.agendarUnico(
    () => {
      sondarVisao({ forcar: true, ignorarQuietude: true }).catch((e) => log(`Erro na sonda de boot: ${e.message}`));
    },
    Date.now() + 15000,
    'sonda-boot'
  );

  // Teste de visao pedido pelo painel (botao "Testar visao agora"). O botao
  // grava data/sonda-agora e este vigia curto responde. O tick geral e de
  // 30 s; aqui e de 5 s porque o dono esta olhando a tela esperando.
  // Pedido velho (>2 min) e descartado: se o bot estava fora do ar quando o
  // botao foi clicado, nao faz sentido testar "agora" ao subir depois.
  const pedidoSonda = path.join(config.dataFolder, 'sonda-agora');
  lifecycle.agendarIntervalo(
    () => {
      let pedido = null;
      try {
        if (!fs.existsSync(pedidoSonda)) return;
        pedido = fs.readFileSync(pedidoSonda, 'utf8').trim();
        fs.unlinkSync(pedidoSonda);
      } catch (e) {
        log(`[sonda] pedido do painel ilegivel: ${e.message}`);
        return;
      }
      const quando = Date.parse(pedido);
      if (!Number.isNaN(quando) && Date.now() - quando > 2 * 60 * 1000) {
        log('[sonda] pedido do painel era antigo - descartado.');
        return;
      }
      sondarVisao({ forcar: true, ignorarQuietude: true, tipo: 'manual' })
        .then((r) => log(`[sonda] teste do painel: ${r.acao}${r.motivo ? ' (' + r.motivo + ')' : ''}`))
        .catch((e) => log(`Erro na sonda do painel: ${e.message}`));
    },
    5000,
    'sonda-pedido'
  );

  // Campanha: checa a cada 30s; o ritmo humano (config.repique.campanhaEntre*)
  // e quem espaça de verdade os envios. Fica registrada sempre - o interruptor
  // (data/campanha.ligada) e lido a cada volta, entao ligar/desligar no painel
  // funciona sem reiniciar.
  if (campanha.ligada()) {
    // Comeco levemente aleatorio para nao repetir o mesmo segundo todo dia.
    campanhaProximoEm = Date.now() + Math.floor(Math.random() * 10 * 60 * 1000);
  }
  lifecycle.agendarIntervalo(
    () => {
      rodarCampanha().catch((e) => log(`Erro na campanha: ${e.message}`));
    },
    30 * 1000,
    'campanha'
  );
  log(
    `Campanha ${campanha.ligada() ? 'LIGADA' : 'pausada'} ` +
      `(ate ${config.repique.porDia}/dia, ~${Math.round((config.repique.campanhaEntreMin + config.repique.campanhaEntreMax) / 120)}min entre envios).`
  );

  // Backup: a sessao (auth/) nao pode se perder se o PC for formatado. Roda
  // logo apos subir e 1x/dia as 03:00 (fora do expediente). Best-effort: falha
  // no backup nao derruba a Bia.
  const tentarBackup = (quando) => {
    try {
      const zip = backup.criar();
      log(`[backup] ${quando}: ${zip}`);
    } catch (e) {
      log(`[backup] ${quando} falhou: ${e.message}`);
    }
  };
  lifecycle.agendarUnico(() => tentarBackup('boot'), Date.now() + 8000, 'backup-boot');
  lifecycle.agendarDiario(() => tentarBackup('diario'), '03:00', 'backup');
}

// ============================================================
// Sonda de visao: separa "quieta" de "cega" (issue Baileys #2491).
//
// A sonda e a unica prova direta de que a sessao ainda decripta: a Bia manda
// um token para o proprio numero e o eco volta como messages.upsert.
//
// O que ela NAO faz: reiniciar o processo. O estado quebrado esta no disco
// (auth/pre-key-*.json); processo novo, socket novo, mesmo buraco. Em 19/10 o
// reinicio automatico encadeou 8 boots e 17 tentativas de pareamento em 80
// minutos sem curar nada. Quem decide e a pessoa: re-parear pelo painel.
//
// Quando a cegueira e confirmada, o bot MARCA (health.json), AVISA (log +
// painel) e PAUSA a campanha. Pausar e o que impede de queimar a lista: um
// repique enviado por uma sessao cega chega no cliente, a resposta se perde no
// buraco, e o contato fica marcado como "contatado" sem ninguem ter falado com
// ele. Quem leu uma mensagem de novo, cura.
// ============================================================

// A sonda manda mensagem para a propria Bia. Uma a cada 30 min ja e o
// suficiente para corroborar; mais que isso so enche o chat de ping.
const INTERVALO_SONDA_MIN = 30;
let ultimaSondaEm = 0;

// O alerta de "conta sob limitacao (428)" sai uma vez por estado, nao a cada
// heartbeat de 5 min.
let limitAvisado = false;

async function sondarVisao({ forcar = false, timeoutMs = undefined, ignorarQuietude = false, tipo = 'confirmacao' } = {}) {
  const sock = lifecycle.socket();
  if (!sock || lifecycle.estado() !== 'open') return { acao: 'sem_socket' };
  // Suspeita ainda pede confirmacao: so a cegueira CONFIRMADA encerra a
  // sondagem. Sem isso a primeira falha ficaria eterna e nunca viraria
  // veredito (e a sonda nao gasta nada da lista - ela fala com a propria Bia).
  // `forcar` (boot e botao do painel) tambem passa por cima do veredito: o
  // dono pediu o teste agora e merece a resposta de agora.
  const marcado = saude.ler();
  if (marcado.cegueira && marcado.cegueiraConfirmada && !forcar) {
    return { acao: 'ja_sabe_que_esta_cega' };
  }
  if (!forcar && Date.now() - ultimaSondaEm < INTERVALO_SONDA_MIN * 60000) {
    return { acao: 'aguardando' };
  }
  ultimaSondaEm = Date.now();

  const h = saude.ler();
  const janela = saude.avaliarSondagem({
    conectado: true,
    ultimoInboundEm: h.ultimoInboundEm,
    conectadoEm: h.conectadoEm,
  });
  // A sonda periodica espera a Bia ficar quieta (15 min sem ler nada). No boot
  // nao ha tempo a perder: subir e a prova de vida do aparelho, e a cegueira
  // precisa aparecer AGORA - e o que segura a campanha antes de queimar a
  // lista. Por isso o boot ignora a quietude.
  if (!ignorarQuietude && !janela.sondar) return { acao: 'ativa', minutos: janela.minutos };

  log(
    tipo === 'manual'
      ? '[sonda] teste pedido pelo painel - mandando mensagem para si mesma...'
      : `[sonda] quieta ha ${Math.floor(janela.minutos)} min - testando a visao...`
  );
  const r = await testarVisao(sock, { log, timeoutMs });
  if (r.ok) {
    const estavaCega = Boolean(saude.ler().cegueira);
    saude.marcarSonda({ tipo, ok: true });
    log(
      estavaCega
        ? '[sonda] o eco voltou: a sessao ainda decripta. Marca de cegueira removida (confirmado pela sonda).'
        : '[sonda] o eco voltou: a sessao ainda decripta.'
    );
    return { acao: 'ok', via: 'eco' };
  }
  if (r.motivo === 'ja_sondando') return { acao: 'ja_sondando' };
  if (r.motivo !== 'sem_eco') {
    // O teste nao chegou a ser feito (o socket caiu no meio da sonda). Isso
    // NAO e cegueira: e o teste que falhou. Sem veredito - e sem contar como
    // falha de sonda, senao dois tropecos viravam cegueira confirmada.
    saude.marcarSonda({ tipo: 'indisponivel', ok: false, contar: false });
    log(`[sonda] o teste de visao nao pode ser feito (${r.motivo}). Sem veredito.`);
    return { acao: 'indisponivel', motivo: r.motivo };
  }
  saude.marcarSonda({ tipo, ok: false });
  // A sonda e um teste de verdade: mandamos mensagem para a propria Bia e
  // esperamos o eco. Sem eco, a sessao NAO esta lendo. Isso e veredito, nao
  // suspeita - por isso a cegueira e REGISTRADA aqui. Antes ela so virava
  // linha de log, e o heartbeat seguinte (5 min) apagava a marca como se
  // "sem evidencia nova" fosse "recuperou".
  const falhas = saude.ler().sondaFalhas || 1;
  const confirmada = falhas >= 2;
  saude.registrarCegueira(
    true,
    confirmada ? 'sonda_sem_eco_confirmado' : 'sonda_sem_eco',
    confirmada
  );
  log(
    'ALERTA: CEGUEIRA ' +
      (confirmada ? 'CONFIRMADA' : 'SUSPEITA') +
      ' (a mensagem a si mesma nao voltou; falha ' +
      falhas +
      '). A campanha fica pausada. ' +
      'Re-parear a Bia pelo painel: reiniciar o processo nao conserta.'
  );
  return { acao: 'cego' };
}

// ============================================================
// Heartbeat: prova de vida de 5 em 5 min.
//
// E aqui que a cegueira vira VEREDITO. O "surdo" (ninguem falou ha 30 min)
// sozinho nao prova nada: empresa fechada e assim. O que prova cegueira e a
// combinacao de "chegou mensagem" + "nao deu para ler": o discriminador do
// saude.js.
// ============================================================
function heartbeat() {
  const h = saude.ler();
  const socketEstado = lifecycle.estado();
  const dados = {
    ultimaMsgRecebida: h.ultimoInboundEm || null,
    ultimoEnvio: h.ultimoEnvioEm || null,
    fila: lifecycle.pendentes(),
    timersAtivos: lifecycle.tarefasAtivas() + rajada.tamanho(),
    socketEstado,
    descartes: h.descartes || {},
  };
  const { surdo: surdoBruto, minutos } = saude.avaliarSurdez({
    conectado: socketEstado === 'open',
    ultimoInboundEm: h.ultimoInboundEm,
    conectadoEm: h.conectadoEm,
  });

  // O eco da sonda e um inbound `fromMe`: nao entra em ultimoInboundEm, mas E a
  // prova de que a sessao decripta. Sem isto, uma Bia saudavel e ociosa (ninguem
  // escreveu) ficava "surda" no heartbeat e disparava alerta/re-sonda a toa -
  // o mesmo alarme falso que fazia o operador re-parear sem necessidade.
  const sondaOkRecente =
    String(h.sondaResultado || '').endsWith(':ok') &&
    h.ultimaSondaEm &&
    Date.now() - Date.parse(h.ultimaSondaEm) < INTERVALO_SONDA_MIN * 60000;
  const surdo = surdoBruto && !sondaOkRecente;

  // O discriminador: chegou mensagem e nao decriptou?
  // Antes de avaliar, o re-pareamento e cure: aparelho novo refaz as chaves.
  if (saude.curarSeRepareou()) {
    log('[cegueira] aparelho re-pareado: a marca de cegueira foi removida.');
  }
  const vista = saude.avaliarCegueiraAtual({ conectado: socketEstado === 'open' });
  if (vista.cega) {
    const primeiraVez = !h.cegueira;
    saude.registrarCegueira(true, vista.motivo, true);
    if (primeiraVez) {
      log(
        `ALERTA: CEGUEIRA (${vista.motivo}) - mensagens chegam e nao decriptam ` +
          `(${vista.deltas.semCorpo} sem corpo, ${vista.deltas.falhasDecrypt} falhas de decrypt, ` +
          `${Math.floor(vista.minutos)} min sem ler nada). ` +
          'A campanha fica pausada ate a sessao voltar a ler.'
      );
    }
  } else if (h.cegueira) {
    // A marca so sai com PROVA de cura: a sessao leu uma mensagem (motivo
    // 'ouviu') ou o aparelho foi re-pareado (tratado acima).
    //
    // "Silencio" NAO cura cegueira: e o estado normal de uma empresa
    // fechada. Apagar a marca por causa dele fazia o alerta sumir 5 minutos
    // depois de aparecer - e era exatamente o que escondia a cegueira de
    // 22/10, com a sonda ja tendo confirmado a falha.
    if (vista.motivo === 'ouviu') {
      saude.marcarCegueiraCurada();
      log('[cegueira] a sessao voltou a ler. Marca removida; a campanha volta.');
    }
  }

  saude.registrarHeartbeat({ ...dados, surdo });
  log(`[heartbeat] ${JSON.stringify({ ...dados, surdo, cegueira: Boolean(saude.ler().cegueira) })}`);

  // O "surdo" so vira alerta quando a cegueira ainda NAO esta confirmada.
  // Quando o veredito e cegueira, o alerta de surdez seria contraditorio (a
  // cegueira ja explica o silencio) e a sonda nao precisa rodar de novo.
  const marcado = saude.ler();
  const cegaConfirmada = Boolean(marcado.cegueiraConfirmada);
  if (surdo && !cegaConfirmada) {
    log(
      `ALERTA: ligado, mas SURDO - socket=${socketEstado}, ` +
        `ultimo recebimento ${minutos == null ? 'nunca' : Math.floor(minutos) + ' min atras'}. ` +
        'A Bia envia e nao ouve. Ver npm run status.'
    );
    // A sonda corrobora o diagnostico. Ela NAO reinicia o processo: reiniciar
    // nao cura sessao quebrada, e o reinicio em loop era o que enchia o log de
    // 19/10 com 8 boots e 17 tentativas de pareamento em 80 minutos.
    sondarVisao().catch((e) => log(`Erro na sonda: ${e.message}`));
  } else if (surdo && cegaConfirmada) {
    log('[heartbeat] silencio com cegueira confirmada: sem alerta de surdez (o veredito e cegueira).');
  }

  // A conta sob limitacao do WhatsApp (428) e um problema DIFERENTE da
  // cegueira: nao e criptografia quebrada, e o WhatsApp barrando o numero.
  // A cura e re-parear a ponte e reduzir o ritmo de envio. Avisa uma vez
  // por estado.
  const limit = saude.avaliarLimitacao();
  if (limit.limitado && !limitAvisado) {
    limitAvisado = true;
    log(
      `ALERTA: CONTA SOB LIMITACAO DO WHATSAPP (428 x${limit.quantidade} em 30 min). ` +
        'O WhatsApp esta cortando a conexao: a sessao sobe e cai. ' +
        'A cura e RE-PAREAR (ponte nova) e reduzir o ritmo de envio.'
    );
  } else if (!limit.limitado) {
    limitAvisado = false;
  }
  return { ...dados, surdo, cegueira: Boolean(saude.ler().cegueira) };
}

module.exports = { notificarEquipe, processarRajada, processarMensagem, heartbeat, rodarCampanha, sondarVisao };

if (require.main === module) {
  main().catch((e) => {
    log(`ERRO FATAL em main(): ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
}
