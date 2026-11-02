'use strict';

// ============================================================
// Supervisor da Bia (o "watchdog") - versao para Linux/macOS.
//
// E o porte fiel do watchdog.ps1: mesma politica, mesmos arquivos, mesmos
// avisos. O Windows continua usando o watchdog.ps1 (que ja passou por
// 29/09, 17/10, 19/10 e continua sendo o caminho testado la); aqui e o mesmo
// desenho em Node, para o sistema rodar fora do Windows sem perder nada.
//
// O que ele garante:
//   - UM supervisor so (trava em data/supervisor.pid, com boot ID: o Linux
//     tambem reusa PID depois de reboot);
//   - prova de vida em data/watchdog.heartbeat (o painel le este arquivo para
//     dizer "supervisor vivo/morto");
//   - so sobe o bot se o DONO mandou (data/bot-desejado) - reabrir o painel
//     nao acorda a Bia sozinha;
//   - respeita loggedOut (data/precisa-religar): nao entra em loop de
//     reconexao, que e o que agrava bloqueio de numero;
//   - roda o smoke (bot.js --smoke) antes de subir: subir para morrer em
//     silencio foi o defeito de 17/10;
//   - vigia o health.json e avisa (log + notificacao) quando a sessao fica
//     cega ou quando o WhatsApp corta por limite (428);
//   - nao sobe o bot durante um pareamento (connect.js vivo).
//
// Uso: node supervisor.js   (o painel chama sozinho em "Subir a Bia")
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');
const trava = require('./pid.lock');
const plataforma = require('./plataforma');
const bootCheck = require('./boot-check');

const RAIZ = __dirname;
const DATA = config.dataFolder;
const LOG = path.join(DATA, 'watchdog.log');
const BEAT = path.join(DATA, 'watchdog.heartbeat');
const FLAG_RELIGAR = path.join(DATA, 'precisa-religar');
const FLAG_REINICIAR = path.join(DATA, 'precisa-reiniciar');
const FLAG_DESEJADO = path.join(DATA, 'bot-desejado');
const TRAVA = path.join(DATA, 'supervisor.pid');

const INTERVALO_MS = 30 * 1000;

// Relogio local no mesmo formato do watchdog.ps1 (yyyy-MM-ddTHH:mm:ss). O
// painel faz Date.parse nisto; sem fuso explicito ele le como local, que e
// exatamente o que queremos aqui.
function agora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escrever(msg) {
  const linha = `[${agora()}] ${msg}`;
  console.log(linha);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOG, `${linha}\n`, 'utf8');
  } catch {
    // silencio-ok: log e o canal confiavel, mas se o disco negar nao derruba
    // o supervisor - ele continua com o console.
  }
}

// ---- trava de instancia unica ---------------------------------------------

const TOLERANCIA_BOOT_MS = 60000;
function bootId() {
  return Math.round(Date.now() - os.uptime() * 1000);
}

function travar() {
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(TRAVA)) {
    try {
      const o = JSON.parse(fs.readFileSync(TRAVA, 'utf8'));
      const mesmoBoot =
        typeof o.boot !== 'number' || Math.abs(o.boot - bootId()) <= TOLERANCIA_BOOT_MS;
      if (o.pid && mesmoBoot && plataforma.pidVivo(o.pid)) return { ok: false, pid: o.pid };
    } catch {
      // silencio-ok: trava corrompida e tratada como orfa (o write abaixo
      // sobrescreve). Trava quebrada nao pode deixar a Bia fora do ar.
    }
    try {
      fs.rmSync(TRAVA, { force: true });
    } catch {
      // silencio-ok: o writeFileSync abaixo sobrescreve de qualquer forma.
    }
  }
  fs.writeFileSync(
    TRAVA,
    JSON.stringify({ pid: process.pid, boot: bootId(), em: new Date().toISOString() }),
    'utf8'
  );
  return { ok: true };
}

