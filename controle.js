'use strict';

// ============================================================
// Controle do painel pelo terminal - o equivalente Linux/macOS do
// "Ligar Bia" / "Desligar Bia" do Windows (ligar-bia.ps1 / desligar-bia.ps1).
//
//   node controle.js subir     sobe o painel e abre o navegador
//   node controle.js descer    derruba painel + supervisor + bot (nada e apagado)
//   node controle.js status    diz o que esta no ar
//   node controle.js reiniciar descer e subir
//
// O painel sobe solto do terminal (detached): fechar a janela nao derruba a
// Bia. Quem mantem o painel de pe 24h e o systemd (ver systemd/bia-painel.service).
// ============================================================

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');
const privacidade = require('./privacidade');
const plataforma = require('./plataforma');

const RAIZ = __dirname;
const DATA = config.dataFolder;
const PORTA = Number(process.env.BIA_PAINEL_PORTA || 3001);
const URL_PAINEL = `http://127.0.0.1:${PORTA}/`;
const UNIDADE = 'bia-painel';

const dormir = plataforma.dormir;

function escrever(msg) {
  console.log(msg);
}

function painelRespondendo() {
  return new Promise((resolve) => {
    const req = http.get(URL_PAINEL, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function systemdAtivo() {
  if (!plataforma.EH_LINUX || !plataforma.temComando('systemctl')) return false;
  try {
    const { execFileSync } = require('child_process');
    const saida = execFileSync('systemctl', ['--user', 'is-active', UNIDADE], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return saida.trim() === 'active';
  } catch {
    return false;
  }
}

async function subir() {
  if (systemdAtivo()) {
    escrever(`O painel esta rodando pelo systemd ("${UNIDADE}").`);
    escrever(`Use: systemctl --user restart ${UNIDADE}   (e o navegador em ${URL_PAINEL})`);
    plataforma.abrirNavegador(URL_PAINEL);
    return 0;
  }

  if (await painelRespondendo()) {
    escrever(`O painel ja esta no ar em ${URL_PAINEL}`);
    plataforma.abrirNavegador(URL_PAINEL);
    return 0;
  }

  fs.mkdirSync(DATA, { recursive: true });
  const out = path.join(DATA, 'painel.out');
  const err = path.join(DATA, 'painel.err');
  const fo = fs.openSync(out, 'a');
  const fe = fs.openSync(err, 'a');

  escrever('Subindo o painel...');
  const filho = spawn(process.execPath, [path.join(RAIZ, 'painel.js')], {
    cwd: RAIZ,
    detached: true,
    stdio: ['ignore', fo, fe],
    env: process.env,
  });
  filho.unref();
  fs.closeSync(fo);
  fs.closeSync(fe);

  // Espera o painel responder (o start e rapido, mas nao e instantaneo).
  for (let i = 0; i < 20; i++) {
    await dormir(500);
    if (await painelRespondendo()) {
      escrever(`Painel no ar em ${URL_PAINEL}`);
      escrever('A Bia NAO sobe junto: clique em "Subir a Bia" dentro do painel.');
      if (!process.argv.includes('--sem-abrir')) plataforma.abrirNavegador(URL_PAINEL);
      return 0;
    }
  }

  escrever(`O painel nao respondeu em ${URL_PAINEL}. Veja ${path.relative(RAIZ, err)}:`);
  try {
    escrever(fs.readFileSync(err, 'utf8').trim().split('\n').slice(-15).join('\n'));
  } catch {
    // silencio-ok: sem log ainda; a mensagem acima ja aponta o caminho.
  }
  return 1;
}

async function descer() {
  if (systemdAtivo()) {
    escrever(`O painel esta sob o systemd ("${UNIDADE}") - parar por aqui nao adianta:`);
    escrever(`ele volta sozinho. Use: systemctl --user stop ${UNIDADE}`);
    return 1;
  }

  // Marca que o dono NAO quer a Bia no ar: sem isso a auto-cura do painel
  // (e o supervisor) levantaria o bot de novo, igual ao desligar-bia.ps1.
  try {
    fs.rmSync(path.join(DATA, 'bot-desejado'), { force: true });
  } catch {
    // silencio-ok: se nao existe, ja e o estado desejado.
  }

  await plataforma.pararTudo();
  await plataforma.matarVarios(plataforma.processosDoProjeto('painel.js'));
  await dormir(500);

  escrever('Painel e Bia derrubados.');
  if (config.privacidade && config.privacidade.limparAoEncerrar) {
    const apagados = privacidade.limparSessao();
    escrever(
      apagados.length
        ? `Dado de sessao apagado: ${apagados.join(', ')}. O estado (hasheado) e a lista de quem pediu para sair ficam.`
        : 'Nada de sessao para apagar.',
    );
    escrever('Para enviar de novo, importe a lista no painel.');
  } else {
    escrever('Sessao mantida (config.privacidade.limparAoEncerrar = false).');
  }
  return 0;
}

async function status() {
  const painel = await painelRespondendo();
  const supervisor = plataforma.processosDoProjeto('supervisor.js');
  const bots = plataforma.processosDoProjeto('bot.js');
  let beat = null;
  try {
    const txt = fs.readFileSync(path.join(DATA, 'watchdog.heartbeat'), 'utf8').trim();
    const t = Date.parse(txt);
    beat = Number.isNaN(t) ? null : Math.round((Date.now() - t) / 1000);
  } catch {
    // silencio-ok: nunca subiu.
  }

  escrever(`Painel      ${painel ? `no ar em ${URL_PAINEL}` : 'parado'}`);
  escrever(`Supervisor  ${supervisor.length ? `vivo (PID ${supervisor.map((p) => p.pid).join(', ')})` : 'parado'}`);
  escrever(
    `Heartbeat   ${beat === null ? 'sem registro' : `ha ${beat}s${beat < 120 ? '' : ' (morto?)'}`}`
  );
  escrever(`Bot         ${bots.length ? `rodando (PID ${bots.map((p) => p.pid).join(', ')})` : 'parado'}`);
  escrever(
    `Desejado    ${fs.existsSync(path.join(DATA, 'bot-desejado')) ? 'sim (o dono quer a Bia no ar)' : 'nao (parada por decisao do dono)'}`
  );
  escrever(
    `Precisa religar  ${fs.existsSync(path.join(DATA, 'precisa-religar')) ? 'SIM (loggedOut - re-parear no painel)' : 'nao'}`
  );
  return 0;
}

async function principal() {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  if (cmd === 'subir' || cmd === 'ligar' || cmd === 'start') return subir();
  if (cmd === 'descer' || cmd === 'desligar' || cmd === 'stop') return descer();
  if (cmd === 'status') return status();
  if (cmd === 'reiniciar' || cmd === 'restart') {
    const r = await descer();
    if (r !== 0) return r;
    await dormir(1000);
    return subir();
  }
  escrever('Uso: node controle.js subir|descer|status|reiniciar');
  return 2;
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch((e) => {
    console.error(`falha: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
