'use strict';

// Teste seco: nao conecta no WhatsApp, nao escreve no estado.json.
// Mostra as 4 falas do repique e roda as respostas reais do fixture
// (tests/fixtures/mensagens-exemplo.json) atraves de classificar() + responder().
//
// Sai com codigo 1 se alguma coisa nao bater, para servir de smoke test.

const { classificar } = require('./classificador');
const { responder, repique, protocolo, negacao, avisoEquipe } = require('./templates');
const casos = require('./tests/fixtures/mensagens-exemplo.json');

const linha = () => console.log('-'.repeat(72));

let total = 0;
let falhas = 0;
const erros = [];

function checar(rotulo, cond, detalhe) {
  total++;
  if (cond) {
    console.log(`  ok    ${rotulo}`);
  } else {
    falhas++;
    erros.push(`${rotulo}${detalhe ? ' -> ' + detalhe : ''}`);
    console.log(`  FALHA ${rotulo}${detalhe ? '  -> ' + detalhe : ''}`);
  }
}

// ---------- As falas do repique ----------
console.log('\n=== FALAS DO REPIQUE ===\n');

console.log(`[REPIQUE]\n${repique()}\n`);
checar('repique cita a empresa e pergunta por interesse', /empresa/i.test(repique()) && /interesse/i.test(repique()));

console.log(`[INTERESSE]\n${responder('INTERESSE')}\n`);
checar('interesse avisa que a equipe entra em contato', /equipe/i.test(responder('INTERESSE')));

console.log(`[NEGACAO]\n${negacao()}\n`);
checar('negacao agradece e se despede', /Obrigad/i.test(negacao()) && /dia/i.test(negacao()));

console.log(`[PROTOCOLO]\n${protocolo()}\n`);
checar('protocolo diz que segue um roteiro e convida', /roteiro|protocolo/i.test(protocolo()));

console.log(`[AVISO EQUIPE]\n${avisoEquipe({ nome: 'Maria', numero: '5511900000000', texto: 'sim' })}\n`);

// ---------- Fixtures ----------
console.log('=== SIMULACAO DAS RESPOSTAS REAIS ===\n');

for (const { texto, esperado } of casos) {
  const { intent, confianca } = classificar(texto);
  const resposta = responder(intent);
  const bateu = intent === esperado;

  checar(`"${texto}" -> ${esperado}`, bateu, bateu ? undefined : `veio ${intent}`);
  console.log(`        intent=${intent} confianca=${confianca}`);
  if (resposta) {
    for (const l of resposta.split('\n')) console.log(`        BIA: ${l}`);
  } else {
    console.log('        BIA: (protocolo na 1a vez / despedida na 2a)');
  }
  console.log('');
}

// ---------- Prioridade numa rajada ----------
console.log('\n=== PRIORIDADE NUMA RAJADA ===\n');
const rajadas = [
  [['sim', 'quanto custa'], 'INTERESSE'],
  [['oi', 'nao tenho interesse'], 'NEGACAO'],
  [['nao quero', 'nao, obrigado'], 'NEGACAO'],
  [['oi', 'tudo bem'], 'NEUTRO'],
];
for (const [partes, esperado] of rajadas) {
  const melhor = partes
    .map((p) => ({ p, intent: classificar(p).intent }))
    .sort((a, b) => {
      const ordem = ['NEGACAO', 'INTERESSE', 'TALVEZ'];
      const ia = ordem.indexOf(a.intent);
      const ib = ordem.indexOf(b.intent);
      return (ia === -1 ? ordem.length : ia) - (ib === -1 ? ordem.length : ib);
    })[0];
  checar(`[${partes.join(' / ')}] -> ${esperado}`, melhor.intent === esperado, `veio ${melhor.intent}`);
}

// ---------- Resumo ----------
linha();
console.log(`Fixture: ${casos.length} casos | ${total - falhas}/${total} verificacoes ok | ${falhas} falharam.`);
if (erros.length) {
  console.log('\nFALHAS:');
  for (const e of erros) console.log('  - ' + e);
}
console.log('\nTeste seco concluido (nada foi enviado, nada foi gravado).\n');
process.exit(falhas ? 1 : 0);
