# ============================================================
# Instalador da Bia (uso: INSTALAR.bat -> este script).
#
#  1. Confere o Node.
#  2. Instala as dependencias (npm install).
#  3. Cria as Tarefas Agendadas: painel (painel.ps1, sobe no logon) e bot
#     (watchdog.ps1, SEM gatilho - ligado pelo painel).
#  4. Cria o atalho "Alimentar a Bia" na Area de Trabalho.
#  5. Liga o painel.
#
# Nao precisa de administrador: as tarefas rodam no usuario atual.
# ============================================================

param([switch]$AbrirPainel)

$ErrorActionPreference = 'Stop'
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path

function Passo($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

Passo 'Conferindo o Node'
# Runtime embutido (pacote do cliente) tem prioridade; senao, o Node do sistema.
$nodePortatil = Join-Path $Raiz 'runtime\node\node.exe'
if (Test-Path $nodePortatil) {
    $node = $nodePortatil
} else {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host 'Node.js nao encontrado. Instale em https://nodejs.org (versao LTS) e rode de novo.' -ForegroundColor Red
        exit 1
    }
    $node = $cmd.Source
}
Write-Host "Node: $node"

Passo 'Conferindo as dependencias'
# No pacote do cliente o node_modules ja vem pronto; so instala se faltar.
if (Test-Path (Join-Path $Raiz 'node_modules\@whiskeysockets\baileys')) {
    Write-Host 'Dependencias ja incluidas no pacote.'
} else {
    Push-Location $Raiz
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install falhou (codigo $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    Write-Host 'Dependencias ok.'
}

Passo 'Criando as Tarefas Agendadas'
$principal = $null
try {
    $usuario = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

    # ---- SEM GATILHO: a Bia sobe quando o dono chamar ----
    # As duas tarefas NAO tem gatilho: sobem pelo atalho "Ligar Bia" e param
    # pelo "Desligar Bia". O watchdog continua sendo o supervisor.
    $settingsBot = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    function Registrar($nome, $script, $gatilhos, $settingsUsar = $settings) {
        $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Raiz $script) + '"'
        $acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
        $params = @{
            TaskName    = $nome
            Action      = $acao
            Settings    = $settingsUsar
            Principal   = $principal
            Description = "empresa - $script"
            Force       = $true
        }
        if ($gatilhos -and @($gatilhos).Count -gt 0) { $params['Trigger'] = @($gatilhos) }
        Register-ScheduledTask @params | Out-Null
        Write-Host "Tarefa '$nome' criada (sem gatilho: sobe pelo atalho 'Ligar Bia')."
    }

    Registrar 'BiaBot' 'watchdog.ps1' @() $settingsBot
    Registrar 'BiaPainel' 'painel.ps1' @() $settings
} catch {
    # Em PC de empresa o Agendador pode estar bloqueado. Isso NAO pode impedir
    # a instalacao: o atalho "Ligar Bia" abre o painel direto (sem tarefa).
    Write-Host "Aviso: nao foi possivel criar as tarefas agendadas ($($_.Exception.Message))." -ForegroundColor Yellow
    Write-Host "O atalho 'Ligar Bia' abre o painel direto, sem tarefa agendada." -ForegroundColor Yellow
}

Passo 'Criando os atalhos na Area de Trabalho'
$desktop = [Environment]::GetFolderPath('Desktop')

# Atalho .lnk (e nao .bat/.cmd): nao abre janela de console no meio da tela
# e aceita icone proprio.
function CriarAtalho($nome, $script, $descricao, $icone) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path $desktop $nome))
    $lnk.TargetPath = 'powershell.exe'
    $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Raiz $script) + '"'
    $lnk.WorkingDirectory = $Raiz
    $lnk.Description = $descricao
    $lnk.IconLocation = $icone
    $lnk.Save()
    Write-Host "Atalho criado: $(Join-Path $desktop $nome)"
}

CriarAtalho 'Ligar Bia.lnk' 'ligar-bia.ps1' 'Sobe a Bia e abre o painel no Firefox' "$env:SystemRoot\System32\shell32.dll,13"
CriarAtalho 'Desligar Bia.lnk' 'desligar-bia.ps1' 'Derruba a Bia e o painel' "$env:SystemRoot\System32\shell32.dll,44"

$url = Join-Path $desktop 'Alimentar a Bia.url'
@"
[InternetShortcut]
URL=http://127.0.0.1:3001/
"@ | Set-Content -Path $url -Encoding ASCII
Write-Host "Atalho criado: $url"

Passo 'Subindo a Bia'
& (Join-Path $Raiz 'ligar-bia.ps1')

Write-Host "`nTudo pronto!" -ForegroundColor Green
Write-Host 'Para usar: clique em "Ligar Bia" na Area de Trabalho.'
Write-Host 'Ele sobe a Bia, sobe o painel e abre o Firefox no painel.'
Write-Host 'A Bia NAO sobe sozinha: nem no logon, nem as 09:00.'
Write-Host 'Para parar: clique em "Desligar Bia".'
Write-Host 'A campanha so envia dentro da janela de trabalho e com o aparelho pareado.'
