'use strict';

// ============================================================
// Backup da Bia.
//
// O que nao da para recriar sozinho e a SESSAO do WhatsApp (auth/): sem ela,
// so repareando com o celular. Aqui auth/ + a parte que importa de data/ +
// config.js viram um .zip datado, guardado FORA da pasta do projeto (por
// padrao no OneDrive, que sobrevive a formatar o computador).
//
// Detalhe que ja mordeu: com o bot no ar, os arquivos data/bot.out, bot.err e
// bot.log estao ABERTOS, e o Compress-Archive falha no meio. Entao o backup
// primeiro COPIA o que importa para uma pasta temporaria (pulando o que estiver
// travado) e zipa essa pasta - o zip sai limpo e sem os transitórios.
//
// Roda no boot e 1x/dia (ver bot.js) e tambem na mao: node backup.js
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const plataforma = require('./plataforma');
const config = require('./config');

const RAIZ = __dirname;

// Arquivos de data/ que valem backup (o resto e log/transitorio).
const DATA_IMPORTANTE = ['estado.json', 'numeros.txt', 'campanha.json', 'campanha.ligada', 'decisoes.jsonl'];

// Copia arquivo a arquivo, pulando o que estiver travado. auth/ e plano.
function copiarArquivos(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const conta = { copiados: 0, pulados: 0 };
  let nomes = [];
  try {
    nomes = fs.readdirSync(src);
  } catch {
    // silencio-ok: pasta de origem ausente; nada a copiar.
    return conta;
  }
  for (const nome of nomes) {
    try {
      fs.copyFileSync(path.join(src, nome), path.join(dst, nome));
      conta.copiados++;
    } catch {
      // silencio-ok: arquivo aberto por outro processo; o proximo backup pega.
      conta.pulados++;
    }
  }
  return conta;
}

function criar({ destino } = {}) {
  const pasta = destino || config.backupFolder;
  fs.mkdirSync(pasta, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zip = path.join(pasta, `bia-backup-${ts}.zip`);

  const palco = fs.mkdtempSync(path.join(os.tmpdir(), 'atendimento-bk-'));
  try {
    copiarArquivos(path.join(RAIZ, 'auth'), path.join(palco, 'auth'));

    const dataDir = path.join(palco, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    for (const f of DATA_IMPORTANTE) {
      const s = path.join(RAIZ, 'data', f);
      try {
        if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dataDir, f));
      } catch {
        // silencio-ok: arquivo de estado aberto; os demais vao mesmo assim.
      }
    }

    for (const f of ['config.js', 'package.json']) {
      const s = path.join(RAIZ, f);
      try {
        if (fs.existsSync(s)) fs.copyFileSync(s, path.join(palco, f));
      } catch {
        // silencio-ok: config travado; zipa sem ele e reporta pelo tamanho.
      }
    }

    // O que esta no palco vira o zip: auth/, data/, config.js e package.json,
    // cada um na raiz do arquivo (mesmo formato de antes). Windows usa
    // Compress-Archive; Linux/macOS usa zip. Ver plataforma.js.
    plataforma.ziparPasta(palco, zip);
  } finally {
    fs.rmSync(palco, { recursive: true, force: true });
  }

  podar(pasta);
  return zip;
}

// Mantem os `backupManter` mais recentes; apaga os mais velhos.
function podar(pasta) {
  let zips = [];
  try {
    zips = fs
      .readdirSync(pasta)
      .filter((f) => /^bia-backup-.*\.zip$/.test(f))
      .sort();
  } catch {
    // silencio-ok: pasta de backup inacessivel; nada a podar.
    return [];
  }
  const sobra = zips.slice(0, Math.max(0, zips.length - config.backupManter));
  for (const f of sobra) {
    try {
      fs.rmSync(path.join(pasta, f), { force: true });
    } catch {
      // silencio-ok: se nao der para apagar um backup velho, o proximo tenta.
    }
  }
  return zips.slice(sobra.length);
}

function listar() {
  try {
    return fs
      .readdirSync(config.backupFolder)
      .filter((f) => /^bia-backup-.*\.zip$/.test(f))
      .sort();
  } catch {
    // silencio-ok: sem pasta de backup ainda; lista vazia.
    return [];
  }
}

module.exports = { criar, podar, listar };

if (require.main === module) {
  try {
    const zip = criar();
    console.log(`Backup criado: ${zip}`);
    console.log(`Guardados agora: ${listar().length} (retencao ${config.backupManter}).`);
  } catch (e) {
    console.error(`Falha no backup: ${e.message}`);
    process.exit(1);
  }
}
