'use strict';

// ============================================================
// Camada de sistema operacional.
//
// O bot e o painel sao Node puro e rodam igual em qualquer lugar. O que muda
// de sistema para sistema e o que fica em volta: subir/derrubar o supervisor,
// zipar o backup, abrir o navegador e avisar o dono.
//
// Antes isso estava espalhado em powershell.exe dentro de painel.js,
// backup.js e restaurar.js - e por isso o sistema so rodava no Windows.
// Aqui cada uma dessas operacoes tem UM lugar, com o caminho de cada sistema:
//
//   Windows -> mantem exatamente os comandos que ja funcionavam (Tarefa
//              Agendada, Get-CimInstance, Compress-Archive, toast).
//   Linux   -> supervisor.js, /proc, zip/unzip, notify-send, xdg-open.
//   macOS   -> supervisor.js, ps, zip/unzip, osascript, open.
//
// Regra: nada aqui lanca excecao para o chamador. O que falha volta como
// false/[] e o chamador decide o que dizer ao operador.
// ============================================================

const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const EH_WINDOWS = process.platform === 'win32';
const EH_MAC = process.platform === 'darwin';
const EH_LINUX = process.platform === 'linux';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// Processos
// ============================================================

function ps(comando) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', comando],
      // timeout: um PowerShell travado nunca pode prender o supervisor.
      { cwd: RAIZ, windowsHide: true, timeout: 20000 },
      (erro, saida) => resolve({ ok: !erro, saida: String(saida || '') })
    );
  });
}

// Linha de comando de um PID. No Linux vem do /proc (barato e sem binario
// externo); nos outros sistemas nao ha /proc, e quem chama usa listarProcessos.
function cmdlineDe(pid) {
  if (!EH_LINUX) return null;
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .join(' ')
      .trim();
  } catch {
    return null;
  }
}

// Argumentos do processo como LISTA (sem juntar com espaco - nome de arquivo
// com espaco deixaria de ser comparavel).
function argumentosDe(pid) {
  if (!EH_LINUX) return null;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function cwdDe(pid) {
  if (!EH_LINUX) return null;
  try {
    return fs.realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// Lista { pid, cmd } de processos cuja linha de comando casa a expressao.
// Nunca inclui o proprio processo nem o pai (senao "parar" mataria quem manda).
function listarProcessos(expressao) {
  const re = expressao instanceof RegExp ? expressao : new RegExp(expressao);
  const achados = [];
  const ignorar = new Set([process.pid, process.ppid]);

  if (EH_LINUX) {
    let pids = [];
    try {
      pids = fs
        .readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number);
    } catch {
      return [];
    }
    for (const pid of pids) {
      if (ignorar.has(pid) || pid <= 1) continue;
      const cmd = cmdlineDe(pid);
      if (cmd && re.test(cmd)) achados.push({ pid, cmd });
    }
    return achados;
  }

  if (EH_WINDOWS) {
    // Sem /proc: uma foto dos processos com linha de comando, filtrada aqui
    // (e nao no PowerShell) para o filtro ser o mesmo dos outros sistemas.
    try {
      const saida = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 }
      );
      for (const linha of saida.split(/\r?\n/)) {
        const i = linha.indexOf('|');
        if (i < 1) continue;
        const pid = Number(linha.slice(0, i));
        const cmd = linha.slice(i + 1);
        if (!Number.isInteger(pid) || ignorar.has(pid)) continue;
        if (re.test(cmd)) achados.push({ pid, cmd });
      }
    } catch {
      return [];
    }
    return achados;
  }

  // macOS e outros unix com ps.
  try {
    const saida = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    for (const linha of saida.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(linha);
      if (!m) continue;
      const pid = Number(m[1]);
      if (ignorar.has(pid)) continue;
      if (re.test(m[2])) achados.push({ pid, cmd: m[2] });
    }
  } catch {
    // silencio-ok: sem ps nao ha lista; quem chamou trata lista vazia.
  }
  return achados;
}

