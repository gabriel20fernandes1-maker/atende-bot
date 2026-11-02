'use strict';

// ============================================================
// `npm run log:today` - o resumo do dia a partir do log de decisao.
//
// A pergunta que ele responde sem abrir o codigo: a Bia esta saudavel hoje?
// Quantas conversas chegaram, quantas foram respondidas, e o que segurou o
// resto. Se "respondidas" for 0 com "recebidas" alto, algo esta errado - e a
// quebra por guarda diz qual porta fechou.
// ============================================================

const decisoes = require('./decisoes');
const atendimento = require('./atendimento');

const linhas = decisoes.deHoje();

const contar = (pred) => linhas.filter(pred).length;

const recebidas = contar((l) => l.acao === 'rajada');
const respondidas = contar((l) => l.acao === 'respondido');
const dedupe = contar((l) => l.acao === 'dedupe');
const semTexto = contar((l) => l.motivo === 'sem_texto');

const porGuarda = {};
for (const l of linhas) {
  if (!['bloqueado', 'segurado', 'silenciado'].includes(l.acao)) continue;
  const g = l.guard || 'outro';
  porGuarda[g] = (porGuarda[g] || 0) + 1;
}
const bloqueadas = Object.values(porGuarda).reduce((a, b) => a + b, 0);

const porIntent = {};
for (const l of linhas.filter((l) => l.acao === 'respondido' && l.intent)) {
  porIntent[l.intent] = (porIntent[l.intent] || 0) + 1;
}

const dia = atendimento.hojeISO();
console.log(`\n  Decisoes de hoje (${dia})`);
console.log('  ' + '-'.repeat(44));
console.log(`  recebidas ....... ${recebidas}`);
console.log(`  respondidas ..... ${respondidas}`);
console.log(`  bloqueadas ...... ${bloqueadas}`);
for (const [g, n] of Object.entries(porGuarda).sort()) console.log(`      ${g.padEnd(14)} ${n}`);
console.log(`  dedupe .......... ${dedupe}`);
console.log(`  sem texto ....... ${semTexto}  (chegou e nao decriptou)`);

if (Object.keys(porIntent).length) {
  console.log('\n  por intent:');
  for (const [i, n] of Object.entries(porIntent).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${i.padEnd(22)} ${n}`);
  }
}
console.log('');
