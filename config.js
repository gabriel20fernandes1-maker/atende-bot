'use strict';

// ============================================================
// Configuracao da Bia.
//
// Tres camadas, nesta ordem (a de baixo sobrescreve a de cima):
//
//   1. este arquivo            -> padroes genericos, seguros para publicar
//   2. config.local.js         -> o que e SEU (empresa, equipe, endereco,
//                                 textos). Nao vai para o git nem para o zip.
//   3. variaveis de ambiente   -> BIA_* (as antigas ALLNET_* continuam
//                                 aceitas para nao quebrar instalacao velha)
//
// Regra: nenhum dado de cliente mora neste arquivo. Nome de empresa, endereco,
// telefone da equipe e textos sao do config.local.js - veja o exemplo em
// config.local.example.js.
//
// Onde os arquivos ficam: fora do projeto (privacidade.js). Sessao do WhatsApp,
// lista de contatos e estado nunca entram no repositorio nem no pacote.
// ============================================================

const path = require('path');
const privacidade = require('./privacidade');

// Aceita o nome novo e o antigo. O antigo existe porque instalacoes em
// producao usam ALLNET_* nos atalhos e no watchdog.
function env(nome, legado) {
  if (process.env[nome] != null && process.env[nome] !== '') return process.env[nome];
  if (legado && process.env[legado] != null && process.env[legado] !== '') return process.env[legado];
  return null;
}

function numero(valor, padrao) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
}

// Move auth/, data/ e backups/ que ficaram dentro do projeto nas versoes
// antigas. Roda uma vez; depois disso a pasta do codigo so tem codigo.
// `BIA_MIGRAR=0` desliga (usado pelos testes, para nao mexer em instalacao real).
if (env('BIA_MIGRAR', 'ALLNET_MIGRAR') !== '0') privacidade.migrarLegado(__dirname);

// Pasta de dados. `BIA_DATA_DIR` aponta para outro lugar (suite de teste,
// copia de cliente) sem encostar na producao.
const DATA_DIR = env('BIA_DATA_DIR', 'ALLNET_DATA_DIR') || path.join(privacidade.HOME_DIR, 'data');
const AUTH_DIR = env('BIA_AUTH_DIR', 'ALLNET_AUTH_DIR') || path.join(privacidade.HOME_DIR, 'auth');

