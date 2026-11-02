# ============================================================
# Watchdog da Bia.
#
# Em 29/09 a Bia morreu no boot (ReferenceError) e ficou morta ate alguem
# olhar. Este script e o supervisor: se o bot nao estiver vivo, sobe.
#
# TRAVA DE INSTANCIA UNICA (por que isto existe agora):
# ja aconteceu de rodar a Tarefa Agendada E um watchdog manual ao mesmo tempo.
# Cada watchdog sobe um bot; varios bots com a MESMA sessao fazem o WhatsApp
# tratar como uso suspeito e DESVINCULAR o aparelho (401 loggedOut). Era essa
# a causa das religacoes repetidas. Agora um mutex garante UM supervisor.
#
# Uso (a Tarefa Agendada chama isto):
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1
# ============================================================

$ErrorActionPreference = 'Continue'
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Raiz 'data\watchdog.log'
$FlagReligar = Join-Path $Raiz 'data\precisa-religar'
$FlagReiniciar = Join-Path $Raiz 'data\precisa-reiniciar'
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
    Write-Host $linha
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
        Add-Content -Path $Log -Value $linha -Encoding UTF8
    } catch {}
}

# Uma unica instancia de supervisor. Se outro esta vivo, sai.
$mutex = New-Object System.Threading.Mutex($false, 'BiaBotWatchdog')
$dono = $false
try { $dono = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $dono = $true }
if (-not $dono) {
    # NAO grava em data\watchdog.log: sempre que algo tenta subir um segundo
    # supervisor (o painel, um Start-ScheduledTask manual), este ramo cairia
    # aqui e encheria o log de "ja existe". O heartbeat do watchdog vivo e a
    # prova de que ha um supervisor de pe.
    Write-Host 'ja existe um watchdog ativo - saindo para nao duplicar o bot.'
    exit 0
}

function BotVivo {
    # A prova e o PROCESSO apontado pelo NOSSO data\bot.pid. Olhar a linha de
    # comando por 'bot.js' casaria tambem o bot de OUTRO projeto (ex.: outra Bia)
    # rodando na mesma maquina - e este supervisor deixaria de levantar o seu.
    $arq = Join-Path $Raiz 'data\bot.pid'
    if (-not (Test-Path -LiteralPath $arq)) { return $false }
    try {
        $o = Get-Content -LiteralPath $arq -Raw | ConvertFrom-Json
        if (-not $o.pid) { return $false }
        $p = Get-Process -Id ([int]$o.pid) -ErrorAction Stop
        return ($p.ProcessName -eq 'node')
    } catch { return $false }
}