function liberarTrava() {
  try {
    const o = JSON.parse(fs.readFileSync(TRAVA, 'utf8'));
    if (o.pid === process.pid) fs.rmSync(TRAVA, { force: true });
  } catch {
    // silencio-ok: sem trava (ou de outro supervisor) nao ha o que soltar.
  }
}

// ---- estado do bot --------------------------------------------------------

function botVivo() {
  try {
    if (!trava.existe()) return false;
  } catch {
    return false;
  }
  const pid = trava.ler();
  // A trava ja provou que o PID vive; a linha de comando so confirma que ele
  // ainda e o NOSSO bot.js (e nao um PID reusado por outra coisa).
  const cmd = plataforma.cmdlineDe(pid);
  if (cmd && !/bot\.js/.test(cmd)) return false;
  return true;
}

function pareando() {
  return plataforma.processosDoProjeto('connect.js').length > 0;
}

function idadeMinutos(arquivo) {
  try {
    return (Date.now() - fs.statSync(arquivo).mtimeMs) / 60000;
  } catch {
    return null;
  }
}

function existe(arquivo) {
  try {
    return fs.existsSync(arquivo);
  } catch {
    return false;
  }
}

// ---- prova de boot (smoke) -----------------------------------------------

// A prova em si mora em boot-check.js (o painel usa a MESMA no clique em
// "Subir a Bia", para poder mostrar o motivo ao dono). Aqui so registramos no
// log e deixamos o motivo gravado para a tela.
function validarBoot() {
  const r = bootCheck.validarBoot({ raiz: RAIZ, dataFolder: DATA });
  if (!r.ok) {
    escrever(`SMOKE FALHOU (saida ${r.codigo}) - o bot nao vai subir:`);
    if (r.saida) escrever(r.saida);
    bootCheck.registrarFalha(DATA, r.saida);
    return false;
  }
  bootCheck.limparFalha(DATA);
  return true;
}

// ---- higiene dos logs de boot --------------------------------------------

// Guarda os `manter` mais recentes de cada tipo (bot-*.out e bot-*.err).
function limparSaidasAntigas(manter = 10) {
  try {
    const saidas = fs
      .readdirSync(DATA)
      .filter((f) => /^bot-.*\.(out|err)$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(DATA, f)).mtimeMs }));
    for (const tipo of ['.out', '.err']) {
      saidas
        .filter(({ f }) => f.endsWith(tipo))
        .sort((a, b) => b.t - a.t)
        .slice(manter)
        .forEach(({ f }) => {
          try {
            fs.rmSync(path.join(DATA, f), { force: true });
          } catch {
            // silencio-ok: proximo ciclo tenta.
          }
        });
    }
  } catch {
    // silencio-ok: pasta data ainda nao existe.
  }
}

// ---- subir o bot ---------------------------------------------------------

function subirBot() {
  const ts = agora().replace(/[-:T]/g, '');
  const out = path.join(DATA, `bot-${ts}.out`);
  const err = path.join(DATA, `bot-${ts}.err`);
  let fo;
  let fe;
  try {
    fo = fs.openSync(out, 'a');
    fe = fs.openSync(err, 'a');
    // detached: o bot nao morre junto com o supervisor (no Windows era o
    // Start-Process). Quem derruba o bot e o painel, pela trava.
    const filho = spawn(process.execPath, [path.join(RAIZ, 'bot.js')], {
      cwd: RAIZ,
      detached: true,
      stdio: ['ignore', fo, fe],
      env: process.env,
    });
    filho.unref();
    return { ok: true, out, err };
  } catch (e) {
    escrever(`falha ao subir o bot: ${e.message}`);
    return { ok: false, out, err };
  } finally {
    // O filho ja herdou as copias dos descritores; fechar aqui evita vazar o
    // arquivo aberto no supervisor.
    for (const fd of [fo, fe]) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {
        // silencio-ok
      }
    }
  }
}

// ---- vigia do health.json ------------------------------------------------

let cegueiraAvisada = false;
let limitacaoAvisada = false;