// Padroes que o config.local.js pode sobrescrever.
const PADRAO = {
  // Identidade do atendente. `{botNome}` e `{empresa}` aparecem nos textos.
  botNome: 'Atendimento',
  empresa: 'Minha Empresa',

  // O que a empresa oferece, na forma que entra na pergunta do repique:
  // "Você ainda tem interesse {assunto}?" -> "... nos nossos serviços?".
  assunto: 'nos nossos serviços',

  // Numero usado SO no pareamento por codigo (npm run connect -- --pair).
  // Nao e lista de envio: quem recebe o repique esta em data/numeros.txt.
  numeroPareamento: env('BIA_NUMERO', 'ALLNET_NUMERO') || '',

  // Fuso usado para decidir dia e hora (janela de atendimento, saudacao).
  // Fonte UNICA: so atendimento.js le o relogio, e sempre por aqui.
  fuso: 'America/Sao_Paulo',

  // Endereco usado quando a pessoa pergunta "onde fica". Vazio = a Bia nao
  // responde endereco (encaminha para a equipe). Preencha no config.local.js.
  endereco: '',

  // ============================================================
  // ESCOPO - quem a Bia pode contatar.
  //
  // A lista de repique e o arquivo data/numeros.txt (um numero E.164 por
  // linha, nome opcional depois do ';'). Quem estiver ali recebe UMA mensagem
  // perguntando se ainda tem interesse, e nada mais.
  //
  // `equipe` e separada de proposito: quem trabalha com voce NUNCA entra na
  // campanha. So recebe o aviso interno de quem respondeu. Se o numero da
  // equipe aparecer em numeros.txt, o leitor recusa a linha.
  // ============================================================
  escopo: {
    equipe: [],
  },

  // Aviso no WhatsApp para quem escreve de FORA da lista (a "olhada").
  // Desligado por padrao: em numero pessoal isso vira ruido.
  avisarForaDaLista: false,

  // Horario de funcionamento. E TAMBEM a janela de envio do bot.
  //   0 domingo (null = fechado) ... 6 sabado
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
  // REPIQUE - o disparo em lote.
  //
  // `intervaloMin/Max` e o silencio (em segundos) entre um numero e o
  // seguinte. Nao e capricho: disparo em rajada e o caminho mais rapido para
  // o WhatsApp bloquear o numero. A variacao aleatoria imita uso humano.
  //
  // `porDia` e o teto diario e PODE ser mudado (BIA_POR_DIA ou config.local).
  //
  //   >>> RECOMENDACAO FORTE: numero novo = no maximo 20 por dia. <<<
  //
  // O WhatsApp pontua o numero por comportamento. Volume alto em numero sem
  // historico e o que mais derruba conta. Comece com 20, suba no maximo 10 a
  // cada 3 ou 4 dias de uso normal, e nunca mande para lista fria: quem nao
  // espera a mensagem denuncia, e denuncia derruba mais rapido que volume.
  // ============================================================
  repique: {
    // Disparo manual (repicar.js / falar.js): silencio entre um numero e outro.
    intervaloMin: 20,
    intervaloMax: 45,

    // Teto diario da campanha. 20 e o numero seguro para um numero novo.
    porDia: 20,

    // Ritmo "humano" entre um envio e outro da campanha, em segundos.
    campanhaEntreMin: 100,
    campanhaEntreMax: 155,

    // Chance de o repique levar uma imagem sorteada de data/imagens/.
    // 1 = sempre; 0 = so texto.
    imagemChance: 1,
  },

  // ============================================================
  // TEXTOS - tudo o que a Bia fala e tudo o que ela avisa para a equipe.
  //
  // Este objeto e o PONTO DE EDICAO. Cada chave sobrescreve o padrao do
  // templates.js; o que faltar continua valendo. Marcadores disponiveis:
  //
  //   {nome}      primeiro nome da pessoa
  //   {botNome}   config.botNome
  //   {empresa}   config.empresa
  //   {endereco}  config.endereco
  //
  // Estrutura (veja config.local.example.js para o exemplo preenchido):
  //
  //   textos.repique      -> { comNome, semNome }
  //   textos.respostas    -> { interesse, negacao, talvez, protocolo }
  //   textos.avisos       -> { interesse: { titulo, rodape, rotulo }, ... }
  //
  // Sem nada aqui, valem os textos genericos do templates.js.
  // ============================================================
  textos: {},

  // ============================================================
  // PRIVACIDADE
  //
  // `limparAoEncerrar` apaga lista, feed e logs quando o operador desliga a
  // Bia (controle.js descer / atalho "Desligar"). Nome e telefone sao dado de
  // SESSAO: o que precisa sobreviver e so a memoria de quem pediu para sair,
  // gravada como hash em supridos.txt.
  //
  // `maxHorasSessao` apaga a sessao anterior no boot se ela ficou parada mais
  // que isso (protege o caso "esqueci o painel aberto").
  // ============================================================
  privacidade: {
    limparAoEncerrar: true,
    maxHorasSessao: privacidade.MAX_IDADE_SESSAO_H,
  },

  // Pasta onde a sessao autenticada e salva (depois do QR, nao pede de novo).
  // Fora do projeto: o zip nunca leva sessao do WhatsApp.
  authFolder: AUTH_DIR,

  // Estado dos contatos e arquivos da sessao.
  dataFolder: DATA_DIR,
  estadoArquivo: path.join(DATA_DIR, 'estado.json'),
  numerosArquivo: path.join(DATA_DIR, 'numeros.txt'),
  supridosArquivo: path.join(DATA_DIR, 'supridos.txt'),

  // Backup da sessao + estado. `BIA_BACKUP_DIR` troca o destino e
  // `backupManter` e a retencao.
  backupFolder:
    env('BIA_BACKUP_DIR', 'ALLNET_BACKUP_DIR') || path.join(privacidade.HOME_DIR, 'backups'),
  backupManter: 14,

  // Anti-ban: "digitando" antes de cada mensagem (segundos)
  typingMin: 10,
  typingMax: 30,

  // Silencio que fecha uma rajada. A pessoa manda "sim" e "quanto custa"
  // colados; a Bia espera este tempo e responde UMA vez. Ver rajada.guard.js.
  rajadaSegundos: 8,

  // Se true, ignora APENAS o horario de funcionamento. Nunca o escopo.guard.
  forcarForaDaJanela: env('BIA_FORCAR', 'ALLNET_FORCAR') === '1',

  // Relogio falso, so para teste da janela (npm run check). Nao mexe no
  // escopo nem no classificador. "HH:MM" e dia da semana 0-6.
  horaDeTeste: env('BIA_AGORA', 'ALLNET_AGORA') || null,
  diaDeTeste: env('BIA_DIA', 'ALLNET_DIA') != null ? Number(env('BIA_DIA', 'ALLNET_DIA')) : null,
};

// Merge raso por grupo: `config.local.js` pode trocar uma chave de `repique`
// sem repetir as outras. Arrays (equipe) sao substituidos, nao concatenados -
// lista de equipe pela metade e pior que lista nenhuma.
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

function carregarLocal() {
  const arquivo = path.join(__dirname, 'config.local.js');
  try {
    return require(arquivo);
  } catch (e) {
    // MODULE_NOT_FOUND aqui e o caso normal: a maioria das instalacoes roda
    // com os padroes. Qualquer outro erro e um config.local.js quebrado, e a
    // mensagem precisa dizer isso - senao o dono acha que o bot morreu sozinho.
    if (e.code !== 'MODULE_NOT_FOUND') {
      console.error(`[config] config.local.js invalido: ${e.message}`);
    }
    return {};
  }
}

const config = mesclar(PADRAO, carregarLocal());

// Teto diario vindo do ambiente (atalho para quem nao quer editar arquivo).
const porDia = env('BIA_POR_DIA', 'ALLNET_POR_DIA');
if (porDia != null) config.repique.porDia = Math.max(1, Math.floor(numero(porDia, config.repique.porDia)));

// Um numero novo com teto alto e o erro mais caro do projeto. Avisa uma vez,
// no boot, sem impedir: quem sabe o que esta fazendo segue em frente.
config.avisarQuota = () => {
  if (config.repique.porDia > 20) {
    console.warn(
      `[config] repique.porDia = ${config.repique.porDia}. ` +
        'Acima de 20 por dia o risco de bloqueio do numero sobe muito, ' +
        'principalmente em numero novo. Veja o README.',
    );
  }
};

module.exports = config;
