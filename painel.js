'use strict';

// ============================================================
// Painel "Alimentar a Bia" (localhost).
//
// Servidor HTTP leve, SEM WhatsApp. Serve uma pagina onde o operador cola o
// texto do painel da empresa, importa para data/numeros.txt, ve o resumo da
// campanha e liga/desliga os envios.
//
// Escuta SO em 127.0.0.1: e a maquina do operador. Sem senha.
//   node painel.js            (ou o atalho "Alimentar a Bia")
//   BIA_PAINEL_PORTA=3001  troca a porta
//
// Nada aqui abre socket do WhatsApp - pode rodar junto com o bot.
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');
const { execFile, spawn } = require('child_process');
const config = require('./config');
const trava = require('./pid.lock');
const plataforma = require('./plataforma');
const bootCheck = require('./boot-check');
const campanha = require('./campanha');
const atendimento = require('./atendimento');
const numeros = require('./numeros');
const { limparNome } = require('./nomes');
const mensagens = require('./mensagens');
const imagensPainel = require('./imagens');
const mensagensCampanha = require('./mensagens-campanha');
const { importar, limparLista, removerContato } = require('./importar');

const PORTA = Number(process.env.BIA_PAINEL_PORTA || 3001);

const PAGINA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alimentar a Bia</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, Segoe UI, sans-serif; background:#f4f5f7; color:#1f2430;
         margin:0; padding:24px; }
  .caixa { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color:#5b6472; margin: 0 0 16px; }
  .resumo { background:#fff; border:1px solid #e2e5ea; border-radius:12px; padding:12px 16px;
            margin-bottom:16px; font-size:14px; line-height:1.7; }
  .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:600; font-size:12px; }
  .pill.on { background:#e3f6ea; color:#1f8a4c; }
  .pill.off { background:#fdeaea; color:#c0392b; }
  .etapa { font-weight:600; margin:18px 0 6px; }
  textarea { width:100%; height:220px; padding:12px; border:1px solid #cfd4dc; border-radius:12px;
             font-family: inherit; font-size:14px; resize: vertical; }
  .acoes { display:flex; gap:10px; align-items:center; margin-top:12px; flex-wrap:wrap; }
  .arquivo { display:inline-flex; align-items:center; gap:8px; font-size:14px; color:#2f6fed;
             background:#fff; border:1px dashed #9db4e6; border-radius:10px; padding:9px 14px; cursor:pointer; }
  .arquivo input { display:none; }
  button { font-size:15px; padding:10px 18px; border-radius:10px; border:0; cursor:pointer;
           background:#2f6fed; color:#fff; font-weight:600; }
  button.secundario { background:#e7ebf3; color:#2f6fed; }
  button:disabled { opacity:.6; cursor:default; }
  #status { color:#5b6472; font-size:14px; }
  #resultado { margin-top:18px; background:#fff; border:1px solid #e2e5ea; border-radius:12px;
               padding:12px 16px; font-size:14px; }
  #resultado h2 { font-size:16px; margin:0 0 8px; }
  ul { margin:8px 0 0; padding-left:20px; }
  .bom { color:#1f8a4c; } .ruim { color:#c0392b; }
  .alerta { display:none; background:#fdeaea; border:2px solid #d64530; color:#7d1a10;
            border-radius:12px; padding:14px 18px; margin-bottom:16px; font-size:15px; line-height:1.6; }
  .alerta b { display:block; font-size:17px; margin-bottom:4px; }
  .alerta button { margin-top:10px; background:#d64530; }
  /* Suspeita de cegueira: ainda nao confirmada, mas a campanha ja parou. */
  .alerta.suspeita { background:#fff8e1; border-color:#d99b00; color:#6b4c00; }
  .alerta.suspeita button { background:#d99b00; }
  /* Conta sob limitacao do WhatsApp (428): problema de numero, nao de sessao. */
  .alerta.limite { background:#fff3e8; border-color:#d2691e; color:#7a3b0d; }
  .alerta.limite button { background:#d2691e; }
  .card { background:#fff; border:1px solid #e2e5ea; border-radius:12px; padding:14px 16px; }
  .dica { color:#5b6472; font-size:13px; line-height:1.55; margin:0 0 10px; }
  .campo-rotulo { display:block; font-weight:600; font-size:13px; margin:8px 0 4px; }
  .msg-campo { height:82px; margin-bottom:6px; }
  .previa { background:#f7f9fc; border:1px dashed #cfd4dc; border-radius:10px; padding:10px 12px;
            font-size:14px; white-space:pre-wrap; margin:8px 0 2px; color:#1f2430; }
  .previa b { display:block; color:#5b6472; font-size:12px; margin-bottom:4px; }
  .status-pequeno { color:#5b6472; font-size:13px; }
  .grid-img { display:flex; flex-wrap:wrap; gap:12px; margin-top:12px; }
  .thumb { width:140px; border:1px solid #e2e5ea; border-radius:10px; overflow:hidden; background:#fff; }
  .thumb img { width:100%; height:100px; object-fit:cover; display:block; background:#f4f5f7; }
  .thumb .nome { font-size:12px; padding:6px 8px; color:#5b6472; word-break:break-all; }
  .thumb button { width:100%; border-radius:0; padding:7px; font-size:12px; background:#fdeaea; color:#c0392b; }
  .vazio { color:#8a93a2; font-size:13px; padding:8px 0; }
</style>
</head>
<body>
  <div class="caixa">
    <h1>Alimentar a Bia</h1>
    <p class="sub">1) Cole ou importe a lista, 2) escolha a mensagem e as imagens, 3) ligue o envio.</p>
    <div class="alerta" id="alerta"></div>
    <div class="resumo" id="resumo">carregando...</div>
    <div class="etapa">A Bia</div>
    <div class="acoes">
      <span id="biaEstado">-</span>
      <button id="subirBia">Subir a Bia</button>
      <button id="derrubarBia" class="secundario" style="background:#fdeaea;color:#c0392b;">Derrubar a Bia</button>
      <button id="testarVisao" class="secundario">Testar visão agora</button>
    </div>
    <p class="sub" id="visaoEstado" style="margin:-2px 0 0;">Visão: nunca testada.</p>
    <p class="sub" style="margin:-2px 0 0;">Abrir o painel NAO liga a Bia. Ela sobe quando voce clica em
      <b>Subir a Bia</b> - e para conectar um aparelho novo, clique em Derrubar antes (ou use o
      botao de conectar, que derruba sozinho).</p>
    <div class="etapa">1) Importar contatos</div>
    <textarea id="texto" placeholder="Cole aqui os contatos do painel (origem, nome, telefone, data) ..."></textarea>
    <div class="acoes">
      <label class="arquivo">
        <input type="file" id="arquivo" accept=".csv,.txt,text/csv,text/plain,text/comma-separated-values">
        <span>Escolher arquivo .CSV/.TXT</span>
      </label>
      <button id="importar">Importar contatos</button>
      <button id="exportar" class="secundario">Exportar lista (.txt)</button>
      <button id="limpar" style="background:#fdeaea;color:#c0392b;">Limpar lista</button>
    </div>
    <div class="etapa">Contatos na lista (<span id="qtdLista">0</span>)</div>
    <div id="listaBox" style="background:#fff;border:1px solid #e2e5ea;border-radius:12px;padding:4px 16px;font-size:14px;max-height:280px;overflow:auto;">
      <p class="sub" id="listaVazia" style="margin:12px 0;">Nenhum contato na lista ainda.</p>
      <table id="listaTab" style="width:100%;border-collapse:collapse;display:none;">
        <tbody id="listaCorpo"></tbody>
      </table>
    </div>
    <div class="etapa">2) Mensagem da campanha</div>
    <div class="card">
      <p class="dica">Esta é a mensagem que a Bia manda no disparo. Se a pessoa tiver nome na lista, o
        <b>{nome}</b> vira o primeiro nome dela. Se não tiver, a Bia usa a segunda mensagem.</p>
      <label class="campo-rotulo" for="msgComNome">Para quem tem nome (use {nome})</label>
      <textarea id="msgComNome" class="msg-campo"></textarea>
      <label class="campo-rotulo" for="msgSemNome">Para quem não tem nome</label>
      <textarea id="msgSemNome" class="msg-campo"></textarea>
      <div class="previa" id="previaMsg"></div>
      <div class="acoes">
        <button id="salvarMensagem">Salvar mensagem</button>
        <button id="restaurarMensagem" class="secundario">Restaurar padrão</button>
        <span id="msgStatus" class="status-pequeno"></span>
      </div>
    </div>

    <div class="etapa">Imagens que acompanham a mensagem</div>
    <div class="card">
      <p class="dica">Adicione uma ou mais imagens. A cada envio, a Bia escolhe uma delas e manda junto
        com o texto. Sem imagens, ela manda só o texto.</p>
      <div class="acoes">
        <label class="arquivo">
          <input type="file" id="arquivoImagens" accept="image/jpeg,image/png,image/webp" multiple>
          <span>Adicionar imagens</span>
        </label>
        <span id="imgStatus" class="status-pequeno"></span>
      </div>
      <div id="imagensLista" class="grid-img"></div>
    </div>

    <div class="etapa">3) Enviar mensagens</div>
    <div class="acoes">
      <button id="enviar" class="secundario">Enviar mensagens</button>
      <span id="status"></span>
    </div>
    <div class="etapa">Mensagens recebidas (últimas 20)</div>
    <div id="msgBox" style="background:#fff;border:1px solid #e2e5ea;border-radius:12px;padding:4px 16px;font-size:14px;max-height:320px;overflow:auto;">
      <p class="sub" id="msgVazia" style="margin:12px 0;">Nenhuma mensagem recebida ainda.</p>
      <div id="msgLista" style="display:none;"></div>
    </div>
    <div class="etapa">Aparelho do bot</div>
    <div class="acoes">
      <span id="aparelho">carregando...</span>
      <button id="parear" class="secundario">Conectar / Trocar número (QR)</button>
      <button id="parearCodigo" class="secundario">Conectar por código</button>
      <button id="desvincular" class="secundario" style="background:#fdeaea;color:#c0392b;">Desvincular aparelho</button>
    </div>
    <div id="numeroBox" style="text-align:center; margin-top:12px;">
      <p class="sub">Número que vai conectar (com <b>55</b> e DDD, só dígitos). O pareamento por código usa este número:</p>
      <input id="numeroPareamento" inputmode="numeric" placeholder="5511900000000" style="font-size:16px;padding:8px 12px;border:1px solid #e2e5ea;border-radius:10px;width:220px;text-align:center;">
    </div>
    <div id="qrbox" style="display:none; text-align:center; margin-top:12px;">
      <p class="sub">No celular do número que vai usar: WhatsApp &rarr; Aparelhos conectados &rarr; Conectar aparelho, e aponte para o código.</p>
      <img id="qrimg" alt="QR" style="width:280px;height:280px;background:#fff;padding:12px;border-radius:12px;">
    </div>
    <div id="codigobox" style="display:none; text-align:center; margin-top:12px;">
      <p class="sub">No <b>celular do número acima</b>: WhatsApp &rarr; Aparelhos conectados &rarr; Conectar aparelho &rarr; <b>Conectar com número de telefone</b> e digite o código abaixo (vale para <b id="codigoNumero">-</b>).</p>
      <div id="codigo" style="display:inline-block; font-size:30px; font-weight:700; letter-spacing:6px; background:#fff; border:1px solid #e2e5ea; border-radius:12px; padding:12px 22px;">--------</div>
      <p class="sub">Ele não muda sozinho: esta conexão fica aberta uns 20 min. Se o WhatsApp disser que expirou (ou você demorou), clique em <b>Gerar novo código</b>.</p>
      <button id="novoCodigo" class="secundario">Gerar novo código</button>
    </div>
    <div id="cancelarBox" style="display:none; text-align:center; margin-top:10px;">
      <button id="cancelar" class="secundario">Cancelar e tentar de novo</button>
    </div>
    <div id="resultado" style="display:none"></div>
  </div>
<script>
  // Escapar texto que vem da lista importada. O nome e o numero sao
  // digitados por alguem (ou vemem de um arquivo): sem escapar, um contato
  // chamado "><img src=x onerror=...>" executa script dentro do painel.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function fmt(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString('pt-BR');
  }
  async function carregarResumo() {
    const r = await fetch('/resumo', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (!r) {
      document.getElementById('resumo').textContent = 'Não consegui falar com o painel.';
      return;
    }
    const bot = r.bot || {};
    const selo = bot.online
      ? '<span class="pill on">online</span>'
      : (bot.vivo ? '<span class="pill off">sem conexão</span>' : '<span class="pill off">offline</span>');

    // Cegueira: a sessao recebe mensagens e nao decripta. O bot envia e nao
    // ouve; a campanha fica pausada ate alguem re-parear. E o aviso que
    // precisava existir: em 19/10 isso passou o dia inteiro sem ninguem ver.
    //
    // Tres estados, porque sao tres situacoes:
    //   - CEGA (confirmada): a sonda deu 2 falhas seguidas ou chegou mensagem
    //     sem decriptar. Estado vermelho.
    //   - CEGA (suspeita): o primeiro teste falhou. A campanha ja parou por
    //     precaution, mas ainda nao da para chamar de sessao quebrada.
    //   - LIMITADA: o WhatsApp esta cortando a conexao (428). Nao e
    //     criptografia: e o numero barrado por limite de taxa.
    const alerta = document.getElementById('alerta');
    if (bot.cegueira) {
      const confirmada = Boolean(bot.cegueiraConfirmada);
      const desde = bot.cegueiraDesde ? new Date(bot.cegueiraDesde).toLocaleString('pt-BR') : '?';
      alerta.style.display = 'block';
      alerta.className = 'alerta' + (confirmada ? '' : ' suspeita');
      alerta.innerHTML =
        (confirmada
          ? '<b>A Bia esta CEGA</b>' +
            'A sessao recebe mensagens mas nao consegue decriptar: ela envia e nao ouve nenhuma resposta. ' +
            'A campanha de repique esta pausada para nao queimar a lista.<br>'
          : '<b>A Bia parou de ler (suspeita de cegueira)</b>' +
            'O teste de visao falhou uma vez. A campanha foi pausada por precaution, ' +
            'mas ainda nao da para afirmar que a sessao quebrou.<br>') +
        'Desde ' + desde +
        (bot.cegueiraEvidencia ? ' &middot; evidencia: ' + bot.cegueiraEvidencia : '') +
        (bot.falhasDecrypt ? ' &middot; ' + bot.falhasDecrypt + ' falha(s) de decriptografia' : '') +
        (bot.semCorpo ? ' &middot; ' + bot.semCorpo + ' mensagem(ns) chegaram sem corpo' : '') +
        '<br>Reiniciar o bot NAO resolve: o estado quebrado esta no aparelho. ' +
        'E preciso parear de novo.' +
        '<button id="reparar">Re-parear agora (QR)</button>';
      document.getElementById('reparar').onclick = () => pedirPareamento('qr');
    } else if (bot.limitado) {
      alerta.style.display = 'block';
      alerta.className = 'alerta limite';
      alerta.innerHTML =
        '<b>Conta sob limitacao do WhatsApp (428)</b>' +
        'O WhatsApp esta cortando a conexao da Bia ' +
        (bot.desconexoes428 || 0) +
        ' vez(es) em 30 minutos: ela sobe e cai, e nesse va e vem nada de leitura acontece.<br>' +
        'Nao e problema de criptografia: e o numero barrado por limite de taxa. ' +
        'A cura e RE-PAREAR a ponte e reduzir o ritmo de envio.' +
        '<button id="reparar">Re-parear agora (QR)</button>';
      document.getElementById('reparar').onclick = () => pedirPareamento('qr');
    } else {
      alerta.style.display = 'none';
      alerta.className = 'alerta';
      alerta.innerHTML = '';
    }

    document.getElementById('resumo').innerHTML =
      'Bot: ' + selo +
      ' &middot; Pendentes: <b>' + r.pendentes + '</b>' +
      ' &middot; Na lista: <b>' + r.totalNaLista + '</b>' +
      ' &middot; Hoje: <b>' + r.enviadosHoje + '/' + r.porDia + '</b>' +
      ' &middot; Janela: <b>' + (r.janelaAberta ? 'aberta' : 'fechada') + '</b>' +
      '<br>Último envio: ' + fmt(bot.ultimoEnvioEm) + ' &middot; Último recebido: ' + fmt(bot.ultimoInboundEm);
    const b = document.getElementById('enviar');
    b.textContent = r.ligada ? 'Pausar envios' : 'Enviar mensagens';
    b.dataset.ligada = r.ligada ? '1' : '0';
    const par = r.pareamento || {};
    const aparelho = document.getElementById('aparelho');
    if (r.bot && r.bot.precisaReligar) {
      aparelho.innerHTML = '<span class="pill off">desvinculado</span> Clique em "Conectar / Trocar número" e escaneie o QR.';
    } else if (par.numero) {
      aparelho.textContent = 'Número pareado: ' + par.numero;
    } else {
      aparelho.textContent = 'Nenhum número pareado ainda';
    }
    const qrbox = document.getElementById('qrbox');
    const codigobox = document.getElementById('codigobox');
    // O campo do numero fica SEMPRE visivel (fora do codigobox): a pessoa
    // precisa digitar o numero NOVO antes de pedir o codigo. So preenche
    // quando estiver vazio, para nao apagar o que ela esta digitando enquanto
    // o resumo atualiza de 5 em 5 s - e so com o numero SALVO (nunca o antigo
    // do config, que a Bia nao usa mais).
    const campoNumero = document.getElementById('numeroPareamento');
    if (!campoNumero.value && par.numeroSalvo) campoNumero.value = par.numeroSalvo;
    if (par.pareando && par.modo === 'codigo') {
      qrbox.style.display = 'none';
      codigobox.style.display = 'block';
      document.getElementById('codigo').textContent = par.codigo || '--------';
      document.getElementById('codigoNumero').textContent = par.numero ? '+' + par.numero : '-';
    } else if (par.pareando) {
      codigobox.style.display = 'none';
      qrbox.style.display = 'block';
      document.getElementById('qrimg').src = '/qr.png?_=' + Date.now();
    } else {
      qrbox.style.display = 'none';
      codigobox.style.display = 'none';
    }
    document.getElementById('cancelarBox').style.display = par.pareando ? 'block' : 'none';

    // O controle da Bia: o painel abre sozinho, mas a Bia NAO sobe junto.
    // Quem manda subir e o dono - e o pareamento tem prioridade (com connect.js
    // vivo o bot nao pode subir, senao morre na trava e enche o log).
    const biaEstado = document.getElementById('biaEstado');
    const subirBia = document.getElementById('subirBia');
    const derrubarBia = document.getElementById('derrubarBia');
    if (par.pareando) {
      biaEstado.innerHTML = '<span class="pill off">pareando</span> a Bia fica parada ate o pareamento terminar';
      subirBia.disabled = true;
      derrubarBia.disabled = true;
    } else if (bot.online) {
      biaEstado.innerHTML = '<span class="pill on">no ar</span>';
      subirBia.disabled = false;
      derrubarBia.disabled = false;
    } else if (bot.vivo) {
      biaEstado.innerHTML = '<span class="pill off">subindo...</span>';
      subirBia.disabled = false;
      derrubarBia.disabled = false;
    } else {
      // Quando o dono JA mandou subir e nao subiu, o motivo fica na tela (nao
      // so no log): lista vazia, numero invalido, falta de sharp...
      const motivo = bot.motivoParada;
      biaEstado.innerHTML = motivo
        ? '<span class="pill off">parada</span> não subiu: <b>' + esc(motivo.resumo) + '</b>'
        : '<span class="pill off">parada</span> clique em Subir a Bia';
      subirBia.disabled = false;
      derrubarBia.disabled = true;
    }

    // Visao: a sonda manda uma mensagem para a propria Bia e espera o eco.
    // Aqui so mostramos o ultimo veredito; o teste e o botao ao lado.
    const testarVisao = document.getElementById('testarVisao');
    testarVisao.disabled = !(bot.online && !par.pareando) || visaoTestando;
    if (!visaoTestando) {
      document.getElementById('visaoEstado').innerHTML = textoVisao(bot);
      ultimoSondaEm = bot.sondaEm || null;
    }
  }
  function form(dados) {
    return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
             body: new URLSearchParams(dados) };
  }

  // ---- Mensagem da campanha (editavel, vale no proximo envio) ----
  function atualizarPrevia() {
    const alvo = document.getElementById('previaMsg');
    if (!alvo) return;
    const texto = String(document.getElementById('msgComNome').value || '').split('{nome}').join('Maria');
    alvo.textContent = '';
    const titulo = document.createElement('b');
    titulo.textContent = 'Prévia com o nome "Maria"';
    const corpo = document.createElement('div');
    corpo.textContent = texto || '(mensagem vazia)';
    alvo.appendChild(titulo);
    alvo.appendChild(corpo);
  }
  async function carregarMensagemCampanha() {
    const r = await fetch('/mensagens-campanha', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (!r) return;
    document.getElementById('msgComNome').value = r.comNome || '';
    document.getElementById('msgSemNome').value = r.semNome || '';
    document.getElementById('msgStatus').textContent = r.personalizado
      ? 'Usando a mensagem personalizada.'
      : 'Usando a mensagem padrão.';
    atualizarPrevia();
  }
  document.getElementById('msgComNome').addEventListener('input', atualizarPrevia);
  document.getElementById('salvarMensagem').onclick = async () => {
    const st = document.getElementById('msgStatus');
    st.textContent = 'Salvando...';
    const r = await fetch('/mensagens-campanha', form({
      comNome: document.getElementById('msgComNome').value,
      semNome: document.getElementById('msgSemNome').value,
    })).then((x) => x.json()).catch(() => null);
    if (r && r.ok) {
      document.getElementById('msgComNome').value = r.comNome;
      document.getElementById('msgSemNome').value = r.semNome;
      st.textContent = 'Mensagem salva. A Bia usa no próximo envio.';
      atualizarPrevia();
    } else {
      st.textContent = (r && r.erro) || 'Não deu para salvar. Tente de novo.';
    }
  };
  document.getElementById('restaurarMensagem').onclick = async () => {
    if (!window.confirm('Voltar para a mensagem padrão da Bia?')) return;
    const st = document.getElementById('msgStatus');
    st.textContent = 'Restaurando...';
    const r = await fetch('/mensagens-campanha/restaurar', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    if (r && r.ok) {
      document.getElementById('msgComNome').value = r.comNome;
      document.getElementById('msgSemNome').value = r.semNome;
      st.textContent = 'Mensagem padrão restaurada.';
      atualizarPrevia();
    } else {
      st.textContent = (r && r.erro) || 'Não deu para restaurar.';
    }
  };

  // ---- Imagens da campanha ----
  function lerArquivoBase64(f) {
    return new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => {
        const s = String(leitor.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      leitor.onerror = reject;
      leitor.readAsDataURL(f);
    });
  }
  function renderizarImagens(lista) {
    const box = document.getElementById('imagensLista');
    box.textContent = '';
    if (!lista || !lista.length) {
      const vazio = document.createElement('div');
      vazio.className = 'vazio';
      vazio.textContent = 'Nenhuma imagem adicionada ainda.';
      box.appendChild(vazio);
      return;
    }
    for (const img of lista) {
      const card = document.createElement('div');
      card.className = 'thumb';
      const el = document.createElement('img');
      el.src = '/imagens/' + encodeURIComponent(img.nome);
      el.alt = img.nome;
      el.loading = 'lazy';
      const nome = document.createElement('div');
      nome.className = 'nome';
      nome.textContent = img.nome;
      const remover = document.createElement('button');
      remover.textContent = 'Remover';
      remover.onclick = async () => {
        if (!window.confirm('Remover a imagem "' + img.nome + '"?')) return;
        const st = document.getElementById('imgStatus');
        const r = await fetch('/imagens/remover', form({ nome: img.nome })).then((x) => x.json()).catch(() => null);
        if (r && r.ok) {
          st.textContent = 'Imagem removida.';
          carregarImagens();
        } else {
          st.textContent = (r && r.erro) || 'Não deu para remover.';
        }
      };
      card.appendChild(el);
      card.appendChild(nome);
      card.appendChild(remover);
      box.appendChild(card);
    }
  }
  async function carregarImagens() {
    const r = await fetch('/imagens', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (r && r.imagens) renderizarImagens(r.imagens);
  }
  document.getElementById('arquivoImagens').onchange = async (ev) => {
    const st = document.getElementById('imgStatus');
    const arquivos = Array.prototype.slice.call(ev.target.files || []);
    if (!arquivos.length) return;
    const tipos = ['image/jpeg', 'image/png', 'image/webp'];
    let ok = 0;
    const erros = [];
    for (let i = 0; i < arquivos.length; i++) {
      const f = arquivos[i];
      if (tipos.indexOf(f.type) === -1) { erros.push(f.name + ': use JPG, PNG ou WEBP.'); continue; }
      if (f.size > 10 * 1024 * 1024) { erros.push(f.name + ': maior que 10 MB.'); continue; }
      st.textContent = 'Enviando ' + (i + 1) + ' de ' + arquivos.length + '...';
      try {
        const dados = await lerArquivoBase64(f);
        const r = await fetch('/imagens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nome: f.name, mimetype: f.type, dados: dados }),
        }).then((x) => x.json()).catch(() => null);
        if (r && r.ok) ok += 1;
        else erros.push(f.name + ': ' + ((r && r.erro) || 'falhou'));
      } catch (e) {
        erros.push(f.name + ': ' + (e && e.message ? e.message : 'falhou ao ler o arquivo.'));
      }
    }
    ev.target.value = '';
    const partes = [];
    if (ok) partes.push(ok + ' imagem(ns) adicionada(s).');
    if (erros.length) partes.push(erros.join(' '));
    st.textContent = partes.join(' ') || 'Nenhuma imagem adicionada.';
    carregarImagens();
  };
  carregarMensagemCampanha();
  carregarImagens();

  document.getElementById('arquivo').onchange = (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const leitor = new FileReader();
    leitor.onload = () => {
      document.getElementById('texto').value = leitor.result;
      document.getElementById('status').textContent =
        'Arquivo "' + f.name + '" carregado - confira e clique em Importar contatos.';
    };
    leitor.readAsText(f, 'utf-8');
  };
  document.getElementById('exportar').onclick = () => {
    window.location = '/exportar';
  };
  document.getElementById('subirBia').onclick = async () => {
    const st = document.getElementById('status');
    st.textContent = 'Subindo a Bia...';
    const r = await fetch('/bot/subir', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    st.textContent =
      r && r.ok
        ? 'Subindo a Bia. Se a sessao estiver boa, ela conecta em alguns segundos.'
        : 'Nao deu para subir: ' + ((r && r.erro) || 'falha no painel');
    setTimeout(carregarResumo, 1500);
  };
  document.getElementById('derrubarBia').onclick = async () => {
    const st = document.getElementById('status');
    if (!window.confirm('Derrubar a Bia (parar o bot)? Nada e apagado - para subir de novo, clique em Subir a Bia.')) return;
    st.textContent = 'Derrubando a Bia...';
    const r = await fetch('/bot/derrubar', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    st.textContent = r && r.ok ? 'A Bia esta parada.' : 'Nao deu para derrubar: ' + ((r && r.erro) || 'falha no painel');
    carregarResumo();
  };
  // "Testar visao agora": o teste de verdade e a sonda (a Bia manda uma
  // mensagem para si mesma e espera o eco). O painel so pede o teste pelo
  // arquivo data/sonda-agora e fica olhando o /resumo ate o resultado mudar.
  let visaoTestando = false;
  let ultimoSondaEm = null;
  function horaCurta(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function textoVisao(bot) {
    if (!bot.sondaResultado) return 'Visão: <b>nunca testada</b> - clique em "Testar visão agora".';
    const quando = bot.sondaEm ? ' (teste de ' + horaCurta(bot.sondaEm) + ')' : '';
    if (/:ok$/.test(bot.sondaResultado)) {
      return 'Visão: <b style="color:#1e8449;">ok</b> - o eco voltou' + quando + '. Ela está lendo.';
    }
    if (/indisponivel/.test(bot.sondaResultado)) {
      return 'Visão: não deu para testar' + quando + ' (a Bia caiu no meio do teste).';
    }
    const n = bot.sondaFalhas || 0;
    return (
      'Visão: <b style="color:#c0392b;">sem eco</b>' +
      (n ? ' (' + n + ' falha' + (n > 1 ? 's' : '') + ')' : '') +
      quando +
      ' - a sessão não está lendo.'
    );
  }
  document.getElementById('testarVisao').onclick = async () => {
    const visaoEstado = document.getElementById('visaoEstado');
    const botao = document.getElementById('testarVisao');
    visaoTestando = true;
    botao.disabled = true;
    visaoEstado.innerHTML = 'Visão: <b>testando…</b> a Bia manda uma mensagem para si mesma e espera o eco (até 40 s).';
    const antes = ultimoSondaEm;
    const r = await fetch('/bot/testar-visao', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    if (!r || !r.ok) {
      visaoTestando = false;
      visaoEstado.textContent = 'Visão: ' + ((r && r.erro) || 'não deu para pedir o teste.');
      carregarResumo();
      return;
    }
    const limite = Date.now() + 60000;
    let mudou = false;
    while (Date.now() < limite) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await fetch('/resumo', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      const b = s && s.bot;
      if (b && (b.sondaEm || null) !== antes) {
        mudou = true;
        break;
      }
    }
    visaoTestando = false;
    if (!mudou) {
      // Nao insistimos em "sem resultado": pode ser o bot caindo no meio do
      // teste ou o pedido nao ter chegado. O proximo ciclo de 5 s mostra o
      // estado real (que e o veredito que importa).
      document.getElementById('visaoEstado').textContent =
        'Visão: o teste não respondeu em 60 s (a Bia pode ter caído no meio).';
      return;
    }
    carregarResumo();
  };
  async function carregarLista() {
    const r = await fetch('/lista', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    const corpo = document.getElementById('listaCorpo');
    const tab = document.getElementById('listaTab');
    const vazia = document.getElementById('listaVazia');
    if (!r) {
      document.getElementById('qtdLista').textContent = '0';
      return;
    }
    document.getElementById('qtdLista').textContent = r.total;
    if (!r.contatos.length) {
      tab.style.display = 'none';
      vazia.style.display = 'block';
      corpo.innerHTML = '';
      return;
    }
    vazia.style.display = 'none';
    tab.style.display = 'table';
    corpo.innerHTML = r.contatos.map((c) => {
      const nome = esc(c.nome || '');
      const num = esc(c.numero || '');
      return '<tr style="border-top:1px solid #eef0f3;">' +
        '<td style="padding:8px 6px;">' + (nome || '<span style="color:#98a1ad;">(sem nome)</span>') + '</td>' +
        '<td style="padding:8px 6px;color:#5b6472;">' + num + '</td>' +
        '<td style="padding:8px 6px;text-align:right;">' +
        '<button class="secundario remover" data-numero="' + num + '" style="padding:4px 10px;font-size:13px;">Remover</button>' +
        '</td></tr>';
    }).join('');
    for (const b of document.querySelectorAll('.remover')) {
      b.onclick = async () => {
        const num = b.dataset.numero;
        if (!window.confirm('Remover ' + num + ' da lista?\\n\\nA Bia deixa de responder a esse numero. O historico (quem pediu "sair") e preservado. Continuar?')) return;
        await fetch('/remover', form({ numero: num })).then((x) => x.json()).catch(() => null);
        carregarResumo();
        carregarLista();
      };
    }
  }
  // As mensagens que chegaram na Bia: quem escreveu, o que escreveu, e se a
  // equipe (a equipe) ja foi avisada. O texto vem de ESTRANGOS - por isso
  // tudo passa pelo esc() antes de virar HTML.
  async function carregarMensagens() {
    const r = await fetch('/mensagens', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (!r) return;
    const box = document.getElementById('msgLista');
    const vazia = document.getElementById('msgVazia');
    if (!r.mensagens.length) {
      box.style.display = 'none';
      vazia.style.display = 'block';
      return;
    }
    vazia.style.display = 'none';
    box.style.display = 'block';
    box.innerHTML = r.mensagens.map((m) => {
      const nome = esc(m.nome || '');
      const num = esc(m.numero || '');
      const txt = esc(m.texto || '');
      const quando = esc(fmt(m.em));
      const aviso = m.avisouEquipe
        ? '<span class="pill on">equipe avisada</span>'
        : '<span class="pill off">sem aviso</span>';
      return '<div style="border-top:1px solid #eef0f3;padding:8px 0;">' +
        '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">' +
        '<b>' + (nome || '<span style="color:#98a1ad;">(sem nome)</span>') + '</b>' +
        '<span style="color:#5b6472;">' + num + '</span>' +
        '<span style="color:#98a1ad;font-size:12px;">' + quando + '</span>' +
        aviso +
        '</div>' +
        '<div style="margin-top:2px;white-space:pre-wrap;">' + txt + '</div>' +
        '</div>';
    }).join('');
  }
  document.getElementById('importar').onclick = async () => {
    const texto = document.getElementById('texto').value;
    const st = document.getElementById('status');
    st.textContent = 'Importando...';
    const r = await fetch('/importar', form({ texto })).then((x) => x.json()).catch(() => null);
    st.textContent = '';
    const el = document.getElementById('resultado');
    el.style.display = 'block';
    if (!r) {
      el.innerHTML = '<h2>Resultado</h2><p class="ruim">Não foi possível importar. Tente de novo.</p>';
      return;
    }
    el.innerHTML = '<h2>Resultado</h2><p><span class="bom">' + r.novos.length +
      '</span> novo(s), <b>' + r.repetidos + '</b> repetido(s), <span class="ruim">' +
      r.invalidos.length + '</span> inválido(s).</p>' +
      (r.novos.length ? '<ul>' + r.novos.map((n) => '<li>' + (n.nome ? n.nome + ' &mdash; ' : '') + n.numero + '</li>').join('') + '</ul>' : '');
    document.getElementById('texto').value = '';
    carregarResumo();
    carregarLista();
  };
  document.getElementById('limpar').onclick = async () => {
    const st = document.getElementById('status');
    const el = document.getElementById('resultado');
    const r0 = await fetch('/resumo', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    const total = r0 ? r0.totalNaLista : '?';
    if (!window.confirm('Limpar TODOS os ' + total + ' contatos da lista?\\n\\n' +
      'A Bia para de responder a todos. O histórico (quem pediu "sair") é preservado.\\n' +
      'Um backup é salvo antes. Continuar?')) return;
    st.textContent = 'Limpando...';
    const r = await fetch('/limpar', form({ confirmar: '1' })).then((x) => x.json()).catch(() => null);
    st.textContent = '';
    el.style.display = 'block';
    if (!r || !r.ok) {
      el.innerHTML = '<h2>Resultado</h2><p class="ruim">Não foi possível limpar a lista.</p>';
      return;
    }
    el.innerHTML = '<h2>Resultado</h2><p><span class="bom">' + r.antes +
      '</span> contato(s) removido(s). A lista está vazia.</p>' +
      '<p>Importe a lista nova na etapa 1 quando quiser; a Bia volta sozinha.</p>';
    carregarResumo();
    carregarLista();
  };
  document.getElementById('enviar').onclick = async () => {
    const btn = document.getElementById('enviar');
    const st = document.getElementById('status');
    if (btn.dataset.ligada !== '1') {
      const r = await fetch('/resumo', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      if (!r || !r.pendentes) {
        st.textContent = 'Não há contatos novos. Importe a lista primeiro (etapa 1).';
        return;
      }
      if (r.bot && r.bot.cegueira) {
        st.textContent = 'A Bia está marcada como cega (não está lendo). Re-pareie antes de enviar.';
        return;
      }
      await fetch('/campanha', form({ ligada: '1' })).then((x) => x.json()).catch(() => null);
      st.textContent = 'Envio ligado: a Bia vai mandando até ' + r.porDia + '/dia. Pode pausar quando quiser.';
    } else {
      await fetch('/campanha', form({ ligada: '0' })).then((x) => x.json()).catch(() => null);
      st.textContent = 'Envio pausado.';
    }
    carregarResumo();
  };
  async function pedirPareamento(modo) {
    const st = document.getElementById('status');
    const dados = { modo };
    if (modo === 'codigo') {
      // O codigo e gerado PARA UM NUMERO. Se nao for o numero do celular
      // que vai conectar, o WhatsApp responde "nao foi possivel conectar"
      // todas as vezes - por isso o campo e obrigatorio aqui. Char class em
      // vez de \d: este script mora dentro de um template literal e o
      // backslash seria comido antes de chegar ao navegador.
      const campo = document.getElementById('numeroPareamento');
      let numero = String(campo.value || '').replace(/[^0-9]/g, '');
      // DDD + numero (10/11) ganha o 55 do Brasil. Sem isso o codigo e gerado
      // para um numero diferente e nunca conecta.
      if (numero.length === 10 || numero.length === 11) numero = '55' + numero;
      campo.value = numero;
      if (!/^[0-9]{12,15}$/.test(numero)) {
        st.textContent = 'Digite o número do WhatsApp que vai conectar (com 55 e DDD, só dígitos).';
        campo.focus();
        campo.scrollIntoView({ block: 'center' });
        return;
      }
      dados.numero = numero;
    }
    const pergunta = modo === 'codigo'
      ? 'Isto pausa o bot por cerca de 1 minuto para gerar o código. Continuar?'
      : 'Isto pausa o bot por cerca de 1 minuto para mostrar o QR. Continuar?';
    if (!window.confirm(pergunta)) return;
    st.textContent = modo === 'codigo' ? 'Gerando o código...' : 'Preparando o QR...';
    await fetch('/parear', form(dados)).then((x) => x.json()).catch(() => null);
    st.textContent = modo === 'codigo'
      ? 'No celular, escolha "Conectar com número de telefone" e digite o código.'
      : 'Escaneie o QR com o celular do número que o bot vai usar.';
    carregarResumo();
  }
  document.getElementById('parear').onclick = () => pedirPareamento('qr');
  document.getElementById('parearCodigo').onclick = () => pedirPareamento('codigo');
  document.getElementById('novoCodigo').onclick = () => pedirPareamento('codigo');
  document.getElementById('desvincular').onclick = async () => {
    const st = document.getElementById('status');
    if (!window.confirm('Isto pausa o bot e remove o aparelho atual do WhatsApp, liberando vaga. A sessão vira backup. Continuar?')) return;
    st.textContent = 'Desvinculando...';
    const r = await fetch('/desvincular', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    st.textContent = r && r.ok
      ? 'Aparelho desvinculado. Clique em "Conectar / Trocar número (QR)" para parear de novo.'
      : 'Não foi possível desvincular. Veja se o bot está parado.';
    carregarResumo();
  };
  document.getElementById('cancelar').onclick = async () => {
    const st = document.getElementById('status');
    st.textContent = 'Cancelando...';
    await fetch('/cancelar', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    st.textContent = 'Pareamento cancelado. Pode tentar de novo.';
    carregarResumo();
  };
  function loop() { carregarResumo().then(() => carregarLista()).then(() => carregarMensagens()).then(() => setTimeout(loop, 5000)); }
  loop();
</script>
</body>
</html>`;

function lerCorpo(req, limite = 5000000) {
  return new Promise((resolve) => {
    let dados = '';
    let estourou = false;
    req.on('data', (c) => {
      if (estourou) return;
      dados += c;
      if (dados.length > limite) {
        estourou = true;
        req.destroy();
        resolve('');
      }
    });
    req.on('end', () => {
      if (!estourou) resolve(dados);
    });
    req.on('error', () => {
      if (!estourou) resolve('');
    });
  });
}

function responderJson(res, codigo, obj) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function resumirImportacao(r) {
  return {
    novos: r.novos.map((n) => ({ numero: n.numero, nome: n.nome })),
    repetidos: r.repetidos.length,
    invalidos: r.invalidos.map((n) => n.numero),
    equipe: r.equipe.map((n) => n.numero),
    total: r.total,
  };
}

function pidVivo(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe mas e de outro usuario. Existe.
    return e.code === 'EPERM';
  }
}

// Estado do bot para a tela: online/offline e ultima atividade.
function statusBot() {
  let h = {};
  try {
    h = JSON.parse(fs.readFileSync(path.join(config.dataFolder, 'health.json'), 'utf8'));
  } catch {
    // silencio-ok: sem health.json ainda; a tela mostra "offline".
  }
  // O 428 e lido do proprio health.json (o mesmo arquivo do painel), sem
  // depender do processo do bot.
  const limitacao = (function () {
    const hist = Array.isArray(h.desconexoes) ? h.desconexoes : [];
    const janela = Date.now() - 30 * 60000;
    const cortes = hist.filter(
      (d) => d && String(d.motivo) === '428' && Date.parse(d.em) >= janela
    );
    return { limitado: cortes.length >= 2, quantidade: cortes.length };
  })();
  let pid = null;
  try {
    // A trava carrega PID + boot ID (o Windows reusa PID). `trava.ler()`
    // entende os dois formatos; ler o arquivo na mao quebrava com o JSON.
    pid = trava.ler();
  } catch {
    // silencio-ok: sem trava de PID; a tela mostra "offline".
  }
  const vivo = pidVivo(pid);
  return {
    online: vivo && h.socketEstado === 'open',
    vivo,
    socket: h.socketEstado || null,
    conectadoEm: h.conectadoEm || null,
    ultimoEnvioEm: h.ultimoEnvioEm || null,
    ultimoInboundEm: h.ultimoInboundEm || null,
    surdo: Boolean(h.surdo),
    // Cegueira: o veredito do discriminador. "surdo" e so silencio; "cegueira"
    // e mensagem chegando sem conseguir ler.
    cegueira: Boolean(h.cegueira),
    cegueiraConfirmada: Boolean(h.cegueiraConfirmada),
    cegueiraDesde: h.cegueiraDesde || null,
    cegueiraEvidencia: h.cegueiraEvidencia || null,
    // Conta sob limitacao do WhatsApp (428): o numero barrado por limite de
    // taxa, nao problema de criptografia. Problema diferente, aviso diferente.
    limitado: limitacao.limitado,
    desconexoes428: limitacao.quantidade,
    falhasDecrypt: h.falhasDecrypt || 0,
    semCorpo: (h.descartes && h.descartes.sem_corpo) || 0,
    // Sonda de visao: a ultima prova de que a sessao decripta. Alimenta o
    // "Visao: ok/sem eco" do painel e o botao "Testar visao agora".
    sondaEm: h.ultimaSondaEm || null,
    sondaResultado: h.sondaResultado || null,
    sondaFalhas: h.sondaFalhas || 0,
    precisaReligar: fs.existsSync(path.join(config.dataFolder, 'precisa-religar')),
    // Por que a Bia nao esta no ar DEPOIS que o dono mandou subir. A prova de
    // boot (lista vazia, numero invalido, falta de biblioteca de imagem...)
    // grava o motivo em data/ultimo-erro-boot.json e a tela mostra. Antes o
    // botao respondia "ok" e a tela ficava so "parada", sem pista nenhuma.
    motivoParada: vivo || !botDesejado() ? null : bootCheck.lerFalha(config.dataFolder),
  };
}

function statusWatchdog() {
  try {
    const txt = fs.readFileSync(path.join(config.dataFolder, 'watchdog.heartbeat'), 'utf8').trim();
    const t = Date.parse(txt);
    const idadeSegundos = Number.isNaN(t) ? null : Math.round((Date.now() - t) / 1000);
    // O watchdog bate a cada ~30s; 120s de silencio significa que ele morreu.
    return { heartbeat: txt, idadeSegundos, vivo: idadeSegundos !== null && idadeSegundos < 120 };
  } catch {
    // silencio-ok: sem heartbeat ainda (watchdog nunca subiu); a tela mostra morto.
    return { heartbeat: null, idadeSegundos: null, vivo: false };
  }
}

function resumoCompleto() {
  return {
    ...campanha.resumo(),
    totalNaLista: numeros.carregar().entradas.length,
    bot: statusBot(),
    pareamento: estadoPareamento(),
    watchdog: statusWatchdog(),
  };
}

// ---- Pareamento / troca de numero ----------------------------------------
// O painel controla o bot pelo Agendador do Windows. Parear exige socket
// unico: por isso o bot e o watchdog param, o QR aparece, e ao conectar o bot
// volta sozinho. A auth antiga e guardada (nao se perde nada).

let pareando = false;
let pareamentoIniciadoEm = null;
let pareamentoModo = 'qr';
// Cada tentativa de pareamento recebe um numero de geracao. Se o operador
// clica de novo (ou cancela) enquanto um connect.js esta vivo, a geracao sobe
// e o callback do filho antigo vira no-op - assim um QR abandonado nao trava o
// painel nem apaga a sessao de quem ja estava pareado.
let pareamentoGeracao = 0;
let pareamentoBackup = null;
let pareamentoTinhaSessao = false;
let pareamentoDeviceAntes = null;
let pareamentoNumero = null;

// Credenciais de uma sessao DE VERDADE. O creds.json de um pareamento por
// codigo (requestPairingCode) e gravado antes de o celular confirmar: tem
// me.id SEM o sufixo ":<dispositivo>", me.name "~" e nenhum account. Tratar
// essa casca como sessao fazia o painel exibir "numero pareado" com o numero
// de teste e "restaurar" o arquivo invalido ao cancelar. Sem dispositivo e sem
// account, nao e sessao.
function credsDeSessao() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(config.authFolder, 'creds.json'), 'utf8'));
    const id = c && c.me && c.me.id ? String(c.me.id) : '';
    if (!id.includes(':') || !c.account) return null;
    return c;
  } catch {
    // silencio-ok: sem creds; ainda nao pareado.
    return null;
  }
}

function numeroPareado() {
  const c = credsDeSessao();
  if (!c) return null;
  return String(c.me.id).split(':')[0].split('@')[0];
}

function deviceCompleto() {
  const c = credsDeSessao();
  return c ? String(c.me.id) : null;
}

function codigoPareamento() {
  try {
    const txt = fs.readFileSync(path.join(config.dataFolder, 'pair_code.txt'), 'utf8').trim();
    return txt.split('\n')[0] || null;
  } catch {
    // silencio-ok: nenhum codigo gerado ainda.
    return null;
  }
}

// Numero que sera usado no proximo pareamento por codigo. Fica em data/ para
// sobreviver ao restart (a Bia pode trocar de numero; o config nao deve ser
// a unica fonte). O config e so o valor inicial.
function arquivoNumeroPareamento() {
  return path.join(config.dataFolder, 'numero-pareamento.txt');
}

// Numero em E.164 sem '+'. Quem digita "11994830459" (DDD + numero) quer dizer
// "5511900000000": sem o 55 o WhatsApp gera um codigo para um numero que nao
// existe, a conexao morre (428) e o operador acha que o codigo "expirou" sem
// nunca completar o pareamento.
function normalizarNumeroPareamento(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

function numeroSalvo() {
  try {
    const n = normalizarNumeroPareamento(fs.readFileSync(arquivoNumeroPareamento(), 'utf8'));
    return n || null;
  } catch {
    // silencio-ok: nenhum numero salvo ainda.
    return null;
  }
}

function numeroSugerido() {
  const salvo = numeroSalvo();
  if (salvo) return salvo;
  return normalizarNumeroPareamento(config.numeroPareamento) || null;
}

function salvarNumeroPareamento(numero) {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    fs.writeFileSync(arquivoNumeroPareamento(), normalizarNumeroPareamento(numero), 'utf8');
  } catch (e) {
    console.error(`[painel] falha ao guardar o numero do pareamento: ${e.message}`);
  }
}

function estadoPareamento() {
  return {
    pareando,
    iniciadoEm: pareamentoIniciadoEm,
    modo: pareamentoModo,
    numero: numeroPareado(),
    numeroSugerido: numeroSugerido(),
    numeroSalvo: numeroSalvo(),
    codigo: codigoPareamento(),
  };
}

function rodarNode(script) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script], { cwd: __dirname }, (e) => (e ? reject(e) : resolve()));
  });
}

// ---- Subir / derrubar ------------------------------------------------------
//
// Windows: Tarefa Agendada BiaBot / watchdog.ps1 (como sempre foi).
// Linux/macOS: supervisor.js.
// A escolha mora em plataforma.js - o painel so pede "sobe" e "derruba".
function pararBot() {
  botSuspendido = true;
  return plataforma.pararTudo();
}

function iniciarBot() {
  botSuspendido = false;
  return plataforma.iniciarSupervisor();
}

// ---- Auto-cura do supervisor (D2) -----------------------------------------
//
// O watchdog morreu em 19/10 e NADA o trouxe de volta: a Bia ficou fora do ar
// ate alguem olhar a tela. O painel e o processo que fica de pe o tempo todo
// (ele so morre se a maquina cair), entao e ele quem reergue o supervisor
// quando o heartbeat dele para.
//
// Mas reerguer so vale se o DONO quer a Bia no ar: "bot-desejado" e essa
// memoria (arquivo, nao variavel - senao reabrir o painel acordava o bot
// sozinho, que e exatamente o que o dono nao quer).
//
// Nao usa setInterval: a regra do projeto e um agendador so (o tick do
// lifecycle). Aqui e um timeout que se reagenda.
const CURA_INTERVALO_MS = 60 * 1000;
const CURA_COOLDOWN_MS = 5 * 60 * 1000;
let ultimaCuraEm = 0;
// O bot fica suspenso enquanto o painel mexe nele (parear, desvincular): se
// nao, a auto-cura religaria o watchdog no meio do pareamento e o bot
// disputaria o socket com o connect.js.
let botSuspendido = false;

function arquivoDesejado() {
  return path.join(config.dataFolder, 'bot-desejado');
}
function botDesejado() {
  return fs.existsSync(arquivoDesejado());
}
function marcarDesejada(sim) {
  try {
    fs.mkdirSync(config.dataFolder, { recursive: true });
    if (sim) {
      fs.writeFileSync(arquivoDesejado(), new Date().toISOString(), 'utf8');
    } else {
      fs.rmSync(arquivoDesejado(), { force: true });
    }
  } catch (e) {
    console.error(`[painel] falha ao gravar bot-desejado: ${e.message}`);
  }
}

function autoCuraWatchdog() {
  const t = setTimeout(async () => {
    try {
      if (!botSuspendido && !pareando && botDesejado()) {
        const st = statusWatchdog();
        if (!st.vivo) {
          const agora = Date.now();
          if (agora - ultimaCuraEm >= CURA_COOLDOWN_MS) {
            ultimaCuraEm = agora;
            console.error(
              `[painel] supervisor sem heartbeat ha ${st.idadeSegundos === null ? '?' : st.idadeSegundos}s - reerguendo.`
            );
            await iniciarBot();
          }
        }
      }
    } catch (e) {
      console.error(`[painel] falha na auto-cura do supervisor: ${e.message}`);
    } finally {
      autoCuraWatchdog();
    }
  }, CURA_INTERVALO_MS);
  if (t.unref) t.unref();
}

function iniciarPareamento(modo, numero = null) {
  // Sempre (re)comeca - se ja havia um pareamento em andamento, ele e
  // substituido. Sem isto, um QR/codigo abandonado deixava "pareando" preso
  // para sempre (o connect.js fica vivo reconectando) e o operador nao
  // conseguia tentar de novo nem trocar de QR para codigo.
  pareamentoModo = modo === 'codigo' ? 'codigo' : 'qr';
  pareando = true;
  // O codigo e gerado PARA um numero. Vem do campo do painel (a Bia pode ter
  // trocado de numero) e fica salvo para o proximo pareamento.
  if (pareamentoModo === 'codigo' && numero) salvarNumeroPareamento(numero);
  pareamentoNumero = pareamentoModo === 'codigo' ? numero || numeroSugerido() : null;
  // Parear e, por definicao, deixar a Bia fora do ar ate terminar. Nao sobe
  // de volta sozinha: quem decide e o botao "Subir a Bia".
  marcarDesejada(false);
  pareamentoIniciadoEm = new Date().toISOString();
  pareamentoTinhaSessao = numeroPareado() !== null;
  pareamentoDeviceAntes = deviceCompleto();
  pareamentoBackup = null;
  const geracao = ++pareamentoGeracao;
  (async () => {
    await pararBot();
    await new Promise((r) => setTimeout(r, 2500));
    if (geracao !== pareamentoGeracao) return; // outra tentativa assumiu
    const backup = `${config.authFolder}-antes-${Date.now()}`;
    try {
      if (fs.existsSync(config.authFolder)) {
        fs.renameSync(config.authFolder, backup);
        pareamentoBackup = backup;
      }
    } catch (e) {
      console.error(`[painel] falha ao guardar a auth antiga: ${e.message}`);
    }
    for (const arq of ['qr.png', 'pair_code.txt', 'pareamento-ok']) {
      try {
        fs.rmSync(path.join(config.dataFolder, arq), { force: true });
      } catch {
        // silencio-ok: arquivo ausente ja e o caso normal.
      }
    }
    const env =
      pareamentoModo === 'codigo'
        ? { ...process.env, BIA_PAIR: '1', BIA_NUMERO: String(pareamentoNumero || '') }
        : process.env;
    const filho = spawn(process.execPath, [path.join(__dirname, 'connect.js')], { cwd: __dirname, env, stdio: 'ignore' });
    filho.on('close', () => {
      if (geracao !== pareamentoGeracao) return; // substituido/cancelado: nao mexe
      concluirPareamento();
    });
  })();
  return true;
}

function concluirPareamento() {
  pareando = false;
  // Sucesso = o marcador do connect.js OU um device NOVO (id ":NN" diferente).
  // Sem o device, uma tentativa que falhou mas deixou o creds.json pela metade
  // era lida como sucesso; e o inverso (restaurar sessao antiga por cima de um
  // pareamento bom) deslogava o bot, como aconteceu.
  const marcador = fs.existsSync(path.join(config.dataFolder, 'pareamento-ok'));
  const deviceDepois = deviceCompleto();
  const pareou = marcador || (deviceDepois !== null && deviceDepois !== pareamentoDeviceAntes);
  // Se o pareamento NAO completou e havia uma sessao antes, devolve a auth
  // antiga. Sem isto, um QR nao escaneado (ou um connect que abortou na
  // trava) deixava a Bia sem credencial nenhuma - e ela ia direto para o
  // "religue pelo painel", num ciclo de QR que agrava o bloqueio do numero.
  if (!pareou && pareamentoBackup && pareamentoTinhaSessao) {
    try {
      fs.rmSync(config.authFolder, { recursive: true, force: true });
      fs.renameSync(pareamentoBackup, config.authFolder);
      console.error('[painel] pareamento nao completou; sessao antiga restaurada.');
    } catch (e) {
      console.error(`[painel] falha ao restaurar a auth antiga: ${e.message}`);
    }
  }
  pareamentoBackup = null;
  // Casca de pareamento que sobrou (creds.json sem account/dispositivo) nao e
  // sessao e nao serve para nada: guarda como falha, senao a proxima leitura
  // acha que ha numero pareado (foi o que aconteceu com o numero de teste).
  if (!pareou && !credsDeSessao() && fs.existsSync(config.authFolder)) {
    try {
      fs.renameSync(config.authFolder, `${config.authFolder}_falha_${Date.now()}`);
      console.error('[painel] casca de pareamento movida para auth_falha_*.');
    } catch (e) {
      console.error(`[painel] falha ao mover a casca de pareamento: ${e.message}`);
    }
  }
  // QR/codigo de uma tentativa encerrada nao vale mais: some da pasta para
  // ninguem achar que ainda esta valendo.
  for (const arq of ['qr.png', 'pair_code.txt']) {
    try {
      fs.rmSync(path.join(config.dataFolder, arq), { force: true });
    } catch {
      // silencio-ok: arquivo ausente ja e o caso normal.
    }
  }
  // Pareou de verdade: a partir de agora este e o numero da Bia. Guardar
  // evita que o proximo pareamento por codigo use o numero antigo.
  if (pareou) {
    const numero = numeroPareado();
    if (numero) salvarNumeroPareamento(numero);
  }
  // NAO sobe o bot sozinho. O dono pediu controle explicito: parear devolve o
  // aparelho, e quem sobe a Bia e o botao "Subir a Bia". (botSuspendido segue
  // true, entao nem a auto-cura do supervisor nem o watchdog a levantam.)
  console.error('[painel] pareamento encerrado. Suba a Bia pelo botao "Subir a Bia".');
}

async function cancelarPareamento() {
  if (!pareando) return false;
  pareamentoGeracao += 1; // invalida o filho atual
  await pararBot();
  await new Promise((r) => setTimeout(r, 1500));
  concluirPareamento();
  return true;
}

// ---- CSRF: o painel e local, mas "local" nao e "seguro" -------------------
//
// O painel so escuta em 127.0.0.1, mas QUALQUER pagina da internet que o
// navegador abrir pode mandar POST para http://127.0.0.1:3001/limpar (e
// apagar a lista) ou /importar (e meter numero estranho). O navegador manda
// o cabecalho Origin em toda requisicao vinda de uma pagina, entao comparar
// com a propria origem barra o ataque. Sem isso, um link malicioso aberto no
// navegador da empresa apaga a lista da Bia.
function origemPermitida(req) {
  const host = String(req.headers.host || '');
  if (host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origem = req.headers.origin;
  if (origem && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origem)) return false;
  return true;
}

const servidor = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && !origemPermitida(req)) {
      console.error(`[painel] POST bloqueado (origem ${req.headers.origin || 'desconhecida'}).`);
      responderJson(res, 403, { ok: false, erro: 'origem nao permitida' });
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGINA);
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/favicon.ico')) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/resumo')) {
      responderJson(res, 200, resumoCompleto());
      return;
    }

    // ---- Mensagem da campanha (editavel; o bot le a cada envio) ----
    if (req.method === 'GET' && req.url === '/mensagens-campanha') {
      responderJson(res, 200, mensagensCampanha.ler());
      return;
    }
    if (req.method === 'POST' && req.url === '/mensagens-campanha/restaurar') {
      responderJson(res, 200, mensagensCampanha.restaurar());
      return;
    }
    if (req.method === 'POST' && req.url === '/mensagens-campanha') {
      const corpo = new URLSearchParams(await lerCorpo(req));
      try {
        responderJson(res, 200, mensagensCampanha.salvar({ comNome: corpo.get('comNome'), semNome: corpo.get('semNome') }));
      } catch (e) {
        responderJson(res, 400, { ok: false, erro: e.message });
      }
      return;
    }

    // ---- Imagens da campanha ----
    if (req.method === 'GET' && req.url === '/imagens') {
      responderJson(res, 200, {
        imagens: imagensPainel.listar().map((i) => ({ nome: i.nome, tamanho: i.tamanho, mimetype: i.mimetype })),
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/imagens/')) {
      let nome = '';
      try {
        nome = decodeURIComponent(req.url.slice('/imagens/'.length));
      } catch (e) {
        console.error('[painel] nome de imagem invalido:', e.message);
        responderJson(res, 400, { ok: false, erro: 'nome inválido' });
        return;
      }
      const arq = imagensPainel.caminhoDe(nome);
      if (!arq) {
        responderJson(res, 404, { ok: false, erro: 'imagem não encontrada' });
        return;
      }
      try {
        const buf = fs.readFileSync(arq);
        res.writeHead(200, {
          'Content-Type': imagensPainel.mimeDe(nome) || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(buf);
      } catch (e) {
        responderJson(res, 500, { ok: false, erro: e.message });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/imagens/remover') {
      const corpo = new URLSearchParams(await lerCorpo(req));
      const r = imagensPainel.remover(corpo.get('nome') || '');
      responderJson(res, r.ok ? 200 : 400, r);
      return;
    }
    if (req.method === 'POST' && req.url === '/imagens') {
      let corpo;
      try {
        corpo = JSON.parse(await lerCorpo(req, 20000000));
      } catch (e) {
        console.error('[painel] upload de imagem invalido:', e.message);
        responderJson(res, 400, { ok: false, erro: 'envio inválido' });
        return;
      }
      try {
        const r = imagensPainel.salvar({ nome: corpo.nome, mimetype: corpo.mimetype, dadosBase64: corpo.dados });
        responderJson(res, 200, { ok: true, ...r });
      } catch (e) {
        responderJson(res, 400, { ok: false, erro: e.message });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/mensagens') {
      // O feed de mensagens recebidas. Leve de propósito: o painel recarrega
      // isso a cada 5 s, e o /resumo (que le a lista inteira) ja demora.
      // O nome e limpo na exibicao (inclusive no historico antigo): o feed e
      // a lista vieram cheios de emoji, que nao e nome.
      const lista = mensagens.listar(20).map((m) => (m ? { ...m, nome: limparNome(m.nome) } : m));
      responderJson(res, 200, { mensagens: lista });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/importar')) {
      const texto = new URLSearchParams(await lerCorpo(req)).get('texto') || '';
      const r = importar(texto);
      // Se a lista voltou a ter contatos, religa o bot: ele recusa subir com a
      // lista vazia (falha fechada), entao depois de uma limpeza ele fica down
      // ate alguem importar. Isto fecha o ciclo sozinho.
      if (r.total > 0) iniciarBot();
      responderJson(res, 200, { ok: true, ...resumirImportacao(r) });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/lista')) {
      const contatos = numeros.carregar().entradas;
      responderJson(res, 200, { total: contatos.length, contatos });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/exportar')) {
      // Download da lista no mesmo formato do import (numero;Nome), para o
      // operador guardar uma copia ou reimportar em outra maquina.
      let corpo = '';
      try {
        corpo = fs.readFileSync(config.numerosArquivo, 'utf8');
      } catch (e) {
        // silencio-ok: lista ainda nao existe; exporta so o cabecalho padrao vazio.
        console.error(`[painel] exportar: ${e.message}`);
      }
      const hoje = atendimento.hojeISO();
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="lista-contatos-${hoje}.txt"`,
        'Cache-Control': 'no-store',
      });
      res.end(corpo);
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/remover')) {
      const numero = new URLSearchParams(await lerCorpo(req)).get('numero');
      const r = removerContato(numero);
      console.error(`[painel] remover ${r.numero || numero}: ${r.removido ? 'removido' : 'nao encontrado'}.`);
      if (numeros.carregar().entradas.length > 0) iniciarBot();
      responderJson(res, 200, { ok: r.removido, ...r, resumo: resumoCompleto() });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/limpar')) {
      const corpo = new URLSearchParams(await lerCorpo(req));
      if (corpo.get('confirmar') !== '1') {
        responderJson(res, 400, { ok: false, erro: 'confirmacao ausente' });
        return;
      }
      const r = limparLista();
      console.error(`[painel] lista limpa (${r.antes} contato(s) removido(s)).`);
      responderJson(res, 200, { ok: true, ...r, resumo: resumoCompleto() });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/campanha')) {
      const ligada = new URLSearchParams(await lerCorpo(req)).get('ligada');
      if (ligada === '1') campanha.ligar();
      else campanha.desligar();
      responderJson(res, 200, resumoCompleto());
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/qr.png')) {
      fs.readFile(path.join(config.dataFolder, 'qr.png'), (e, buf) => {
        if (e) {
          res.writeHead(404, { 'Cache-Control': 'no-store' });
          res.end('sem qr');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/bot/subir')) {
      // Subir a Bia e uma decisao EXPLICITA do dono. Aqui tambem apagamos a
      // marca de "precisa religar": se ele mandou subir, tenta de novo agora
      // (sem isto o supervisor ficaria quieto por ate 2 h).
      if (pareando) {
        responderJson(res, 409, { ok: false, erro: 'termine ou cancele o pareamento antes' });
        return;
      }
      // Antes de acordar o supervisor, roda a MESMA prova de boot que ele roda.
      // Sem isto o dono clicava, recebia "ok" e a tela ficava "parada" sem
      // motivo - foi exatamente o que aconteceu com a lista vazia.
      const prova = bootCheck.validarBoot({ raiz: __dirname, dataFolder: config.dataFolder });
      if (!prova.ok) {
        bootCheck.registrarFalha(config.dataFolder, prova.saida);
        console.error(`[painel] "Subir a Bia" recusado: ${bootCheck.resumir(prova.saida)}`);
        responderJson(res, 409, {
          ok: false,
          erro: bootCheck.resumir(prova.saida),
          detalhe: prova.saida,
        });
        return;
      }
      bootCheck.limparFalha(config.dataFolder);
      try {
        fs.rmSync(path.join(config.dataFolder, 'precisa-religar'), { force: true });
      } catch {
        // silencio-ok: marca ausente ja e o caso normal.
      }
      marcarDesejada(true);
      await iniciarBot();
      responderJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/bot/derrubar')) {
      if (pareando) {
        responderJson(res, 409, { ok: false, erro: 'pareamento em andamento - use Cancelar' });
        return;
      }
      marcarDesejada(false);
      await pararBot();
      responderJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/bot/testar-visao')) {
      // Teste de visao sob demanda: o painel nao tem socket, quem tem e o bot.
      // Aqui so deixamos o pedido em data/sonda-agora; o bot responde em ate
      // 5 s mandando uma mensagem para si mesmo e esperando o eco. O resultado
      // vai para health.json (sondaResultado) e para a linha "Visao" da tela.
      if (pareando) {
        responderJson(res, 409, { ok: false, erro: 'termine ou cancele o pareamento antes' });
        return;
      }
      const st = statusBot();
      if (!st.online) {
        responderJson(res, 409, {
          ok: false,
          erro: st.vivo ? 'a Bia ainda nao conectou - aguarde o "no ar"' : 'suba a Bia primeiro',
        });
        return;
      }
      try {
        fs.writeFileSync(path.join(config.dataFolder, 'sonda-agora'), new Date().toISOString(), 'utf8');
      } catch (e) {
        responderJson(res, 500, { ok: false, erro: 'nao deu para pedir o teste: ' + e.message });
        return;
      }
      console.error('[painel] teste de visao pedido pelo dono.');
      responderJson(res, 202, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/parear')) {
      const corpo = new URLSearchParams(await lerCorpo(req));
      const modo = corpo.get('modo');
      let numero = null;
      if (modo === 'codigo') {
        // O codigo e gerado PARA este numero. Sem ele (ou com numero de outro
        // celular), o WhatsApp responde "nao foi possivel conectar" sempre.
        numero = normalizarNumeroPareamento(corpo.get('numero'));
        if (!/^\d{12,15}$/.test(numero)) {
          responderJson(res, 400, {
            ok: false,
            erro: 'informe o numero do WhatsApp que vai conectar (com 55 e DDD, so digitos)',
          });
          return;
        }
      }
      iniciarPareamento(modo, numero);
      responderJson(res, 200, estadoPareamento());
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/cancelar')) {
      await cancelarPareamento();
      responderJson(res, 200, estadoPareamento());
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/desvincular')) {
      if (pareando) {
        responderJson(res, 409, { ok: false, erro: 'pareamento em andamento' });
        return;
      }
      await pararBot();
      marcarDesejada(false);
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await rodarNode('desvincular.js');
        responderJson(res, 200, { ok: true, ...estadoPareamento() });
      } catch (e) {
        responderJson(res, 500, { ok: false, erro: e.message });
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    responderJson(res, 500, { ok: false, erro: e.message });
  }
});

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`Painel da Bia em http://127.0.0.1:${PORTA}/`);
  console.log('Deixe esta janela aberta. Feche quando terminar.');
});

// A auto-cura do supervisor so comeca depois que o painel esta no ar.
autoCuraWatchdog();