async function checarSaude() {
  let h;
  try {
    h = JSON.parse(fs.readFileSync(path.join(DATA, 'health.json'), 'utf8'));
  } catch {
    return; // silencio-ok: bot ainda nao subiu - normal.
  }

  if (h.cegueira) {
    const confirmada = Boolean(h.cegueiraConfirmada);
    if (cegueiraAvisada !== (confirmada ? 'confirmada' : 'suspeita')) {
      cegueiraAvisada = confirmada ? 'confirmada' : 'suspeita';
      const msg = confirmada
        ? "A sessao recebe mensagens mas nao decripta. A campanha esta pausada. Re-parear pelo painel: http://127.0.0.1:3001/ (botao 'Re-parear agora')."
        : 'O teste de visao falhou uma vez e a campanha foi pausada por precaucao. Se persistir, re-pareie pelo painel: http://127.0.0.1:3001/.';
      escrever(`ALERTA: a Bia esta CEGA (${cegueiraAvisada}) - ${msg}`);
      await plataforma.notificar(`empresa - a Bia esta CEGA (${cegueiraAvisada})`, msg);
    }
  } else {
    cegueiraAvisada = false;
  }

  // 428 nao e cegueira: e o WhatsApp cortando a conexao por limite. Problema
  // do NUMERO, e o aviso e outro (re-parear a ponte e reduzir o ritmo).
  const janela = Date.now() - 30 * 60000;
  const cortes = Array.isArray(h.desconexoes)
    ? h.desconexoes.filter((d) => d && String(d.motivo) === '428' && Date.parse(d.em) >= janela)
    : [];
  if (cortes.length >= 2) {
    if (!limitacaoAvisada) {
      limitacaoAvisada = true;
      const msg = `O WhatsApp cortou a conexao ${cortes.length} vez(es) em 30 min (428). A sessao sobe e cai e nada de leitura acontece. A cura e RE-PAREAR a ponte e reduzir o ritmo de envio. Painel: http://127.0.0.1:3001/`;
      escrever(`ALERTA: conta sob limitacao do WhatsApp (428 x${cortes.length}) - ${msg}`);
      await plataforma.notificar('empresa - conta sob limitacao do WhatsApp', msg);
    }
  } else {
    limitacaoAvisada = false;
  }
}

// ---- laco principal ------------------------------------------------------

