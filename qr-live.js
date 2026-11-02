'use strict';

// ============================================================
// QR ao vivo no navegador.
//
// Por que isto existe: o QR do WhatsApp Web expira a cada ~20s. Mostrar o
// `data/qr.png` como imagem estatica nao funciona - quando a pessoa olha, o
// codigo ja morreu. E o codigo de pareamento falhou duas vezes ("Couldn't link
// device") porque tambem expira entre gerar e digitar.
//
// A solucao e a mesma do WhatsApp Web de verdade: uma tela que mostra SEMPRE o
// QR atual. Este servidor local serve uma pagina que recarrega a imagem a cada
// segundo, entao a pessoa escaneia quando quiser, sem corrida contra o relogio.
//
// Nao abre porta para fora: escuta so em 127.0.0.1.
//
// Uso:
//   node qr-live.js            (abre o navegador)
//   node qr-live.js --sem-abrir
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const plataforma = require('./plataforma');
const QR = path.join(config.dataFolder, 'qr.png');
const PORTA = Number(process.env.BIA_QR_PORTA || 8787);

const PAGINA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>empresa - conectar aparelho</title>
<style>
  body { background:#0b0b0d; color:#e8e8ea; font-family:system-ui,Segoe UI,sans-serif;
         margin:0; min-height:100vh; display:flex; flex-direction:column;
         align-items:center; justify-content:center; gap:14px; }
  h1 { font-size:20px; font-weight:600; margin:0; }
  p { margin:0; color:#9aa0a6; font-size:14px; }
  .moldura { background:#fff; padding:18px; border-radius:16px; box-shadow:0 8px 40px #000a; }
  img { display:block; width:340px; height:340px; image-rendering:pixelated; }
  #st { font-size:12px; color:#6b7280; }
  .erro { color:#f87171; }
</style>
</head>
<body>
  <h1>Conectar aparelho</h1>
  <p>WhatsApp &rarr; Aparelhos conectados &rarr; Conectar aparelho</p>
  <div class="moldura"><img id="qr" alt="QR"></div>
  <p id="st">carregando o QR...</p>
<script>
  const img = document.getElementById('qr');
  const st = document.getElementById('st');
  let faltas = 0;
  async function atualizar() {
    try {
      const r = await fetch('qr.png?_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('sem qr');
      const blob = await r.blob();
      img.src = URL.createObjectURL(blob);
      st.textContent = 'QR atualizado agora - pode escanear';
      st.classList.remove('erro');
      faltas = 0;
    } catch {
      // silencio-ok: falha de rede do navegador; o contador de faltas e a
      // mensagem na tela sao o diagnostico visivel para quem esta olhando.
      faltas++;
      st.textContent = 'aguardando o QR (' + faltas + ')...';
      st.classList.add('erro');
    }
    setTimeout(atualizar, 1000);
  }
  atualizar();
</script>
</body>
</html>`;

const servidor = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGINA);
    return;
  }
  if (req.url.startsWith('/qr.png')) {
    fs.readFile(QR, (e, buf) => {
      if (e) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('sem qr ainda');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404);
  res.end('404');
});

servidor.listen(PORTA, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORTA}/`;
  console.log(`QR ao vivo em ${url}`);
  console.log('Deixe esta janela aberta. Feche quando parear.');
  if (!process.argv.includes('--sem-abrir')) {
    plataforma.abrirNavegador(url);
  }
});

process.on('SIGINT', () => {
  servidor.close();
  process.exit(0);
});
