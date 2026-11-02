'use strict';

// ============================================================
// As falas da Bia - padroes genericos, editaveis pelo config.local.js.
//
// Nada aqui e de um cliente. Quem usa troca os textos em `config.textos`
// (config.local.js) ou direto no painel, no caso da mensagem da campanha.
// O que estiver em config.textos ganha do padrao; o que faltar, continua
// valendo daqui - entao uma instalacao nova funciona sem configurar nada.
//
// Marcadores disponiveis em qualquer texto:
//
//   {nome}      primeiro nome da pessoa (so na mensagem do repique)
//   {botNome}   config.botNome
//   {empresa}   config.empresa
//   {assunto}   config.assunto ("nos nossos servicos", "nos cursos"...)
//   {endereco}  config.endereco
//
// Regras de conteudo que o check protege:
//   - mensagem curta (ate ~3 linhas), 1 pergunta por vez;
//   - nunca prometer preco, desconto, vaga ou emprego;
//   - nao insistir depois de "nao";
//   - quem pede para sair nao recebe mais nada.
// ============================================================

const config = require('./config');
const { limparNome, primeiroNome } = require('./nomes');

const PADRAO = {
  repique: {
    comNome: 'Oi, {nome}! Aqui é {botNome}, da {empresa}.\nVocê ainda tem interesse {assunto}?',
    semNome: 'Oi! Aqui é {botNome}, da {empresa}.\nVocê ainda tem interesse {assunto}?',
  },

  respostas: {
    interesse:
      'Que ótimo! Nossa equipe entra em contato com você para passar todas as ' +
      'informações. Obrigado(a)!',
    negacao:
      'Tudo bem! Obrigado(a) pela atenção. Se um dia fizer sentido, estamos aqui. ' +
      'Tenha um ótimo dia!',
    talvez:
      'Sem problema! Vou pedir para a nossa equipe te chamar e tirar suas ' +
      'dúvidas, sem compromisso. Qualquer coisa, é só me falar.',
    protocolo:
      'Por aqui eu sigo um roteiro padrão e não consigo responder outras coisas. ' +
      'Se ainda tiver interesse, me avisa que nossa equipe entra em contato com você.',
    // Usada quando a pessoa pergunta o endereco e o config.endereco esta vazio.
    enderecoVazio:
      'Essa informação eu não tenho por aqui. Vou pedir para a nossa equipe te ' +
      'passar os detalhes. Qualquer coisa, é só me chamar.',
    // Usada quando perguntam "de que empresa voces sao".
    sobre: 'Somos a {empresa}.',
  },

  // Aviso interno para a equipe. `modelo` monta o texto final; os campos
  // titulo/rodape/rotulo entram nele. Tudo pode ser trocado.
  avisos: {
    modelo: '{titulo}\n• {nome} — {numero}\n{rotulo}: "{texto}"\n{rodape}',
    tipos: {
      interesse: { titulo: 'Novo interesse!', rodape: 'Pode chamar.', rotulo: 'Respondeu' },
      talvez: { titulo: 'Em dúvida / analisando', rodape: 'Vale um retorno com calma.', rotulo: 'Respondeu' },
      indefinido: { titulo: 'Resposta indefinida', rodape: 'Confere se é pra encaminhar?', rotulo: 'Respondeu' },
      mensagem: {
        titulo: 'Nova mensagem',
        rodape: 'A Bia respondeu o automático. Confere se precisa de gente.',
        rotulo: 'Escreveu',
      },
      informacao: {
        titulo: 'Perguntou informações',
        rodape: 'A Bia não respondeu. Responda pelo seu celular.',
        rotulo: 'Escreveu',
      },
      fora_da_lista: {
        titulo: 'Mensagem de fora da lista',
        rodape: 'Não está na lista. Vê se vale responder.',
        rotulo: 'Escreveu',
      },
    },
  },
};

// Merge de dois niveis. `config.textos` pode trocar `respostas.interesse` sem
// repetir as outras respostas, e `avisos.tipos.interesse` sem repetir o resto.
function mesclar(base, extra) {
  const saida = { ...base };
  for (const [chave, valor] of Object.entries(extra || {})) {
    const atual = base[chave];
    const ehObjeto =
      valor && typeof valor === 'object' && !Array.isArray(valor) &&
      atual && typeof atual === 'object' && !Array.isArray(atual);
    saida[chave] = ehObjeto ? mesclar(atual, valor) : valor;
  }
  return saida;
}

