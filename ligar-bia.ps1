# ============================================================
# "Ligar Bia" - abre o painel.
#
# A Bia NAO sobe sozinha (nem no logon, nem as 09:00) e NAO sobe junto com o
# painel. Este atalho sobe o painel e abre o navegador. Quem sobe o BOT e o
# dono, no botao "Subir a Bia" dentro do painel - e e la tambem que se conecta
# um aparelho novo (o pareamento derruba o bot; ao terminar, a Bia sobe quando
# o dono mandar).
#
# Por que separado: subir o bot junto fazia o painel parecer "travado" quando
# a sessao estava morta - o bot entrava em loop de reconexao e o supervisor
# tentava levanta-lo para morrer na trava do pareamento. Abrir o painel tem que
# ser instantaneo e nao decidir nada sobre a conexao.
#
# Uso: powershell -ExecutionPolicy Bypass -File ligar-bia.ps1
# ============================================================

param([switch]$SemNavegador)

$ErrorActionPreference = 'Continue'
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Raiz 'data\ligar.log'
$Url = 'http://127.0.0.1:3001/'
$Firefox = 'C:\Program Files\Mozilla Firefox\firefox.exe'

function Escrever($msg) {
    $linha = '[' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + '] ' + $msg
    Write-Host $linha
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
        Add-Content -Path $Log -Value $linha -Encoding UTF8
    } catch {}
}

# O processo so existe se a linha de comando bater com o nome do arquivo.
function PainelVivo {
    try {
        $conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
        return ($null -ne $conn)
    } catch { return $false }
}

Escrever 'Ligar Bia: chamado pelo dono (so o painel; o bot sobe pelo botao).'

# ---- 1. O painel ----
$painelVivo = PainelVivo
if ($painelVivo) {
    Escrever 'painel ja esta rodando.'
} else {
    $task = Get-ScheduledTask -TaskName 'BiaPainel' -ErrorAction SilentlyContinue
    if ($task) {
        try {
            Start-ScheduledTask -TaskName 'BiaPainel'
            Escrever 'painel: tarefa agendada disparada.'
        } catch {
            Escrever "falha ao disparar a tarefa do painel: $($_.Exception.Message)"
        }
    } else {
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
            '-File', (Join-Path $Raiz 'painel.ps1')
        ) | Out-Null
        Escrever 'painel: supervisor iniciado direto (sem tarefa agendada).'
    }
}

# ---- 2. Espera o painel responder ----
$pronto = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $r = Invoke-WebRequest -Uri ($Url + 'resumo') -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            $pronto = $true
            break
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}

if ($pronto) {
    Escrever 'painel respondendo.'
} else {
    Escrever 'ATENCAO: o painel nao respondeu em 20 s. Veja data/painel.log.'
}

# ---- 3. O navegador ----
if (-not $SemNavegador) {
    if (Test-Path $Firefox) {
        Start-Process $Firefox -ArgumentList $Url | Out-Null
        Escrever 'Firefox aberto no painel.'
    } else {
        Start-Process $Url | Out-Null
        Escrever 'Firefox nao encontrado: abri no navegador padrao.'
    }
}

Escrever 'Ligar Bia: concluido.'
