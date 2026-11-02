# Como instalar a Bia (passo a passo)

Guia curto para quem **não** é técnico. Faça uma vez; depois é só abrir o atalho.

> **Onde ficam seus dados:** fora da pasta do programa, em
> `%LOCALAPPDATA%\bia-bot`. A lista importada e os logs da sessão são apagados
> quando você usa **"Desligar Bia"**. O bot lembra de quem pediu para sair.
>
> **Quantas mensagens por dia:** o padrão é **20**. Número novo não deve passar
> disso. Para mudar, edite `config.local.js` (`repique.porDia`).

## 1. Instalar o Node.js
1. Abra o navegador e vá em **https://nodejs.org**.
2. Baixe a versão **LTS** e instale clicando **Avançar/Next** até o fim.

## 2. Copiar a pasta do bot
1. Copie a pasta **atende-bot** para um lugar fixo (ex.: `C:\atende-bot`).
2. Se veio num `.zip`, clique com o botão direito → **Extrair tudo**.

## 3. Instalar (uma vez)
1. Dentro da pasta, dê **duplo-clique em `INSTALAR.bat`**.
2. Espere aparecer **"Tudo pronto!"**. Pode fechar a janela.
3. Na **Área de Trabalho** vão aparecer três atalhos: **"Ligar Bia"**,
   **"Desligar Bia"** e **"Alimentar a Bia"**.

> A Bia **não** liga sozinha quando o computador é ligado. O atalho
> **"Ligar Bia"** abre o painel; a Bia sobe quando você clica em
> **"Subir a Bia"** dentro do painel.

## 4. Usar no dia a dia
1. Dê **duplo-clique em "Ligar Bia"**: o painel abre no Firefox (a Bia ainda
   fica parada).
2. Clique em **"Subir a Bia"** no topo do painel. Em alguns segundos ela conecta.
3. Dê **duplo-clique em "Alimentar a Bia"** (abre a página de importar a lista).
4. No painel da empresa, **selecione e copie** a lista de contatos.
5. **Cole** na caixa grande e clique em **Importar contatos**.
6. Confira o resultado: *X novos, Y repetidos, Z inválidos*.
7. Abaixo da caixa aparece a **lista de contatos** (nome + telefone), para você
   conferir quem está lá.
8. Quando quiser que a Bia comece a enviar, clique em **Ligar envios**.
   - Para, é só clicar em **Pausar envios**.
9. No fim do dia, duplo-clique em **"Desligar Bia"** (nada é apagado).

Para **conectar um aparelho novo**: no painel, clique em **"Conectar por
código"** (ou QR). O painel **derruba a Bia sozinho** durante o pareamento; ao
terminar, clique em **"Subir a Bia"**.

Na parte de baixo do painel aparece **Mensagens recebidas**: quem escreveu para
a Bia, o que escreveu e se a equipe já foi avisada. É ali que você confere
se alguma recusa ou dúvida ficou sem resposta.

### Exportar a lista
Clique em **Exportar lista (.txt)**. O navegador baixa um arquivo com os
contatos no formato `numero;Nome` — bom para guardar uma cópia ou reimportar
depois.

### Remover um contato
Na lista de contatos, clique em **Remover** ao lado da pessoa. A Bia para de
responder a esse número (o histórico é preservado).

A Bia manda **até 100 por dia**, **só números novos**, durante o horário de
funcionamento, e **percorre a lista inteira** nesse ritmo — pode importar todos
de uma vez que ela continua de onde parou nos dias seguintes. A mensagem começa
com o **primeiro nome** do contato (por isso vale sempre importar com nome).
Quem já recebeu ou recusou nunca é tocado de novo.

## Backup (não perder a Bia)
- O bot já faz backup **sozinho** (ao ligar e todo dia de madrugada) numa pasta
  **Bia-Backup** no seu **OneDrive**.
- Para fazer na hora: duplo-clique em **`BACKUP.bat`**.

## Se o computador for formatado
1. Instale o Node (passo 1).
2. Copie de volta a pasta **atende-bot**.
3. Pegue o backup mais recente (pasta **Bia-Backup** no OneDrive).
4. **Arraste o arquivo `.zip` do backup sobre `RESTAURAR.bat`**.
5. Depois duplo-clique em **`INSTALAR.bat`**.

A Bia volta conectada, **sem precisar ler QR de novo**.

## Se algo não funcionar
- **O atalho não abre:** espere 1 minuto e tente de novo; se continuar, rode
  `INSTALAR.bat` outra vez.
- **A Bia não responde:** confira se o computador está ligado e com internet, e
  se o horário está dentro do funcionamento (seg–sex 9h–18h, sáb 9h–14h).
- **Deu erro no `INSTALAR.bat`:** tire um print da janela e mande para quem te
  passou o bot.

## No Linux (ou Mac)

O painel é o mesmo site (`http://127.0.0.1:3001`). Os arquivos `.bat`/`.ps1`
são do Windows e **não são usados aqui** — no lugar deles existem o
`iniciar.sh` e o `parar.sh`.

**1. Instalar o Node.js e os utilitários de zip** (uma vez):

```bash
sudo apt install nodejs npm zip unzip      # Debian/Ubuntu
```

No Mac, instale o Node pelo site oficial (ou `brew install node`); `zip` e
`unzip` já vêm de fábrica.

**2. Copiar a pasta do bot** para um lugar fixo (ex.: `~/bia-bot`) e entrar nela:

```bash
cd ~/bia-bot
npm install
```

**3. Usar no dia a dia:**

```bash
./iniciar.sh      # sobe o painel e abre o navegador
./parar.sh        # desliga tudo (nada é apagado)
```

Igual ao Windows: abrir o painel **não** liga a Bia. Ela só sobe quando você
clica em **"Subir a Bia"** — e a partir daí o supervisor a reergue sozinha se
ela cair.

**4. Deixar o painel no ar sempre** (opcional, para máquina que fica ligada):

```bash
mkdir -p ~/.config/systemd/user
cp systemd/bia-painel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bia-painel
sudo loginctl enable-linger "$USER"
```

Se a pasta do projeto não for `~/Documentos/Projetos/Bia-Sistema-Windows11-2026-10-29-1540/bia-bot`,
abra `~/.config/systemd/user/bia-painel.service` e corrija a linha
`WorkingDirectory`.

**Se algo não funcionar:**

- **`./iniciar.sh` diz "Permission denied":** rode `chmod +x iniciar.sh parar.sh`.
- **"O comando zip não está instalado":** `sudo apt install zip unzip`. Sem isso
  o backup não roda (o resto funciona).
- **"a campanha manda imagem, mas nao ha biblioteca de imagem":** rode
  `npm install sharp`. Sem ela, todo envio com foto falharia — por isso a Bia
  se recusa a subir em vez de falhar em silêncio.
- **Não sei o que está no ar:** `npm run controle`.
- **O painel não abre:** veja o fim de `data/painel.err`.
