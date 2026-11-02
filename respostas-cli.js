'use strict';

// ============================================================
// Relatorio de respostas do repique.
//
// Le data/numeros.txt + data/estado.json e mostra o placar:
//
//   npm run respostas
//
// Nada aqui envia mensagem nem abre socket. O silencio conta como negativa:
// quem recebeu o repique e nunca respondeu aparece na lista, e nao e
// contatado de novo (o repique e 1x por numero).
// ============================================================

const numeros = require('./numeros');
const escopo = require('./escopo.guard');
const store = require('./store');

const STATUS = escopo.STATUS;

function classificarContato(contato) {
  if (!contato) return 'aguardando_repique';
  if (contato.status === STATUS.INTERESSADO) return STATUS.INTERESSADO;
  if (contato.status === STATUS.TALVEZ) return STATUS.TALVEZ;
  if (contato.status === STATUS.NEGOU) return STATUS.NEGOU;
  if (contato.status === STATUS.NEUTRO) return STATUS.NEUTRO;
  if (contato.repiqueEnviadoEm) return 'sem_resposta';
  return 'aguardando_repique';
}

function hora(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
  } catch (e) {
    // silencio-ok: data ja gravada e so formatacao; mostra o cru se falhar.
    return iso;
  }
}

function main() {
  const { entradas } = numeros.carregar();
  const balde = { interessado: [], talvez: [], negou: [], neutro: [], sem_resposta: [], aguardando_repique: [] };

  for (const e of entradas) {
    const contato = store.get(`${e.numero}@s.whatsapp.net`);
    balde[classificarContato(contato)].push({ ...e, contato });
  }

  console.log(`\nRepique empresa - ${entradas.length} numero(s) na lista\n`);

  console.log(`INTERESSADOS (${balde.interessado.length}):`);
  for (const x of balde.interessado) {
    console.log(`  • ${x.numero}${x.nome ? ' - ' + x.nome : ''}  (respondeu ${hora(x.contato.respostaEm)})`);
  }
  if (!balde.interessado.length) console.log('  (ninguem ainda)');

  console.log(`\nEM DÚVIDA / ANALISANDO (${balde.talvez.length}):`);
  for (const x of balde.talvez) {
    console.log(`  • ${x.numero}${x.nome ? ' - ' + x.nome : ''}  (respondeu ${hora(x.contato.respostaEm)})`);
  }
  if (!balde.talvez.length) console.log('  (ninguem ainda)');

  console.log(`\nRECUSARAM (${balde.negou.length})`);
  console.log(`RESPONDERAM OUTRA COISA (${balde.neutro.length})`);
  console.log(`SEM RESPOSTA - nao contatar de novo (${balde.sem_resposta.length})`);
  console.log(`AINDA NAO RECEBERAM O REPIQUE (${balde.aguardando_repique.length})`);

  const graves = numeros.auditar();
  if (!graves.ok) {
    console.log('\nATENCAO - problemas na lista:');
    for (const p of graves.problemas) console.log(`  - ${p}`);
  }
  console.log('');
}

main();
