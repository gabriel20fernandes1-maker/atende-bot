'use strict';

// ============================================================
// Classificador de respostas da Bia - repique.
//
// A pessoa recebeu "voce ainda tem interesse nos cursos da empresa?". A
// resposta cai em UMA destas faixas:
//
//   NEGACAO    -> a Bia agradece e se despede. Nunca mais contata.
//   INTERESSE  -> a Bia avisa que a equipe entra em contato e avisa a equipe.
//   TALVEZ     -> hesitacao a brasileira ("talvez", "vou pensar", "estou
//                 analisando"). A Bia responde com acolhimento e AVISA a
//                 equipe: e um lead morno, nao um "nao" nem um "sim".
//   INFORMACAO -> pergunta que a Bia NAO responde (preco, horario, quais
//                 cursos, detalhes). Ela fica calada e avisa a equipe, que
//                 responde pelo mesmo celular da Bia. Nada de protocolo.
//   ENDERECO   -> "onde fica": a Bia responde o endereco.
//   ESCOLA     -> "de que empresa": a Bia responde o texto configurado.
//   NEUTRO     -> a Bia responde o texto de protocolo; na 2a vez, avisa a equipe.
//
// Regra de ouro da prioridade: NEGACAO ganha de INTERESSE, que ganha de
// INFORMACAO, que ganha de TALVEZ. Sem isso, "nao quero, obrigado" - que casa
// com "nao quero" e com "obrigado" - viraria interesse; e "talvez, quanto
// custa?" cairia em TALVEZ mesmo com a pessoa pedindo preco (que agora vai
// para a equipe).
//
// A ordem executavel e:
//
//   NEUTRO_FORTE ("nao entendi", "como assim", "repita")
//     -> NEGACAO -> INTERESSE -> INFORMACAO -> TALVEZ
//     -> ENDERECO -> ESCOLA -> NEUTRO (fallback)
//
// NEUTRO_FORTE existe porque "nao" sozinho e negacao, mas "nao entendi" e
// duvida: a pessoa nao recusou nada, so nao entendeu. Sem essa camada, o
// `nao` curto engoliria a duvida e a Bia se despediria de quem so perguntou.
//
// Sobre "no momento...": NAO vira TALVEZ sozinho. "No momento estou
// analisando" e hesitacao; "no momento estou interessado apenas em finalizar
// meu curso atual" e um nao com contexto. Quem decide e o que vem depois -
// por isso o contexto de "outro curso/faculdade" esta em NEGACAO.
//
// Este arquivo nao faz I/O e nao importa config: e puro, para poder ser
// testado sozinho (tests/classificador.test.js).
// ============================================================

const INTENTS = {
  NEGACAO: 'NEGACAO',
  INTERESSE: 'INTERESSE',
  TALVEZ: 'TALVEZ',
  INFORMACAO: 'INFORMACAO',
  ENDERECO: 'ENDERECO',
  ESCOLA: 'ESCOLA',
  NEUTRO: 'NEUTRO',
};

// NEGACAO antes de INTERESSE, INTERESSE antes de INFORMACAO, INFORMACAO antes
// de TALVEZ (pedido de info explicito vence hesitacao). NEUTRO nao entra
// aqui: e o fallback resolvido no fim de classificar().
const ORDEM_PRIORIDADE = [
  INTENTS.NEGACAO,
  INTENTS.INTERESSE,
  INTENTS.INFORMACAO,
  INTENTS.TALVEZ,
  INTENTS.ENDERECO,
  INTENTS.ESCOLA,
];

// ---------------- Camada 1: normalizacao ----------------

const GIRIAS = [
  [/\bpq\b/g, 'porque'],
  [/\bvc\b/g, 'voce'],
  [/\bvcs\b/g, 'voces'],
  [/\bq\b/g, 'que'],
  [/\bqto\b/g, 'quanto'],
  [/\bqnt\b/g, 'quanto'],
  [/\bblz\b/g, 'beleza'],
  [/\bvlw\b/g, 'valeu'],
  [/\bkk+\b/g, 'riso'],
  [/\b(ha+)+\b/g, 'riso'],
];

