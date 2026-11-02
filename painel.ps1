# ============================================================
# Supervisor do painel "Alimentar a Bia".
#
# Irmao do watchdog.ps1, mas para o painel.js: se o processo cair, sobe de
# novo. O painel nao fala com o WhatsApp, entao nao ha conflito com o bot.
#
# Uso (a Tarefa Agendada chama isto):
#   powershell -ExecutionPolicy Bypass -File painel.ps1
# ============================================================

$ErrorActionPreference = 'Continue'
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Raiz 'data\painel.log'
# Runtime embutido (pacote do cliente) tem prioridade sobre o Node do sistema.
$NodePortatil = Join-Path $Raiz 'runtime\node\node.exe'
if (Test-Path $NodePortatil) {
    $Node = $NodePortatil
} else {
    $Node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }
}

function Escrever($msg) {
    $linha = '[' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + '] ' + $msg
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
        Add-Content -Path $Log -Value $linha -Encoding UTF8
    } catch {}
}

$Porta = 3001
function PainelVivo {
    # A porta e a identidade do painel: cada projeto tem a sua (3000/3001).
    # Olhar 'painel.js' na linha de comando casaria o painel do outro projeto.
    try {
        $conn = Get-NetTCPConnection -LocalPort $Porta -State Listen -ErrorAction SilentlyContinue
        return ($null -ne $conn)
    } catch { return $false }
}

Escrever "supervisor do painel iniciado (PID $PID). node=$Node"

while ($true) {
    if (-not (PainelVivo)) {
        Escrever 'painel nao esta rodando - subindo.'
        try {
            Start-Process -FilePath $Node -ArgumentList 'painel.js' -WorkingDirectory $Raiz `
                -RedirectStandardOutput (Join-Path $Raiz 'data\painel.out') `
                -RedirectStandardError (Join-Path $Raiz 'data\painel.err') `
                -WindowStyle Hidden | Out-Null
        } catch {
            Escrever "falha ao subir o painel: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 10
    }
    Start-Sleep -Seconds 30
}
