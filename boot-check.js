'use strict';

// ============================================================
// Prova de boot (o "smoke").
//
// `bot.js --smoke` roda todo o boot ATE antes de abrir socket: le a lista,
// valida o escopo, confere a biblioteca de imagem. Se algo ali esta errado, o
// bot subiria para morrer (ou pior: subiria e falharia em todo envio).
//
// Existe um lugar so para isso porque DUAS pessoas precisam da mesma resposta:
//   - o supervisor, antes de subir o bot (watchdog/supervisor.js);
//   - o painel, no clique em "Subir a Bia", para poder DIZER ao dono por que
//     nao subiu (antes ele respondia "ok" e a tela ficava "parada" sem motivo).
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ARQUIVO_FALHA = 'ultimo-erro-boot.json';

// Roda o smoke numa pasta de dados temporaria (para nao tocar em producao) e
// devolve { ok, saida, codigo }. Nunca lanca.
function validarBoot({ raiz, dataFolder, timeoutMs = 120000 }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atende-smoke-'));
  try {
    // A lista e o unico dado que o boot le; o resto do estado nao importa.
    const lista = path.join(dataFolder, 'numeros.txt');
    if (fs.existsSync(lista)) fs.copyFileSync(lista, path.join(tmp, 'numeros.txt'));

    const r = spawnSync(process.execPath, [path.join(raiz, 'bot.js'), '--smoke'], {
      cwd: raiz,
      // BIA_DATA_DIR vai so no env DESTE filho: nada vaza para o bot real.
      env: { ...process.env, BIA_DATA_DIR: tmp },
      encoding: 'utf8',
      timeout: timeoutMs,
    });

    const saida = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return { ok: r.status === 0, codigo: r.status, saida };
  } catch (e) {
    return { ok: false, codigo: null, saida: `falha ao rodar o smoke: ${e.message}` };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // silencio-ok: pasta temporaria; o sistema limpa depois.
    }
  }
}

// Tira o timestamp do log e devolve so o que interessa ao dono.
// Ex.: "[2026-...]   - lista de repique VAZIA: crie ..." -> "lista de repique VAZIA: ..."
function resumir(saida) {
  const linhas = String(saida || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim())
    // O smoke roda numa pasta temporaria; o caminho dela nao diz nada ao dono.
    // Mostrar "data/numeros.txt" e o que ele precisa abrir/importar.
    .map((l) => l.replace(/[^\s]*atende-smoke-[^\s\\/]*[\\/]/g, 'data/'))
    .filter(Boolean);

  const problemas = linhas.filter((l) => l.startsWith('- ')).map((l) => l.replace(/^-\s*/, ''));
  if (problemas.length) return problemas.slice(0, 2).join(' / ');

  const cabeca = linhas.find((l) => /CONFIG INVALIDA|erro|falha/i.test(l));
  return cabeca || linhas[0] || 'o bot nao passou na prova de boot';
}

function caminhoFalha(dataFolder) {
  return path.join(dataFolder, ARQUIVO_FALHA);
}

// O painel le isto de 5 em 5 s: o motivo do "nao subiu" nao pode depender de o
// dono estar olhando no exato segundo do clique.
function registrarFalha(dataFolder, saida) {
  try {
    fs.mkdirSync(dataFolder, { recursive: true });
    fs.writeFileSync(
      caminhoFalha(dataFolder),
      JSON.stringify({ em: new Date().toISOString(), saida: String(saida || ''), resumo: resumir(saida) }, null, 2),
      'utf8'
    );
  } catch {
    // silencio-ok: sem o arquivo a tela ainda mostra "parada"; o log tem tudo.
  }
}

function limparFalha(dataFolder) {
  try {
    fs.rmSync(caminhoFalha(dataFolder), { force: true });
  } catch {
    // silencio-ok: nao existia.
  }
}

// Devolve { em, resumo, saida } da ultima falha, ou null. Falha com mais de
// `validadeMin` minutos e ignorada: pode ja ter sido corrigida e o dono nao
// precisa ver um erro velho.
function lerFalha(dataFolder, validadeMin = 60) {
  try {
    const o = JSON.parse(fs.readFileSync(caminhoFalha(dataFolder), 'utf8'));
    if (!o || !o.resumo) return null;
    const t = Date.parse(o.em);
    if (!Number.isNaN(t) && Date.now() - t > validadeMin * 60000) return null;
    return o;
  } catch {
    return null;
  }
}

module.exports = { validarBoot, resumir, registrarFalha, limparFalha, lerFalha };