function normalizar(entrada) {
  let t = String(entrada == null ? '' : entrada);

  // emoji solto e simbolos nao carregam intencao - remove antes de casar
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, ' ');

  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.toLowerCase();
  t = t.replace(/[!?.,;:*_~^=<>[\]{}()\\/|'"`+-]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();

  for (const [rx, troca] of GIRIAS) t = t.replace(rx, troca);

  return t.replace(/\s+/g, ' ').trim();
}

// ---------------- Camada 2: padroes ----------------
//
// Entrada: regex, ou { rx, curto } quando o padrao so vale em mensagem curta.
// O `curto` protege palavras ambiguas: "depois" e negacao em "depois eu vejo",
// mas em "quero ver o valor depois das 18h" e interesse - e o interesse casa
// pelo "valor", nao pelo "depois".

const PADROES = {
  // Duvida nao e recusa. Avaliado ANTES da negacao.
  [INTENTS.NEUTRO]: [
    /\bnao (entendi|compreendi|percebi|consegui|ouvi|vi)\b/,
    /\bcomo assim\b/,
    /\bnao (e|foi) bem assim\b/,
    /\brepit\w*\b/,
    /\bmanda (de novo|outra vez)\b/,
    /\bfala (de novo|novamente|mais alto|mais forte)\b/,
    /\bque foi isso\b/,
    /\bhein\b/,
    { rx: /\bde novo\b/, curto: 14 },
    { rx: /^(o )?que\??$/, curto: 10 },
  ],

  [INTENTS.NEGACAO]: [
    // "nao" sozinho so vale em mensagem curta: em "nao sei quanto custa" o que
    // vale e o preco (INTERESSE).
    { rx: /\bnao\b/, curto: 12 },
    /\bnao quero\b/,
    /\bnao tenho (interesse|interesse nenhum)\b/,
    /\bsem interesse\b/,
    /\bnao me interessa\b/,
    /\bnao faz sentido\b/,
    /\bprefiro nao\b/,
    /\bmelhor nao\b/,
    { rx: /\bdeixa\b/, curto: 12 },
    /\bdispensad[oa]\b/,
    /\bdispenso\b/,
    /\bnao obrigad[oa]\b/,
    /\bnao precisa\b/,
    /\bnao vou\b/,
    /\bnao da\b/,
    /\bja (tenho|fiz|fiz o curso|conheco)\b/,
    /\b(outra|outro) (escola|curso|lugar|local)\b/,
    // Contexto importa: "no momento..." sozinho nao decide. Estar focado em
    // OUTRO curso/faculdade e um "nao agora", nao uma hesitacao. Estes padroes
    // vem ANTES do "curso" generico do INTERESSE, senao a pessoa que diz
    // "interessado apenas em finalizar meu curso atual" seria tratada como
    // interessada nos nossos cursos.
    /\b(apenas|somente|so) (em |quero )?(finalizar|terminar|concluir)\b/,
    /\b(finalizar|terminar|concluir|acabar) (meu|o) (curso|faculdade|graduacao|pos)\b.*\b(atual|particular|mesmo)\b/,
    /\b(estou|to) (focad|concentrad)\w*\b/,
    /\b(no momento|por enquanto|por agora) (nao|prefiro|passo|fico)\b/,
    /\bja estou (fazendo|cursando|no)\b/,
    /\bnao (agora|no momento)\b/,
    { rx: /\bdepois\b/, curto: 20 },
    { rx: /\bmais tarde\b/, curto: 20 },
    { rx: /\bsem tempo\b/, curto: 20 },
    /\bsemana que vem\b/,
    /\bproxima semana\b/,
    /\bocupad[oa]\b/,
    /\bcancel(a|o|ar|ado|ando)?\b/,
    /\bdesisti?\b/,
    /\bdesist(e|ir|o)?\b/,
    // Opt-out: a Bia obedece em silencio, mas nunca ensina o comando.
    /\bsair\b/,
    /\bpare\b/,
    { rx: /^para\s*$/, curto: 6 },
    /\bpara de (me|escrever|mandar|chamar)\b/,
    /\bchega\b/,
    /\bdeixa de me\b/,
    /\bnao me (chama|manda|liga|escreve)\b/,
    /\bnao (quero|preciso) (mais )?receber\b/,
    /\b(tira|remova|remover|remove) (meu|o meu)? ?(numero|contato)?\b/,
    /\bdescadastr(a|ar|e|ou)\b/,
    /\bunsubscribe\b/,
    /\bcansad[oa]\b/,
    /\bcansei\b/,
    // Reclamacao forte: tambem e "nao me perturbe".
    /\bnao (pedi|solicitei|contratei|autorizei)\b/,
    /\bnao fui eu\b/,
    /\b(spam|propaganda)\b/,
    /\bme (incomoda|chateia|enche|atormenta)\b/,
  ],

  // Hesitacao a brasileira. O povo raramente diz "sim" ou "nao": diz "talvez",
  // "vou pensar", "estou analisando". Isto NAO e "nao" (ninguem recusou) e
  // tambem nao e "sim" (nao pediu nada): e um lead morno, que merece resposta
  // acolhedora e um aviso a equipe. Sem esta faixa, tudo caia no protocolo frio.
  //
  // Fora daqui de proposito: "no momento" sozinho (o que vem depois decide) e
  // "depois" (que continua sendo negativa, ver o README).
  [INTENTS.TALVEZ]: [
    /\btalvez\b/,
    /\bquem sabe\b/,
    /\bindecis[oa]\b/,
    /\bdepende\b/,
    /\b(quero|vou|vamos|preciso|deixa (eu|me)) pensar\b/,
    /\b(vou|vamos) (ver|avaliar|analisar|pensar)\b/,
    /\bvou dar uma olhada\b/,
    /\b(estou|to) (analisando|avaliando|vendo|pensando|pesquisando|verificando)\b/,
    /\banalisando\b/,
    /\bavaliando\b/,
    /\bpreciso (conversar|ver|checar|pensar melhor)\b/,
    /\bme da um tempo\b/,
    /\bmais (pra|para) frente\b/,
    /\bfuturamente\b/,
    /\b(te|eu) (aviso|falo|chamo)\b/,
    /\b(qualquer (coisa|hora|momento)) (eu )?(te )?(aviso|falo|chamo)\b/,
  ],

  [INTENTS.INTERESSE]: [
    // Afirmacao. Perguntas de info NAO ficam aqui: elas tem faixa propria
    // (INFORMACAO) e vao para a equipe, sem resposta automatica.
    // Reacoes vagas (legal, gostei, interessante) foram movidas para NEUTRO
    // para evitar falsos positivos. A equipe acompanha pelo painel.
    /\bsim\b/,
    /\bclaro\b/,
    /\bcom certeza\b/,
    /\bquero\b/,
    /\btenho interesse\b/,
    /\bme interess\w*\b/,
    /\binteresse\b/,
    /\bestou procurando\b/,
    /\bprocur(o|ando) (curso|cursos|um curso|informacao)\b/,
    /\bpesquisei sobre\b/,
  ],

  // Pergunta que a Bia NAO responde: preco, horario, turma, quais cursos,
  // detalhes. Ela fica calada (nem protocolo) e a equipe responde pelo
  // celular da Bia. Por isso este intent vem ANTES de TALVEZ: "talvez, quanto
  // custa?" e, antes de tudo, um pedido de preco.
  [INTENTS.INFORMACAO]: [
    // Pedido explicito de informacao
    /\b(pode|consegue|poderia) (me )?(explicar|contar|falar|mandar|passar|enviar|dizer|informar)\b/,
    /\bme (fala|conta|explica|diz|manda)\b/,
    /\bmanda mais\b/,
    /\binformacao\b/,
    /\binformacoes\b/,
    /\bdetalhes?\b/,
    /\bcomo funciona\b/,
    // Perguntas de valor
    /\bquanto custa\b/,
    /\bquanto (e|fica|sai|custa)\b/,
    /\bquanto (por mes|a vista|vou pagar)\b/,
    /\bqual (o |a )?valor\b/,
    /\bvalor(es)?\b/,
    /\bpreco(s)?\b/,
    /\bmensalidade\b/,
    /\binvestimento\b/,
    /\bparcela(r|do|s)?\b/,
    // Cursos e matricula
    /\bquais (cursos|sao|opcoes)\b/,
    /\bque cursos\b/,
    /\b(o que|quais) (voces )?(tem|oferecem|fazem)\b/,
    /\btem curso de\b/,
    /\bcurso de\b/,
    /\bcursos?\b/,
    /\bmatricula(r)?\b/,
    /\binscri(cao|coes|to|tos)\b/,
    /\baula (experimental|de teste|gratis|gratuita)\b/,
    /\bexperimental\b/,
    /\bexperimentar\b/,
    // Horario, turma, vaga
    /\bque horas\b/,
    /\bhorarios?\b/,
    /\b(abre|fecha)\b/,
    /\bturmas?\b/,
    /\b(vaga|vagas)\b/,
    /\bqual dia\b/,
    /\bque dia\b/,
    /\bquando (comeca|inicia|tem)\b/,
    // Vocabulario de curso
    /\binformatica\b/,
    /\bmaker\b/,
    /\bingles\b/,
    /\bgestao\b/,
    /\bempresarial\b/,
    /\bkids\b/,
    /\bteens\b/,
    /\badultos\b/,
    /\bcanva\b/,
    /\bgmail\b/,
    /\bworkspace\b/,
    /\bvideo\b/,
  ],

  // "Onde fica" a Bia responde sozinha. Vem antes de ESCOLA: "onde fica a
  // escola" e pedido de endereco, nao de apresentacao.
  [INTENTS.ENDERECO]: [
    /\bonde (fica|e|voces|sao|estao|se localiza)\b/,
    /\bfica (onde|aonde|em)\b/,
    /\bendereco\b/,
    /\blocalizacao\b/,
    /\bcomo chego\b/,
    /\bcomo (vou |chego )?ate\b/,
    /\bqual (o |a )?(local|endereco)\b/,
    /\bponto de referencia\b/,
    /\bperto de\b/,
    /\bque (bairro|lugar)\b/,
  ],

  // "De que empresa" tambem e resposta da Bia (config.textos.respostas.sobre).
  // Vem por ultimo entre as perguntas para nao engolir "onde fica a escola"
  // (ENDERECO) nem "a escola tem curso de ingles" (INFORMACAO).
  [INTENTS.ESCOLA]: [
    /\b(de |em )?qual (a |e a )?escola\b/,
    /\bque (tipo de )?escola\b/,
    /\bescola\b/,
    /\bvoces (sao|pertencem|fazem parte)\b/,
    /\bempresa\b/,
    /\binstituicao\b/,
    /\bloja\b/,
    /\bnegocio\b/,
    /\bha quanto tempo (existe|esta no mercado|trabalha)\b/,
  ],
};

function casa(intent, texto, tamanho) {
  for (const padrao of PADROES[intent] || []) {
    if (padrao.curto != null) {
      if (tamanho <= padrao.curto && padrao.rx.test(texto)) return true;
    } else if (padrao.test(texto)) {
      return true;
    }
  }
  return false;
}

// ---------------- Camada 3: prioridade ----------------

function classificar(entrada) {
  const texto = normalizar(entrada);
  if (!texto) return { intent: INTENTS.NEUTRO, confianca: 0 };

  // Duvida vem antes: "nao entendi" nao e "nao quero".
  if (casa(INTENTS.NEUTRO, texto, texto.length)) {
    return { intent: INTENTS.NEUTRO, confianca: 1 };
  }

  for (const intent of ORDEM_PRIORIDADE) {
    if (casa(intent, texto, texto.length)) {
      return { intent, confianca: 1 };
    }
  }

  return { intent: INTENTS.NEUTRO, confianca: 0.3 };
}

module.exports = {
  INTENTS,
  ORDEM_PRIORIDADE,
  PADROES,
  normalizar,
  classificar,
};
