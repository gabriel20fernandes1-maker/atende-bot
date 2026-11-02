'use strict';

// ============================================================
// config.local.js - copie este arquivo como `config.local.js` e preencha.
//
//   cp config.local.example.js config.local.js
//
// Ele NAO vai para o git nem para o zip (ver .gitignore): e aqui que mora o
// que e seu - nome da empresa, equipe, endereco e textos. O config.js fica
// com os padroes genericos e seguros para publicar.
//
// Tudo o que voce nao escrever continua valendo o padrao do config.js.
// ============================================================

module.exports = {
  // Quem fala com a pessoa. Aparece como {botNome} nos textos.
  botNome: 'Ana',

  // Nome da empresa. Aparece como {empresa} nos textos.
  empresa: 'Minha Empresa',

  // O que entra na pergunta: "Você ainda tem interesse {assunto}?"
  assunto: 'nos nossos serviços',

  // Endereco completo, usado quando perguntarem "onde fica".
  // Vazio = a Bia nao responde endereco e a equipe assume.
  endereco: 'Rua Exemplo, 123 - Bairro - Cidade/UF',

  // Numero usado so no pareamento por codigo (npm run connect -- --pair).
  numeroPareamento: '5511900000000',

  // ============================================================
  // ESCOPO - quem NUNCA entra na campanha.
  // Pode ser string ('5511900000000') ou { numero, nome }.
  // ============================================================
  escopo: {
    equipe: [{ numero: '5511900000000', nome: 'Fulano' }],
  },

  // ============================================================
  // REPIQUE
  //
  // ATENCAO: numero novo = no maximo 20 por dia. Suba no maximo 10 a cada
  // 3-4 dias de uso normal. Volume alto e o que mais derruba conta.
  // ============================================================
  repique: {
    porDia: 20,
    intervaloMin: 20,
    intervaloMax: 45,
    campanhaEntreMin: 100,
    campanhaEntreMax: 155,
    imagemChance: 1,
  },

  // Horario de funcionamento (= janela de envio).
  atendimento: {
    dias: {
      0: null,
      1: { abre: '09:00', fecha: '18:00' },
      2: { abre: '09:00', fecha: '18:00' },
      3: { abre: '09:00', fecha: '18:00' },
      4: { abre: '09:00', fecha: '18:00' },
      5: { abre: '09:00', fecha: '18:00' },
      6: { abre: '09:00', fecha: '14:00' },
    },
  },

  // ============================================================
  // TEXTOS - tudo o que a Bia fala e tudo o que ela avisa para a equipe.
  //
  // Marcadores: {nome} {botNome} {empresa} {assunto} {endereco}
  //
  // O que nao estiver aqui usa o padrao do templates.js.
  // ============================================================
  textos: {
    repique: {
      comNome: 'Oi, {nome}! Aqui é {botNome}, da {empresa}.\nVocê ainda tem interesse {assunto}?',
      semNome: 'Oi! Aqui é {botNome}, da {empresa}.\nVocê ainda tem interesse {assunto}?',
    },

    respostas: {
      interesse: 'Que ótimo! Nossa equipe entra em contato para passar as informações. Obrigado(a)!',
      negacao: 'Tudo bem! Obrigado(a) pela atenção. Tenha um ótimo dia!',
      talvez: 'Sem problema! Vou pedir para a equipe te chamar, sem compromisso.',
      protocolo: 'Por aqui eu sigo um roteiro padrão e não consigo responder outras coisas.',
      enderecoVazio: 'Essa informação eu não tenho por aqui. A equipe te passa os detalhes.',
      sobre: 'Somos a {empresa}.',
    },

    avisos: {
      // Modelo do aviso interno. Deixe uma linha por informação.
      modelo: '{titulo}\n• {nome} — {numero}\n{rotulo}: "{texto}"\n{rodape}',
      tipos: {
        interesse: { titulo: 'Novo interesse!', rodape: 'Pode chamar.', rotulo: 'Respondeu' },
        talvez: { titulo: 'Em dúvida', rodape: 'Vale um retorno com calma.', rotulo: 'Respondeu' },
        indefinido: { titulo: 'Resposta indefinida', rodape: 'Confere se é pra encaminhar?', rotulo: 'Respondeu' },
        mensagem: { titulo: 'Nova mensagem', rodape: 'Confere se precisa de gente.', rotulo: 'Escreveu' },
        informacao: { titulo: 'Perguntou informações', rodape: 'Responda pelo seu celular.', rotulo: 'Escreveu' },
        fora_da_lista: { titulo: 'Fora da lista', rodape: 'Vê se vale responder.', rotulo: 'Escreveu' },
      },
    },
  },

  // Privacidade: apaga lista/feed/logs ao desligar e limpa sessao velha no boot.
  privacidade: {
    limparAoEncerrar: true,
    maxHorasSessao: 24,
  },
};