// Processos deste projeto (e nao de outro bot rodando na mesma maquina).
//
// No Linux a checagem e EXATA: algum argumento da linha de comando tem de ser
// o proprio arquivo (resolvido contra o cwd do processo). Comparar por texto
// solto dava falso positivo - um shell que apenas MENCIONA "supervisor.js"
// (um grep, um pgrep, um editor) entrava na lista e "derrubar" matava a
// ferramenta errada.
function processosDoProjeto(arquivo) {
  const alvo = path.resolve(RAIZ, arquivo);
  return listarProcessos(arquivo).filter((p) => {
    if (EH_LINUX) {
      const args = argumentosDe(p.pid);
      if (args) {
        const cwd = cwdDe(p.pid);
        return args.some((a) => {
          if (!a) return false;
          const abs = path.isAbsolute(a) ? a : cwd && path.join(cwd, a);
          return abs && path.resolve(abs) === alvo;
        });
      }
    }
    // Sem /proc (Windows, macOS): o melhor sinal disponivel e o texto da
    // linha de comando apontar para a pasta do projeto.
    return p.cmd.includes(RAIZ);
  });
}

function pidVivo(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Termina um processo: pede educadamente e, se ele nao sair, forca.
// No Windows o Stop-Process -Force ja e o force; no unix o SIGTERM vem antes
// para o bot ter chance de soltar a trava e fechar o socket.
async function matar(pid, { esperaMs = 3000 } = {}) {
  if (!pid || pid <= 1 || pid === process.pid) return false;
  if (!pidVivo(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const limite = Date.now() + esperaMs;
  while (Date.now() < limite) {
    if (!pidVivo(pid)) return true;
    await dormir(120);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // silencio-ok: pode ter morrido entre o teste e o kill.
  }
  await dormir(200);
  return !pidVivo(pid);
}

async function matarVarios(lista) {
  const resultados = await Promise.all(lista.map((p) => matar(p.pid)));
  return resultados.some(Boolean);
}

// PID do bot lido da trava (data/bot.pid). Aceita JSON { pid } e o formato
// antigo (numero puro).
function pidDoBot() {
  const arq = path.join(require('./config').dataFolder, 'bot.pid');
  try {
    const bruto = fs.readFileSync(arq, 'utf8').trim();
    if (bruto.startsWith('{')) {
      const o = JSON.parse(bruto);
      return Number.isInteger(Number(o.pid)) ? Number(o.pid) : null;
    }
    const n = Number(bruto);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ============================================================
// Supervisor (o "watchdog")
// ============================================================

// Sobe o supervisor. O painel usa isto no botao "Subir a Bia".
//   Windows -> Tarefa Agendada BiaBot (instalacao normal) ou watchdog.ps1.
//   Outros  -> supervisor.js, solto do painel (detached): se o painel cair, o
//              supervisor continua, igual ao Start-Process do Windows.
async function iniciarSupervisor() {
  if (EH_WINDOWS) {
    const script = path.join(RAIZ, 'watchdog.ps1').replace(/'/g, "''");
    const cmd = [
      "if (Get-ScheduledTask -TaskName 'BiaBot' -ErrorAction SilentlyContinue) {",
      "Start-ScheduledTask -TaskName 'BiaBot'",
      '} else {',
      `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${script}')`,
      '}',
    ].join(' ');
    await ps(cmd);
    return true;
  }

  try {
    const filho = spawn(process.execPath, [path.join(RAIZ, 'supervisor.js')], {
      cwd: RAIZ,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    filho.unref();
    return true;
  } catch (e) {
    console.error(`[plataforma] falha ao subir o supervisor: ${e.message}`);
    return false;
  }
}

// Derruba supervisor + bot + pareamento. E o que o painel faz em "Derrubar a
// Bia" e ao comecar um pareamento (socket unico).
async function pararTudo() {
  if (EH_WINDOWS) {
    // Os mesmos comandos de sempre: Tarefa Agendada, o powershell do
    // watchdog.ps1, o PID da trava e o connect.js do pareamento.
    const arqPid = path.join(require('./config').dataFolder, 'bot.pid').replace(/'/g, "''");
    const meu = path.basename(RAIZ);
    await Promise.all([
      ps("Stop-ScheduledTask -TaskName 'BiaBot' -ErrorAction SilentlyContinue"),
      ps(
        `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'watchdog\\.ps1' -and $_.CommandLine -like '*${meu}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ),
      ps(
        `$a='${arqPid}'; if (Test-Path -LiteralPath $a) { $o = Get-Content -LiteralPath $a -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue; if ($o -and $o.pid) { Stop-Process -Id ([int]$o.pid) -Force -ErrorAction SilentlyContinue } }`
      ),
      ps(
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'connect\\.js' -and $_.CommandLine -like '*${meu}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ),
    ]);
    return true;
  }

  // Linux/macOS: primeiro o supervisor (senao ele reergue o bot no meio da
  // parada), depois o bot pela trava, depois o pareamento.
  const supervisores = processosDoProjeto('supervisor.js');
  await matarVarios(supervisores);

  const pid = pidDoBot();
  if (pid) await matar(pid);
  await matarVarios(processosDoProjeto('bot.js'));
  await matarVarios(processosDoProjeto('connect.js'));
  return true;
}

// ============================================================
// Backup (zip)
// ============================================================

function temComando(nome) {
  try {
    execFileSync(EH_WINDOWS ? 'where' : 'sh', EH_WINDOWS ? [nome] : ['-c', `command -v ${nome}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const escaparPs = (t) => String(t).replace(/'/g, "''");

// Zipa o CONTEUDO de `pasta` em `destino` (os itens ficam na raiz do zip,
// igual ao Compress-Archive -LiteralPath @(itens) que ja era usado).
function ziparPasta(pasta, destino) {
  if (EH_WINDOWS) {
    const itens = fs
      .readdirSync(pasta)
      .map((n) => `'${escaparPs(path.join(pasta, n))}'`)
      .join(',');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Compress-Archive -LiteralPath @(${itens}) -DestinationPath '${escaparPs(destino)}' -Force`,
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    return;
  }

  if (!temComando('zip')) {
    throw new Error(
      'o comando "zip" nao esta instalado. Instale o pacote (ex.: sudo apt install zip) ou defina BIA_BACKUP_DIR apontando para uma pasta ja existente e rode o backup depois.'
    );
  }
  // O zip sai com codigo 1 quando a pasta esta vazia; isso nao e falha aqui.
  try {
    execFileSync('zip', ['-r', '-q', destino, '.'], { cwd: pasta, stdio: 'ignore' });
  } catch (e) {
    if (e.status !== 1) throw e;
  }
}

function deszipar(zip, destino) {
  if (EH_WINDOWS) {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${escaparPs(zip)}' -DestinationPath '${escaparPs(destino)}' -Force`,
      ],
      { stdio: 'inherit', windowsHide: true }
    );
    return;
  }
  if (!temComando('unzip')) {
    throw new Error('o comando "unzip" nao esta instalado. Instale o pacote (ex.: sudo apt install unzip).');
  }
  execFileSync('unzip', ['-q', '-o', zip, '-d', destino], { stdio: 'inherit' });
}

// ============================================================
// Interface com o dono
// ============================================================

function abrirNavegador(url) {
  try {
    if (EH_WINDOWS) {
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true, timeout: 5000 }, () => {});
    } else if (EH_MAC) {
      execFile('open', [url], { timeout: 5000 }, () => {});
    } else {
      // Sem sessao grafica (SSH, servico) o xdg-open pode travar: o timeout
      // fecha o processo e a vida segue sem navegador.
      execFile('xdg-open', [url], { timeout: 5000 }, () => {});
    }
    return true;
  } catch {
    return false;
  }
}

// Aviso fora do painel. O log e o canal confiavel; isto e o extra que faz o
// dono PERCEBER no meio do dia.
function notificar(titulo, texto) {
  return new Promise((resolve) => {
    try {
      if (EH_WINDOWS) {
        const t = escaparPs(titulo);
        const x = escaparPs(texto);
        const cmd =
          '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ' +
          '[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ' +
          '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument; ' +
          `$doc.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${t}</text><text id="2">${x}</text></binding></visual></toast>'); ` +
          '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc; ' +
          "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PowerShell').Show($toast)";
        ps(cmd).then(() => resolve(true));
        return;
      }
      if (EH_MAC) {
        const esc = (s) => String(s).replace(/"/g, '\\"');
        execFile(
          'osascript',
          ['-e', `display notification "${esc(texto)}" with title "${esc(titulo)}"`],
          { timeout: 5000 },
          () => resolve(true)
        );
        return;
      }
      if (!temComando('notify-send')) return resolve(false);
      execFile('notify-send', [titulo, texto], { timeout: 5000 }, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

module.exports = {
  RAIZ,
  EH_WINDOWS,
  EH_LINUX,
  EH_MAC,
  dormir,
  ps,
  cmdlineDe,
  argumentosDe,
  cwdDe,
  listarProcessos,
  processosDoProjeto,
  pidVivo,
  pidDoBot,
  matar,
  matarVarios,
  iniciarSupervisor,
  pararTudo,
  ziparPasta,
  deszipar,
  abrirNavegador,
  notificar,
  temComando,
};
