'use strict';

// ============================================================
// Imagens opcionais do repique.
//
// O operador escolhe o ACERVO (os arquivos em data/imagens/); a campanha
// sorteia UMA imagem por envio e manda junto do texto, como legenda. Pasta
// vazia = repique so de texto. Nada aqui inventa imagem: sem arquivo, sem
// midia.
//
// Formatos que o WhatsApp aceita como imagem: .jpg/.jpeg/.png/.webp.
// Arquivo vazio ou acima de 10 MB fica de fora: o envio inteiro falharia por
// causa da foto, e a pessoa ficaria sem o texto tambem.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const EXT_POR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const TAMANHO_MAX = 10 * 1024 * 1024;

// Pasta padrao lida de config.dataFolder em tempo de chamada: os testes (e o
// BIA_DATA_DIR) trocam a pasta depois do require, e um caminho congelado
// no carregamento apontaria para a producao.
function pastaPadrao() {
  return path.join(config.dataFolder, 'imagens');
}

function listar(pasta = pastaPadrao()) {
  let nomes;
  try {
    nomes = fs.readdirSync(pasta);
  } catch {
    // silencio-ok: pasta ausente = nenhuma imagem, que e o caso normal.
    return [];
  }
  const arquivos = [];
  for (const nome of nomes) {
    const ext = path.extname(nome).toLowerCase();
    if (!MIME[ext]) continue;
    const completo = path.join(pasta, nome);
    try {
      const st = fs.statSync(completo);
      if (!st.isFile() || st.size === 0 || st.size > TAMANHO_MAX) continue;
      arquivos.push({ arquivo: completo, nome, mimetype: MIME[ext], tamanho: st.size });
    } catch {
      // silencio-ok: arquivo sumiu entre o readdir e o stat.
    }
  }
  return arquivos.sort((a, b) => a.nome.localeCompare(b.nome));
}

function escolher({ rnd = Math.random, pasta } = {}) {
  const arquivos = listar(pasta);
  if (!arquivos.length) return null;
  const i = Math.min(arquivos.length - 1, Math.floor(rnd() * arquivos.length));
  return arquivos[i];
}

// Para o repique: sorteia SE vai imagem (chance) e QUAL. Devolve
// { buffer, mimetype, nome } ou null (texto puro).
function paraRepique({ rnd = Math.random, chance = config.repique.imagemChance, pasta } = {}) {
  const arquivos = listar(pasta);
  if (!arquivos.length) return null;
  const p = Math.max(0, Math.min(1, Number(chance)));
  if (!(rnd() < p)) return null;
  const alvo = escolher({ rnd, pasta });
  if (!alvo) return null;
  try {
    return { buffer: fs.readFileSync(alvo.arquivo), mimetype: alvo.mimetype, nome: alvo.nome };
  } catch {
    // silencio-ok: leitura falhou; cai no texto, nunca derruba o envio.
    return null;
  }
}

// ------------------------------------------------------------
// Upload/remocao pelo painel.
// ------------------------------------------------------------

function mimeDe(nome) {
  return MIME[path.extname(String(nome || '')).toLowerCase()] || null;
}

// So aceita um nome simples, com extensao de imagem, que exista na pasta.
// Qualquer coisa com barra, "..", extensao estranha ou que escape da pasta
// devolve null - o painel nunca le/remove fora de data/imagens/.
function caminhoDe(nome) {
  const bruto = String(nome || '');
  const base = path.basename(bruto);
  if (!base || base !== bruto) return null;
  if (!mimeDe(base)) return null;
  const completo = path.join(pastaPadrao(), base);
  if (!fs.existsSync(completo)) return null;
  return completo;
}

function ehImagem(buffer, mimetype) {
  if (!buffer || !buffer.length) return false;
  if (mimetype === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimetype === 'image/png') {
    const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(assinatura);
  }
  if (mimetype === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

function nomeSeguro(nome) {
  const bruto = String(nome || '');
  const semExt = path.basename(bruto, path.extname(bruto));
  const limpo = semExt
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return limpo || 'imagem';
}

// Recebe o base64 do painel, confere o tipo real pelo cabecalho e grava.
// Devolve { nome, tamanho } ou lanca erro com mensagem para a tela.
function salvar({ nome, mimetype, dadosBase64 } = {}) {
  const mime = String(mimetype || '').toLowerCase();
  if (!EXT_POR_MIME[mime]) throw new Error('formato não aceito (use JPG, PNG ou WEBP)');
  const buffer = Buffer.from(String(dadosBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('a imagem chegou vazia');
  if (buffer.length > TAMANHO_MAX) throw new Error('imagem maior que 10 MB');
  if (!ehImagem(buffer, mime)) throw new Error('o arquivo não parece uma imagem válida');

  fs.mkdirSync(pastaPadrao(), { recursive: true });
  const base = nomeSeguro(nome);
  const ext = EXT_POR_MIME[mime];
  let final = base + ext;
  let n = 2;
  while (fs.existsSync(path.join(pastaPadrao(), final))) {
    final = base + '-' + n + ext;
    n += 1;
  }
  fs.writeFileSync(path.join(pastaPadrao(), final), buffer);
  return { nome: final, tamanho: buffer.length };
}

function remover(nome) {
  const completo = caminhoDe(nome);
  if (!completo) return { ok: false, erro: 'imagem nao encontrada' };
  try {
    fs.rmSync(completo, { force: true });
    return { ok: true, nome: path.basename(completo) };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

module.exports = {
  listar,
  escolher,
  paraRepique,
  salvar,
  remover,
  caminhoDe,
  mimeDe,
  MIME,
  EXT_POR_MIME,
  TAMANHO_MAX,
};

