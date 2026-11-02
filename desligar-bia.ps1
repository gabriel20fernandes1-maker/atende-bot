# ============================================================
# "Desligar Bia".
#
# O par do "Ligar Bia": derruba o painel e a Bia, para a sessao ficar em paz
# quando o dono nao esta usando. Sem isto, a Bia continua rodando depois que
# o painel fecha - e ela continua valendo de noite.
#
# O que este script faz:
#   1. para as tarefas agendadas (BiaBot e BiaPainel) - o watchdog e o
#      supervisor do painel param de levantar as coisas
#   2. mata os processos node que sobraram (bot.js, painel.js, connect.js)
#      - o bot foi iniciado pelo watchdog, e nem sempre morre com ele
#   3. apaga o dado de sessao (lista importada, feed, logs) se
#      config.privacidade.limparAoEncerrar estiver ligado. O estado hasheado
#      e a memoria de opt-out continuam.
#
# Uso: powershell -ExecutionPolicy Bypass -File desligar-bia.ps1
# ============================================================

$ErrorActionPreference = 'Continue'
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Raiz 'data\ligar.log'

function Escrever($msg) {
    $linha = '[' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + '] ' + $msg
    Write-Host $linha
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
        Add-Content -Path $Log -Value $linha -Encoding UTF8
    } catch {}
}

Escrever 'Desligar Bia: chamado pelo dono.'

# O dono quer tudo desligado: apaga a marca de "Bia desejada". Sem isto, na
# proxima vez que o painel subisse, a auto-cura levantaria o bot sozinho.
try {
    Remove-Item (Join-Path $Raiz 'data\bot-desejado') -Force -ErrorAction SilentlyContinue
} catch {}

foreach ($nome in @('BiaBot', 'BiaPainel')) {
    $task = Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
    if ($task) {
        try {
            Stop-ScheduledTask -TaskName $nome -ErrorAction Stop
            Escrever "${nome}: tarefa parada."
        } catch {
            Escrever "${nome}: nao deu para parar a tarefa: $($_.Exception.Message)"
        }
    }
}

# Os processos node: o bot e o painel sao filhos dos supervisores, e o
# Stop-ScheduledTask nem sempre leva os filhos junto. Mata pelo que esta na
# linha de comando (o nome do arquivo), nunca por nome de processo generico.
# Bot/painel deste projeto pelos proprios sinais (pid/porta). NUNCA por nome
# de arquivo sozinho: mataria o bot do outro projeto (ex.: outra Bia).
$pidBot = $null
$arqPid = Join-Path $Raiz 'data\bot.pid'
if (Test-Path -LiteralPath $arqPid) {
    try { $o = Get-Content -LiteralPath $arqPid -Raw | ConvertFrom-Json; if ($o.pid) { $pidBot = [int]$o.pid } } catch {}
}
if ($pidBot) {
    try { Stop-Process -Id $pidBot -Force -ErrorAction Stop; Escrever "bot encerrado (PID $pidBot)." } catch { Escrever "falha ao encerrar o bot (PID $pidBot): $($_.Exception.Message)" }
}
$conn = @()
try { $conn = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) } catch { $conn = @() }
foreach ($c in @($conn)) {
    if ($c -and $c.OwningProcess) {
        try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; Escrever "painel encerrado (PID $($c.OwningProcess))." } catch { Escrever "falha ao encerrar o painel (PID $($c.OwningProcess)): $($_.Exception.Message)" }
    }
}
foreach ($padrao in @('watchdog\.ps1', 'painel\.ps1', 'connect\.js')) {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $padrao -and $_.CommandLine -like "*$Raiz*" }
    foreach ($p in $procs) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Escrever "processo encerrado (PID $($p.ProcessId), $padrao)."
        } catch {
            Escrever "falha ao encerrar o PID $($p.ProcessId): $($_.Exception.Message)"
        }
    }
}

# Dado de sessao (lista importada, feed, logs) vai embora, se o config mandar.
# O estado hasheado e a memoria de quem pediu para sair (supridos.txt) ficam:
# sao eles que impedem a Bia de recontatar quem disse "nao" amanha.
$node = Join-Path $Raiz 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }
try {
    & $node (Join-Path $Raiz 'privacidade.js') --limpar
} catch {
    Escrever "limpeza de sessao falhou: $($_.Exception.Message)"
}

Escrever 'Desligar Bia: concluido.'