# ============================================================
# Prova de boot antes de subir.
#
# Em 17/10 a sonda de visao quebrou porque o bot.js era novo e o enviar.js
# era velho: `enviar.testarVisao is not a function`. O bot subia, a sonda
# lancava excecao e a Bia ficava cega em silencio - o dia inteiro. O
# `npm run check` pegaria isso em 2 segundos, mas ninguem rodou.
#
# O smoke e o proprio boot, sem socket: ele carrega os mesmos modulos, roda o
# mesmo escopo e sai antes de conectar. Se o smoke falha, o bot vai morrer do
# mesmo jeito - e melhor ficar parado com o log explicando do que subir e
# morrer em silencio.
#
# O smoke roda numa pasta temporaria (so a lista de numeros e a de verdade) para
# nao encher o data\bot.log de producao com "SMOKE OK".
# ============================================================
function ValidarBoot {
    $tmp = Join-Path $env:TEMP "atende-smoke-$PID"
    try {
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $lista = Join-Path $Raiz 'data\numeros.txt'
        if (Test-Path $lista) {
            Copy-Item -Path $lista -Destination (Join-Path $tmp 'numeros.txt') -Force
        }
        $env:BIA_DATA_DIR = $tmp
        $saida = & $Node (Join-Path $Raiz 'bot.js') --smoke 2>&1 | Out-String
        $codigo = $LASTEXITCODE
        if ($codigo -ne 0) {
            Escrever "SMOKE FALHOU (saida $codigo) - o bot nao vai subir:" 
            Escrever ($saida.Trim())
            return $false
        }
        return $true
    } catch {
        Escrever "falha ao rodar o smoke: $($_.Exception.Message)"
        return $false
    } finally {
        # A variavel de ambiente e do PROCESSO: se ficar, o bot que subir em
        # seguida escreveria na pasta temporaria em vez de data\.
        Remove-Item Env:\BIA_DATA_DIR -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

# ============================================================
# Aviso fora do painel (D4).
#
# O painel mostra o banner da cegueira, mas o painel so esta aberto na frente
# de alguem. O log sozinho exige que alguem va ler. O toast aparece na area de
# trabalho - e o que faz o dono PERCEBER no meio do dia.
# ============================================================
function AvisarToast {
    param([string]$Titulo, [string]$Texto)
    try {
        $T = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $TN = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
        $t = [System.Security.SecurityElement]::Escape($Titulo)
        $x = [System.Security.SecurityElement]::Escape($Texto)
        $doc.LoadXml("<toast><visual><binding template=`"ToastText02`"><text id=`"1`">$t</text><text id=`"2`">$x</text></binding></visual></toast>")
        $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
        $T::CreateToastNotifier('PowerShell').Show($toast)
    } catch {
        # silencio-ok: o toast e um extra. Se a notificacao falhar, o log
        # continua sendo o canal confiavel.
    }
}

# O veredito de cegueira vive no health.json (o painel e o status leem o
# mesmo). O watchdog so MUDA: avisa uma vez por estado de cegueira.
#
# Dois estados de cegueira (confirmada / suspeita) e um terceiro aviso, que nao
# e cegueira: a conta sob limitacao do WhatsApp (428). O 428 e o WhatsApp
# cortando a conexao por limite de taxa - problema do NUMERO, nao da
# criptografia. A cura e re-parear a ponte e reduzir o ritmo de envio.
function ChecarCegueira {
    try {
        $h = Get-Content (Join-Path $Raiz 'data\health.json') -Raw -ErrorAction Stop | ConvertFrom-Json

        if ($h.cegueira) {
            $confirmada = [bool]$h.cegueiraConfirmada
            $chave = if ($confirmada) { 'confirmada' } else { 'suspeita' }
            if ($CegueiraAvisada -ne $chave) {
                $CegueiraAvisada = $chave
                $msg = if ($confirmada) {
                    "A sessao recebe mensagens mas nao decripta. A campanha esta pausada. Re-parear pelo painel: http://127.0.0.1:3001/ (botao 'Re-parear agora')."
                } else {
                    "O teste de visao falhou uma vez e a campanha foi pausada por precaution. Se persistir, re-pareie pelo painel: http://127.0.0.1:3001/."
                }
                Escrever "ALERTA: a Bia esta CEGA ($chave) - $msg"
                AvisarToast "empresa - a Bia esta CEGA ($chave)" $msg
            }
        } else {
            $CegueiraAvisada = $false
        }

        # Conta sob limitacao (428): o WhatsApp cortando a conexao. Nao e
        # cegueira, e o numero barrado. Avisa uma vez por estado.
        $janela = (Get-Date).AddMinutes(-30)
        $cortes = @()
        if ($h.desconexoes) {
            $cortes = @($h.desconexoes | Where-Object { "$($_.motivo)" -eq '428' -and ([datetime]$_.em) -ge $janela })
        }
        if ($cortes.Count -ge 2) {
            if (-not $LimitacaoAvisada) {
                $LimitacaoAvisada = $true
                $msg = "O WhatsApp cortou a conexao $($cortes.Count) vez(es) em 30 min (428). A sessao sobe e cai e nada de leitura acontece. A cura e RE-PAREAR a ponte e reduzir o ritmo de envio. Painel: http://127.0.0.1:3001/"
                Escrever "ALERTA: conta sob limitacao do WhatsApp (428 x$($cortes.Count)) - $msg"
                AvisarToast 'empresa - conta sob limitacao do WhatsApp' $msg
            }
        } else {
            $LimitacaoAvisada = $false
        }
    } catch {
        # silencio-ok: health.json ausente (bot ainda nao subiu) - normal.
    }
}

Escrever "watchdog iniciado (PID $PID). node=$Node"
$Beat = Join-Path $Raiz 'data\watchdog.heartbeat'

# ============================================================
# Higiene das saidas de boot.
#
# Cada tentativa de subida criava data\bot-<ts>.out e .err. Em 19/10 foram 114
# arquivos acumulados em data\. Nao e so sujeira: o painel lista os ultimos
# logs e o operador perde o que importa no meio do lixao. Guarda os 10 mais
# recentes de cada tipo.
# ============================================================
function LimparSaidasAntigas {
    param([int]$Manter = 10)
    try {
        Get-ChildItem -Path (Join-Path $Raiz 'data') -Filter 'bot-*.out' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -Skip $Manter |
            ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
        Get-ChildItem -Path (Join-Path $Raiz 'data') -Filter 'bot-*.err' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -Skip $Manter |
            ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
    } catch {}
}

try {
    $falhasSeguidas = 0
    $cegoSeguidas = 0
    $ultimoReinicioCego = $null
    $ReligarAvisado = $false
    $CegueiraAvisada = $false
    $LimitacaoAvisada = $false
    $PareandoAvisado = $false
    $DesejadaAvisada = $false
    while ($true) {
        # Prova de vida do SUPERVISOR. Sem isto, um watchdog morto e indistinguivel
        # de um watchdog quieto (ele so escreve no log quando algo muda). O painel
        # e o status podem ler este arquivo e dizer "o supervisor morreu".
        try {
            Set-Content -Path $Beat -Value (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') -Encoding UTF8
        } catch {}

        # O veredito de cegueira: avisa uma vez por estado (log + toast).
        ChecarCegueira

        # Se o bot caiu como loggedOut, nao adianta reiniciar: precisa religar
        # pelo painel. Fica quieto para nao entrar em loop.
        if (Test-Path $FlagReligar) {
            # Avisa UMA vez por estado. Antes isso escrevia a mesma linha a
            # cada 60 s e o log virava lixeira (o problema de 19/10).
            if (-not $ReligarAvisado) {
                Escrever 'precisa religar o aparelho (loggedOut) - aguardando no painel "Conectar / Trocar numero".'
                AvisarToast 'empresa - aparelho desvinculado' 'O WhatsApp desvinculou o aparelho da Bia. Re-parear pelo painel: http://127.0.0.1:3001/'
                $ReligarAvisado = $true
            }
            # A marca pode ser VELHA: o aparelho ja foi re-vinculado fora do
            # painel (ou a marca sobrou de um dia anterior). Uma marca velha
            # prendia a Bia fora do ar para sempre, porque quem apagaria a
            # marca e o proprio bot - e o bot nao subia. De 2 em 2 horas a
            # gente tenta subir assim mesmo: se o aparelho estiver mesmo
            # desvinculado, o bot volta a marcar e a espera recomeca.
            $idadeMin = ((Get-Date) - (Get-Item $FlagReligar).LastWriteTime).TotalMinutes
            if ($idadeMin -lt 120) {
                Start-Sleep -Seconds 60
                continue
            }
            Escrever ("marca de religar com {0:N1} h - o aparelho pode ja estar vinculado; tentando subir assim mesmo." -f ($idadeMin / 60))
        } else {
            $ReligarAvisado = $false
        }

        if (-not (BotVivo)) {
            # A Bia sobe so quando o dono manda ("Subir a Bia" no painel grava
            # data\bot-desejado). Sem a marca, o supervisor nao levanta nada:
            # era isso que fazia a Bia "acordar sozinha" ao reabrir o painel ou
            # depois de um reboot.
            if (-not (Test-Path (Join-Path $Raiz 'data\bot-desejado'))) {
                if (-not $DesejadaAvisada) {
                    Escrever 'a Bia esta parada por decisao do dono - suba pelo botao "Subir a Bia" no painel.'
                    $DesejadaAvisada = $true
                }
                Start-Sleep -Seconds 20
                continue
            }
            $DesejadaAvisada = $false

            # PAREAmento em andamento (connect.js vivo): o bot NAO pode subir.
            # O connect.js precisa do socket/aparelho unico; o bot morreria na
            # trava (pid.lock) e o supervisor ficaria tentando de novo, o que
            # aparece para o dono como "login em timeout constante". Espera.
            $pareando = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'connect\.js' -and $_.CommandLine -like "*$Raiz*" }
            if ($pareando) {
                if (-not $PareandoAvisado) {
                    Escrever 'pareamento em andamento (connect.js) - o bot espera o pareamento terminar.'
                    $PareandoAvisado = $true
                }
                Start-Sleep -Seconds 15
                continue
            }
            $PareandoAvisado = $false

            # Reinicio pedido pelo proprio bot (data\precisa-reiniciar).
            # Um reinicio de processo limpa o estado travado do socket; mas se a
            # cegueira volta logo, reiniciar nao esta curando - escala para
            # re-parear, que e a unica cura de verdade.
            if (Test-Path $FlagReiniciar) {
                $agora = Get-Date
                if ($ultimoReinicioCego -and ($agora - $ultimoReinicioCego).TotalMinutes -lt 20) {
                    $cegoSeguidas++
                } else {
                    $cegoSeguidas = 1
                }
                $ultimoReinicioCego = $agora
                Remove-Item $FlagReiniciar -Force -ErrorAction SilentlyContinue
                if ($cegoSeguidas -ge 2) {
                    Escrever 'cegueira voltou apos reiniciar - reinicio nao cura. Marcando precisa-religar (re-parear no painel).'
                    New-Item -ItemType File -Force -Path $FlagReligar | Out-Null
                    Start-Sleep -Seconds 60
                    continue
                }
                Escrever "bot pediu reinicio (ocorrencia $cegoSeguidas) - subindo limpo."
            } else {
                $cegoSeguidas = 0
            }

            # A prova de boot: se o smoke falha, nao sobe. Subir para morrer em
            # silencio e o que escondeu o defeito de 17/10.
            if (-not (ValidarBoot)) {
                Escrever 'boot nao validado - o bot fica parado ate o defeito ser corrigido (veja a saida do smoke acima).'
                Start-Sleep -Seconds 60
                continue
            }

            Escrever 'bot nao esta rodando - subindo.'
            # stdout/stderr com timestamp: antes eram SEMPRE os mesmos arquivos e
            # o Start-Process truncava a cada tentativa - o motivo da falha de
            # boot (o erro que o bot cuspiu) era perdido justamente quando importava.
            $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
            $out = Join-Path $Raiz "data\bot-$ts.out"
            $err = Join-Path $Raiz "data\bot-$ts.err"
            try {
                Start-Process -FilePath $Node -ArgumentList 'bot.js' -WorkingDirectory $Raiz `
                    -RedirectStandardOutput $out `
                    -RedirectStandardError $err `
                    -WindowStyle Hidden | Out-Null
            } catch {
                Escrever "falha ao subir o bot: $($_.Exception.Message)"
            }

            Start-Sleep -Seconds 20

            if (BotVivo) {
                Escrever "bot subiu (saida em data\$(Split-Path -Leaf $out))."
                $falhasSeguidas = 0
                LimparSaidasAntigas
            } else {
                $falhasSeguidas++
                Escrever "bot NAO subiu (falha $falhasSeguidas seguida(s)). Veja data\$(Split-Path -Leaf $err)."
                $espera = [Math]::Min(300, 30 * $falhasSeguidas)
                Escrever "esperando $espera s antes de tentar de novo."
                Start-Sleep -Seconds $espera
            }
        }
        Start-Sleep -Seconds 30
    }
} finally {
    # Se o supervisor morrer, isto aparece no log. Antes ele sumia em silencio.
    Escrever "watchdog encerrando (PID $PID)."
    try { $mutex.ReleaseMutex() } catch {}
}
