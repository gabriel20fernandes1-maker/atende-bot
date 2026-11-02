'use strict';

// ============================================================
// `npm run status` - a Bia esta funcionando?
//
// Nasceu do incidente de 29/09. A pergunta "a Bia esta respondendo?" nao tinha
// resposta curta: o processo estava vivo, conectado, enviando o re-ask - e
// completamente cego, sem decriptar um unico inbound. Ler o bot.log nao
// ajudava: eram 1452 linhas de erro do libsignal escondendo o fato.
//
// Aqui a resposta sai em 4 linhas, com veredito. A distincao que importa:
//
//   VIVA   = processo de pe e conexao aberta
//   OUVINDO= e, alem disso, decriptou alguma coisa ha pouco
//
// Uma Bia VIVA e nao OUVINDO e o pior estado: ela envia e nao responde. E o
// estado que passou despercebido o dia inteiro.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');
const trava = require('./pid.lock');
const saude = require('./saude');

const ARQ_SAUDE = path.join(config.dataFolder, 'health.json');

// Limite para considerar que a Bia parou de ouvir. Nao e um numero magico de
// performance: e o tempo que a gente aceita ficar sem saber que quebrou.
const LIMITE_INBOUND_MIN = 30;
const LIMITE_SAUDE_MIN = 5;

const cor = (codigo, texto) => `\x1b[${codigo}m${texto}\x1b[0m`;
const verde = (t) => cor('32', t);
const amarelo = (t) => cor('33', t);
const vermelho = (t) => cor('31', t);
const fraco = (t) => cor('90', t);

function minutosDesde(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 60000;
}

function ha(min) {
  if (min == null) return 'nunca';
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `ha ${Math.floor(min)} min`;
  if (min < 60 * 24) return `ha ${Math.floor(min / 60)} h`;
  return `ha ${Math.floor(min / (60 * 24))} dias`;
}

function lerJson(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    // silencio-ok: e leitura de diagnostico; ausente/invalido vira null e o
    // status reporta "sem dados", que e a verdade.
    return null;
  }
}