async function laco() {
  let falhasSeguidas = 0;
  let cegoSeguidas = 0;
  let ultimoReinicioCego = null;
  let religarAvisado = false;
  let desejadaAvisada = false;
  let pareandoAvisado = false;

  for (;;) {
    try {
      // Prova de vida do SUPERVISOR: sem isto, morto e quieto sao iguais.
      try {
        fs.writeFileSync(BEAT, agora(), 'utf8');
      } catch {
        // silencio-ok: o heartbeat volta no proximo ciclo.
      }

      await checarSaude();

      // loggedOut: reiniciar nao resolve. Fica quieto (sem loop de
      // reconexao) e avisa uma vez. A marca pode ser velha - de 2 em 2 horas
      // tenta subir assim mesmo, senao ela prende a Bia fora do ar.
      if (existe(FLAG_RELIGAR)) {
        if (!religarAvisado) {
          escrever('precisa religar o aparelho (loggedOut) - aguardando no painel "Conectar / Trocar numero".');
          await plataforma.notificar(
            'empresa - aparelho desvinculado',
            'O WhatsApp desvinculou o aparelho da Bia. Re-parear pelo painel: http://127.0.0.1:3001/'
          );
          religarAvisado = true;
        }
        const idade = idadeMinutos(FLAG_RELIGAR);
        if (idade !== null && idade < 120) {
          await plataforma.dormir(60000);
          continue;
        }
        if (idade !== null) {
          escrever(
            `marca de religar com ${(idade / 60).toFixed(1)} h - o aparelho pode ja estar vinculado; tentando subir assim mesmo.`
          );
        }
      } else {
        religarAvisado = false;
      }

      if (botVivo()) {
        falhasSeguidas = 0;
        await plataforma.dormir(INTERVALO_MS);
        continue;
      }

      // A Bia sobe SO quando o dono manda ("Subir a Bia" grava bot-desejado).
      if (!existe(FLAG_DESEJADO)) {
        if (!desejadaAvisada) {
          escrever('a Bia esta parada por decisao do dono - suba pelo botao "Subir a Bia" no painel.');
          desejadaAvisada = true;
        }
        await plataforma.dormir(20000);
        continue;
      }
      desejadaAvisada = false;

      // Pareamento em andamento: o bot nao pode subir (socket/aparelho unico).
      if (pareando()) {
        if (!pareandoAvisado) {
          escrever('pareamento em andamento (connect.js) - o bot espera o pareamento terminar.');
          pareandoAvisado = true;
        }
        await plataforma.dormir(15000);
        continue;
      }
      pareandoAvisado = false;

      // Reinicio pedido pelo proprio bot: se a cegueira volta logo depois,
      // reiniciar nao cura - escala para re-parear.
      if (existe(FLAG_REINICIAR)) {
        if (ultimoReinicioCego && Date.now() - ultimoReinicioCego < 20 * 60000) {
          cegoSeguidas++;
        } else {
          cegoSeguidas = 1;
        }
        ultimoReinicioCego = Date.now();
        try {
          fs.rmSync(FLAG_REINICIAR, { force: true });
        } catch {
          // silencio-ok: se nao der para apagar, a proxima volta reavalia.
        }
        if (cegoSeguidas >= 2) {
          escrever('cegueira voltou apos reiniciar - reinicio nao cura. Marcando precisa-religar (re-parear no painel).');
          try {
            fs.writeFileSync(FLAG_RELIGAR, agora(), 'utf8');
          } catch {
            // silencio-ok: sem a marca o laco volta na proxima volta.
          }
          await plataforma.dormir(60000);
          continue;
        }
        escrever(`bot pediu reinicio (ocorrencia ${cegoSeguidas}) - subindo limpo.`);
      } else {
        cegoSeguidas = 0;
      }

      if (!validarBoot()) {
        escrever('boot nao validado - o bot fica parado ate o defeito ser corrigido (veja a saida do smoke acima).');
        await plataforma.dormir(60000);
        continue;
      }

      escrever('bot nao esta rodando - subindo.');
      const r = subirBot();
      await plataforma.dormir(20000);

      if (botVivo()) {
        escrever(`bot subiu (saida em data/${path.basename(r.out)}).`);
        falhasSeguidas = 0;
        limparSaidasAntigas();
      } else {
        falhasSeguidas++;
        escrever(`bot NAO subiu (falha ${falhasSeguidas} seguida(s)). Veja data/${path.basename(r.err)}.`);
        const espera = Math.min(300, 30 * falhasSeguidas) * 1000;
        escrever(`esperando ${espera / 1000} s antes de tentar de novo.`);
        await plataforma.dormir(espera);
      }
    } catch (e) {
      // Uma excecao aqui NAO pode matar o supervisor (foi assim que a Bia
      // ficou fora do ar em 19/10): registra e segue.
      escrever(`erro no laco do supervisor: ${e && e.stack ? e.stack : e}`);
      await plataforma.dormir(INTERVALO_MS);
    }
  }
}

// ---- entrada -------------------------------------------------------------

const travaOk = travar();
if (!travaOk.ok) {
  // NAO grava no watchdog.log: todo Start de segundo supervisor cairia aqui e
  // encheria o log de "ja existe" (aprendizado de 19/10).
  console.log(`ja existe um supervisor ativo (PID ${travaOk.pid}) - saindo para nao duplicar o bot.`);
  process.exit(0);
}

escrever(`supervisor iniciado (PID ${process.pid}). node=${process.execPath} (${process.platform})`);

for (const sinal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sinal, () => {
    escrever(`supervisor encerrando (PID ${process.pid}, sinal ${sinal}).`);
    liberarTrava();
    process.exit(0);
  });
}

laco();
