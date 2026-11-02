'use strict';

// ============================================================
// Testes de privacidade e de texto.
//
// Hermeticos: cada execucao usa uma pasta de dados temporaria (BIA_HOME) e
// desliga a migracao de legado (BIA_MIGRAR=0). Nada aqui toca na instalacao
// real - nem a sessao, nem a lista, nem o estado.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bia-teste-'));
process.env.BIA_HOME = HOME;
process.env.BIA_MIGRAR = '0';
process.env.BIA_DATA_DIR = path.join(HOME, 'data');
process.env.BIA_POR_DIA = '20';

const privacidade = require('../privacidade');
const config = require('../config');
const supressoes = require('../supressoes');
const templates = require('../templates');
const store = require('../store');
const escopo = require('../escopo.guard');

const NUMERO = '5511900000000';
const JID = `${NUMERO}@s.whatsapp.net`;

test('hash e estavel, ignora formatacao e nao guarda o numero', () => {
  const a = privacidade.hash(NUMERO);
  const b = privacidade.hash('+55 (11) 90000-0000');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.ok(privacidade.ehHash(a));
  assert.ok(!a.includes(NUMERO.slice(0, 6)));
});

test('supressao persiste apenas como hash', () => {
  assert.equal(supressoes.tem(NUMERO), false);
  assert.equal(supressoes.adicionar(NUMERO), true);
  assert.equal(supressoes.tem(NUMERO), true);

  const linhas = fs.readFileSync(supressoes.arquivo(), 'utf8').trim().split('\n');
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /^[0-9a-f]{24}$/);
  assert.ok(!linhas[0].includes('5511'));

  assert.equal(supressoes.remover(NUMERO), true);
  assert.equal(supressoes.tem(NUMERO), false);
});

test('limparSessao apaga dado pessoal e preserva estado e opt-out', () => {
  const pasta = path.join(HOME, 'data');
  fs.mkdirSync(pasta, { recursive: true });
  for (const nome of ['numeros.txt', 'mensagens.json', 'bot.log']) {
    fs.writeFileSync(path.join(pasta, nome), 'x', 'utf8');
  }
  fs.writeFileSync(path.join(pasta, 'estado.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(pasta, 'supridos.txt'), privacidade.hash(NUMERO) + '\n', 'utf8');

  const apagados = privacidade.limparSessao();

  assert.deepEqual(apagados.sort(), ['bot.log', 'mensagens.json', 'numeros.txt'].sort());
  assert.equal(fs.existsSync(path.join(pasta, 'numeros.txt')), false);
  assert.equal(fs.existsSync(path.join(pasta, 'estado.json')), true);
  assert.equal(fs.existsSync(path.join(pasta, 'supridos.txt')), true);
});

test('config padrao e generico e o teto diario e seguro', () => {
  assert.equal(config.empresa, 'Minha Empresa');
  assert.equal(config.botNome, 'Atendimento');
  assert.equal(config.endereco, '');
  assert.deepEqual(config.escopo.equipe, []);
  assert.equal(config.repique.porDia, 20);
  assert.ok(config.repique.porDia <= 20, 'teto padrao acima do recomendado para numero novo');
});

test('textos nao citam cliente e aceitam os marcadores', () => {
  const comNome = templates.repique('Maria');
  assert.match(comNome, /Maria/);
  assert.match(comNome, /Minha Empresa/);
  assert.ok(!/\{[a-zA-Z]+\}/.test(comNome), 'nao pode sobrar marcador sem troca');

  const semNome = templates.repique(null);
  assert.ok(!/\{nome\}/.test(semNome));

  const aviso = templates.avisoEquipe({ nome: 'Maria', numero: NUMERO, texto: 'sim', tipo: 'interesse' });
  assert.match(aviso, /Novo interesse/);
  assert.match(aviso, /Maria/);
});

test('estado antigo com JID e migrado para hash sem perder historico', () => {
  const arquivo = config.estadoArquivo;
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(
    arquivo,
    JSON.stringify({
      contatos: { [JID]: { status: 'contatado', suprimido: false, neutrosCount: 2 } },
      aliases: {},
    }),
    'utf8',
  );

  const contato = store.get(JID);
  assert.ok(contato, 'contato deve ser encontrado depois da migracao');
  assert.equal(contato.neutrosCount, 2);
  assert.equal(contato.jid, JID);

  const bruto = fs.readFileSync(arquivo, 'utf8');
  assert.ok(!bruto.includes(NUMERO), 'estado.json nao pode conter o telefone em claro');
  assert.match(bruto, /[0-9a-f]{24}/);

  const lista = store.listar();
  assert.equal(lista.length, 1);
  assert.ok(privacidade.ehHash(lista[0].chave));
});

test('opt-out barra repique mesmo sem estado na sessao', () => {
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'data', 'numeros.txt'), `${NUMERO};Maria\n`, 'utf8');
  fs.rmSync(config.estadoArquivo, { force: true });

  supressoes.adicionar(NUMERO);

  const r = escopo.podeReceberRepique({ jid: JID });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'suprimido');
});