let _textos = null;
function textos() {
  if (!_textos) _textos = mesclar(PADRAO, config.textos || {});
  return _textos;
}

// Recarrega os textos (o painel pode salvar config.local.js? nao - mas o
// campanha-mensagens.json e lido a cada envio; isto aqui e para teste).
function recarregar() {
  _textos = null;
}

function aplicar(texto, vars = {}) {
  const valores = {
    botNome: config.botNome,
    empresa: config.empresa,
    assunto: config.assunto,
    endereco: config.endereco,
    ...vars,
  };
  // Marcador desconhecido fica como esta (aparece no teste e no painel), em
  // vez de virar string vazia e esconder o erro.
  return String(texto || '').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, chave) =>
    valores[chave] == null ? m : String(valores[chave]),
  );
}

// ---------------- Repique ----------------

function repique(nome) {
  const t = textos().repique;
  const curto = primeiroNome(nome);
  if (!curto) return aplicar(t.semNome);
  return aplicar(t.comNome, { nome: curto });
}

// Modelo editavel no painel. O `{nome}` e o marcador que vira o primeiro nome
// da pessoa; a versao sem nome e usada quando a lista nao trouxe nome.
function repiqueModelo() {
  return { comNome: textos().repique.comNome, semNome: textos().repique.semNome };
}

// ---------------- Respostas ----------------

function interesse() {
  return aplicar(textos().respostas.interesse);
}

function negacao() {
  return aplicar(textos().respostas.negacao);
}

function talvez() {
  return aplicar(textos().respostas.talvez);
}

function protocolo() {
  return aplicar(textos().respostas.protocolo);
}

// Endereco e empresa: as duas perguntas que a Bia responde sozinha. Se o
// endereco nao foi configurado, ela nao inventa: devolve o texto de "nao
// tenho essa informacao" e a equipe assume.
function endereco() {
  if (!config.endereco) return aplicar(textos().respostas.enderecoVazio);
  return aplicar('Ficamos na {endereco}.');
}

function escola() {
  return aplicar(textos().respostas.sobre);
}

// ---------------- Aviso para a equipe ----------------

// "Maria Aparecida Silva" -> "Maria"; "Ana C. O." -> "Ana"; "💜 Ana" -> "Ana";
// "🌸🌸" -> null. O corte mora em nomes.js, junto da limpeza de emoji.
function avisoEquipe({ nome = null, numero = null, texto = '', tipo = 'interesse' } = {}) {
  const t = textos().avisos;
  const aviso = (t.tipos && t.tipos[tipo]) || t.tipos.interesse;
  const modelo = t.modelo || PADRAO.avisos.modelo;

  return aplicar(modelo, {
    titulo: aviso.titulo || '',
    rodape: aviso.rodape || '',
    rotulo: aviso.rotulo || 'Respondeu',
    nome: primeiroNome(nome) || '',
    numero: numero || '',
    texto: String(texto || '').trim().slice(0, 120),
  })
    // Linha que ficou so com o separador (sem nome nem numero) vira vazia.
    .split('\n')
    .filter((linha) => linha.trim() && !/^[•\-–—\s]+$/.test(linha.trim()))
    .join('\n');
}

module.exports = {
  PADRAO,
  textos,
  recarregar,
  repique,
  repiqueModelo,
  interesse,
  negacao,
  protocolo,
  talvez,
  endereco,
  escola,
  limparNome,
  primeiroNome,
  avisoEquipe,
  responder,
};

// Entrada unica por intent. NEUTRO nao aparece de proposito: a resposta
// depende de quantas mensagens neutras a pessoa ja mandou, e quem sabe disso
// e o bot.js.
function responder(intent) {
  const mapa = {
    INTERESSE: interesse,
    NEGACAO: negacao,
    TALVEZ: talvez,
    ENDERECO: endereco,
    ESCOLA: escola,
  };
  const fn = mapa[intent];
  return fn ? fn() : null;
}