function main() {
  const linhas = [];
  const problemas = [];

  const pidArquivo = trava.ler();
  const vivo = trava.existe();
  const h = lerJson(ARQ_SAUDE) || {};

  // 1) Processo.
  if (!pidArquivo) {
    linhas.push(`${vermelho('PARADA')}  nenhum bot.pid - a Bia nao esta rodando`);
    problemas.push('processo');
  } else if (!vivo) {
    linhas.push(`${vermelho('MORTA')}   bot.pid aponta para ${pidArquivo}, mas esse processo nao existe (trava orfa)`);
    problemas.push('processo');
  } else {
    const iniciado = minutosDesde(h.iniciadoEm);
    linhas.push(`${verde('VIVA')}    PID ${pidArquivo}${iniciado != null ? `, de pe ${ha(iniciado).replace('ha ', 'ha ')}` : ''}`);
  }

  // 2) Saude recente. health.json so e reescrito pela Bia viva; se esta velho,
  //    ou a Bia morreu, ou a versao dela e anterior a este arquivo.
  const idadeSaude = fs.existsSync(ARQ_SAUDE)
    ? (Date.now() - fs.statSync(ARQ_SAUDE).mtimeMs) / 60000
    : null;

  if (!h.iniciadoEm) {
    linhas.push(`${amarelo('SAUDE')}   sem health.json - bot antigo ou nunca subiu com esta versao`);
  } else if (idadeSaude != null && idadeSaude > LIMITE_SAUDE_MIN) {
    linhas.push(`${amarelo('SAUDE')}   health.json parado ${ha(idadeSaude)} - a Bia pode ter travado`);
    problemas.push('saude-velha');
  } else {
    linhas.push(`${verde('SAUDE')}   atualizado ${ha(idadeSaude)}`);
  }

  // 3) Conexao.
  const conectado = h.conectadoEm && (!h.desconectadoEm || Date.parse(h.conectadoEm) > Date.parse(h.desconectadoEm));
  if (conectado) {
    linhas.push(`${verde('CONECTADA')} desde ${ha(minutosDesde(h.conectadoEm))}`);
  } else if (h.desconectadoEm) {
    linhas.push(`${amarelo('DESCONECTADA')} desde ${ha(minutosDesde(h.desconectadoEm))} (motivo ${h.motivoDesconexao || '?'})`);
    problemas.push('desconectada');
  } else {
    linhas.push(`${amarelo('CONEXAO')} ainda nao abriu`);
  }

  // 4) OUVIR - o campo que denuncia a cegueira.
  //
  // Aqui e so uma HEURISTICA: "ha muito tempo que nobody mandou nada?". Isso
  // NAO prova cegueira - a empresa fecha, o fim de semana nao tem mensagem.
  // Por isso esta linha e amarela e NAO vira veredito: o veredito vem do
  // discriminador (bloco 4b), que exige evidencia de mensagem que chegou e
  // nao decriptou.
  const mInbound = minutosDesde(h.ultimoInboundEm);
  const mConectado = conectado ? minutosDesde(h.conectadoEm) : null;
  const recemSubiu = mConectado != null && mConectado < LIMITE_INBOUND_MIN;

  // O eco da sonda e um inbound `fromMe`: nao atualiza ultimoInboundEm, mas E a
  // prova direta de que a sessao decripta (o proprio bot mandou e recebeu o
  // eco). Sem isto, uma Bia saudavel e apenas ociosa (ninguem escreveu)
  // aparecia como "vale re-parear" - alarme falso que ja custou re-pareamentos
  // desnecessarios.
  const mSonda = minutosDesde(h.ultimaSondaEm);
  const sondaOkRecente =
    String(h.sondaResultado || '').endsWith(':ok') &&
    mSonda != null &&
    mSonda <= LIMITE_INBOUND_MIN;

  if (conectado && sondaOkRecente) {
    linhas.push(`${verde('OUVINDO')} sonda ok ${ha(mSonda)} (o eco voltou; a sessao decripta)`);
  } else if (mInbound == null) {
    if (conectado && !recemSubiu) {
      linhas.push(`${amarelo('OUVINDO?')} nenhum inbound decriptado desde o boot`);
      problemas.push('cego');
    } else {
      linhas.push(`${amarelo('OUVINDO?')} nenhum inbound ainda (subiu ${ha(mConectado)})`);
    }
  } else if (mInbound > LIMITE_INBOUND_MIN && conectado) {
    linhas.push(`${amarelo('OUVINDO?')} ultimo inbound ${ha(mInbound)} - se nao for horario de silencio, vale re-parear`);
    problemas.push('cego');
  } else {
    linhas.push(`${verde('OUVINDO')} ultimo inbound ${ha(mInbound)}`);
  }

  // 4b) CEGUEIRA CONFIRMADA - o veredito do discriminador.
  //
  // O bloco acima e uma HEURISTICA (30 min sem inbound). Este e o veredito do
  // discriminador: chegou mensagem, nao deu para ler, e a sessao esta
  // quebrada desde X. E o estado que a campanha para e que o painel mostra em
  // vermelho. A heuristica acima nao distingue "empresa fechada" de "buraco".
  if (h.cegueira) {
    // Confirmada (a sonda deu 2 falhas seguidas, ou chegou mensagem sem
    // decriptar) e vermelho e exit 2. Apenas suspeita e amarelo: a campanha
    // ja esta pausada, mas ainda nao da para chamar de sessao quebrada.
    const confirmada = Boolean(h.cegueiraConfirmada);
    problemas.push(confirmada ? 'cegueira' : 'cegueira_suspeita');
    linhas.push(
      `${confirmada ? vermelho('CEGA') : amarelo('CEGA (suspeita)')}     sessao quebrada ${h.cegueiraDesde ? `desde ${ha(minutosDesde(h.cegueiraDesde))}` : ''}` +
        `${h.cegueiraEvidencia ? ` (evidencia: ${h.cegueiraEvidencia})` : ''} - a campanha esta pausada`
    );
  }

  // 4c) CONTA SOB LIMITACAO (428) - problema diferente da cegueira: nao e
  // criptografia quebrada, e o WhatsApp barrando o numero (limite de taxa).
  // A sessao sobe e cai, e nada de leitura acontece. A cura e re-parear a
  // ponte e reduzir o ritmo de envio.
  const limit = saude.avaliarLimitacao();
  if (limit.limitado) {
    linhas.push(
      `${amarelo('LIMITADA')}   428 x${limit.quantidade} em 30 min - o WhatsApp esta cortando a conexao; a cura e re-parear a ponte e reduzir o ritmo de envio`
    );
    problemas.push('limitada');
  }

  // 5) Envios e falhas de decrypt.
  linhas.push(
    `${fraco('ENVIOS')}    ${h.envios || 0} desde o boot${h.ultimoEnvioEm ? `, ultimo ${ha(minutosDesde(h.ultimoEnvioEm))}` : ''}`
  );
  const falhas = h.falhasDecrypt || 0;
  const envios = h.envios || 0;
  const corFalhas = falhas > 50 && falhas > envios ? vermelho : falhas > 0 ? amarelo : verde;
  linhas.push(`${fraco('DECRYPT')}   ${corFalhas(String(falhas))} falha(s) de descriptografia desde o boot`);

  // Diagnostico da cegueira: separa "nao chegou" de "chegou e nao decriptou".
  const ups = h.upserts || 0;
  if (ups > 0) {
    linhas.push(
      `${fraco('EVENTOS')}   ${ups} upsert(s): ${h.upsertsNaoNotify || 0} nao-notify, ${h.upsertsSemTexto || 0} sem texto`
    );
    const semCorpo = (h.descartes && h.descartes.sem_corpo) || 0;
    if (semCorpo > 0) {
      linhas.push(
        `${fraco('SEM CORPO')}  ${semCorpo} mensagem(ns) chegaram sem corpo - chegaram e nao decriptaram`
      );
    }
  }

  console.log('');
  console.log(`  ${cor('1', 'Bia - empresa')}`);
  console.log(`  ${fraco(new Date().toLocaleString('pt-BR', { timeZone: config.fuso }))}`);
  console.log('');
  for (const l of linhas) console.log(`  ${l}`);
  console.log('');

  // Veredito.
  if (problemas.includes('processo')) {
    console.log(`  ${vermelho('VEREDITO: a Bia NAO esta rodando.')}`);
    console.log(`  Suba com: ${cor('1', 'npm run bot')}  (ou pelo supervisor)`);
    console.log('');
    return 1;
  }
  if (problemas.includes('cegueira')) {
    console.log(`  ${vermelho('VEREDITO: a Bia esta CEGA - a sessao Signal nao decripta.')}`);
    console.log('  Ela envia e nao responde; a campanha fica pausada ate a sessao voltar a ler.');
    console.log(`  ${fraco('Como corrigir:')} re-parear pelo painel (http://127.0.0.1:3001/) e depois ${'npm run bot'}.`);
    console.log(`  ${fraco('Detalhe:')} data/health.json (falhasDecrypt, descartes.sem_corpo) e ${'npm run log:today'}`);
    console.log('');
    return 2;
  }
  if (problemas.includes('cegueira_suspeita')) {
    console.log(`  ${amarelo('VEREDITO: a Bia esta no ar, mas a sessao nao esta lendo (ainda nao confirmado).')}`);
    console.log('  A campanha foi pausada por precaution. Se o problema persistir, re-pareie pelo painel.');
    console.log(`  ${fraco('Detalhe:')} ${'npm run log:today'}`);
    console.log('');
    return 3;
  }
  if (problemas.includes('limitada')) {
    console.log(`  ${amarelo('VEREDITO: a conta esta sob limitacao do WhatsApp (428).')}`);
    console.log('  O WhatsApp esta cortando a conexao: a sessao sobe e cai e nada de leitura acontece.');
    console.log('  A cura e re-parear a ponte (http://127.0.0.1:3001/) e reduzir o ritmo de envio.');
    console.log('');
    return 3;
  }
  if (problemas.includes('cego')) {
    // Suspeita, nao prova. Mensagem chegou sem corpo e o tempo de silencio
    // somam, o veredito e do discriminador (acima). Aqui so falta leitura
    // recente - pode ser so um dia sem ninguem falar com a Bia.
    console.log(`  ${amarelo('VEREDITO: a Bia esta no ar, mas sem leitura recente.')}`);
    console.log('  Nao e prova de cegueira: se ninguem mandou mensagem, e normal.');
    console.log(`  Se nao deveria estar calada, mande um "oi" de um numero autorizado e rode isto de novo.`);
    console.log('');
    return 3;
  }
  if (problemas.length) {
    console.log(`  ${amarelo('VEREDITO: a Bia esta de pe, mas com ressalvas (' + problemas.join(', ') + ').')}`);
    console.log('');
    return 0;
  }
  if (mInbound == null) {
    console.log(`  ${amarelo('VEREDITO: a Bia esta no ar, mas ainda nao ouviu nada.')}`);
    console.log(`  Se subiu ha pouco, e normal. Se ja passou de ${LIMITE_INBOUND_MIN} min, peca um "oi" de um numero autorizado.`);
    console.log('');
    return 0;
  }
  console.log(`  ${verde('VEREDITO: a Bia esta no ar e ouvindo.')}`);
  console.log('');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
