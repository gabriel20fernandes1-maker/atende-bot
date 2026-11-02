# Atende Bot

Sistema de atendimento para WhatsApp: pega uma lista de contatos, envia **uma**
mensagem perguntando se a pessoa ainda tem interesse, responde quem responder e
avisa a equipe quando o contato vira oportunidade. Tem painel local, supervisor,
backup e um conjunto de guardas contra envio em rajada.

Feito para rodar no computador do próprio negócio (Windows ou Linux), com Node
portátil: sem servidor, sem banco, sem conta em nuvem.

---

## Requisitos

- Node.js 20+ (o instalador do Windows já leva um Node portátil).
- Um número de WhatsApp dedicado ao atendimento (não use o número pessoal).
- Windows 10/11 ou Linux/macOS.

## Instalação rápida

**Windows**

1. Extraia a pasta `atende-bot` em um lugar fixo (`C:\atende-bot`).
2. Duplo-clique em `INICIAR.bat`.
3. Espere "Tudo pronto!" e o painel abrir no navegador.

**Linux / macOS**

```bash
npm install
npm run subir     # sobe o painel e abre o navegador
```

No painel: pareie o WhatsApp (QR ou código), importe a lista e ligue a campanha.

---

## Configuração

Os padrões do `config.js` são genéricos e seguros. O que é seu vai em
**`config.local.js`** (não versionado):

```bash
cp config.local.example.js config.local.js
```

Lá você define:

| Campo | Para quê |
|---|---|
| `botNome` | Nome de quem fala com a pessoa (`{botNome}`) |
| `empresa` | Nome do negócio (`{empresa}`) |
| `assunto` | Completa "Você ainda tem interesse ___?" |
| `endereco` | Resposta para "onde fica". Vazio = a equipe responde |
| `escopo.equipe` | Números que **nunca** entram em campanha; só recebem aviso |
| `repique.porDia` | Teto diário de mensagens |
| `atendimento.dias` | Horário de funcionamento (= janela de envio) |
| `textos` | **Todas** as falas e todos os avisos da equipe |
| `privacidade` | Limpeza de sessão |

### Textos

Tudo o que o bot fala e tudo o que ele avisa para a equipe é editável em
`textos`. O que você não escrever, vale o padrão do `templates.js`.

```js
textos: {
  repique: {
    comNome: 'Oi, {nome}! Aqui é {botNome}, da {empresa}.\nVocê ainda tem interesse {assunto}?',
    semNome: 'Oi! Aqui é {botNome}, da {empresa}.\nVocê ainda tem interesse {assunto}?',
  },
  respostas: {
    interesse: '...',
    negacao: '...',
    talvez: '...',
    protocolo: '...',
    enderecoVazio: '...',
    sobre: 'Somos a {empresa}.',
  },
  avisos: {
    modelo: '{titulo}\n• {nome} — {numero}\n{rotulo}: "{texto}"\n{rodape}',
    tipos: {
      interesse: { titulo: 'Novo interesse!', rodape: 'Pode chamar.', rotulo: 'Respondeu' },
      // ...
    },
  },
}
```

Marcadores: `{nome}` `{botNome}` `{empresa}` `{assunto}` `{endereco}`.
A mensagem da campanha também pode ser trocada pelo painel, sem reiniciar.

---

## Onde ficam os dados

Nada de dado de execução dentro da pasta do código:

| Sistema | Pasta |
|---|---|
| Windows | `%LOCALAPPDATA%\bia-bot` |
| Linux/macOS | `~/.local/share/bia-bot` |
| Qualquer um | `BIA_HOME=/caminho` |

```
bia-bot/
├── auth/              sessão do WhatsApp (pareamento)
├── data/
│   ├── estado.json    histórico por contato — chaves são HASH, não telefone
│   ├── supridos.txt   quem pediu para sair — só hashes
│   ├── numeros.txt    lista importada (sessão)
│   └── mensagens.json feed de recebidas (sessão)
├── backups/           zip de auth + estado
└── sal                chave dos hashes (não perca: sem ela, a memória de
                       opt-out não é reconhecida)
```

Instalações antigas guardavam `auth/`, `data/` e `backups/` dentro do projeto.
Na primeira execução desta versão eles são **movidos** para a pasta acima
automaticamente.

### Nome e telefone são dado de sessão

- O estado guarda **hash** do número, nunca o número.
- Nomes só existem em memória e no `mensagens.json` da sessão.
- Ao desligar (`Desligar Bia` / `npm run descer`), a lista, o feed e os logs são
  apagados. Ficam o estado (hasheado) e a lista de opt-out (hasheada).
- `config.privacidade.maxHorasSessao` apaga a sessão anterior no boot se ela
  ficou parada mais que isso (0 desliga).

Para ver onde estão os dados: `npm run privacidade`.

---

## A lista de repique

`data/numeros.txt`, uma linha por contato:

```
5511999999999;Maria
5511888888888;João
# comentário
```

O nome depois do `;` é opcional. Número da equipe na lista é recusado.

A lista é a **única autorização para enviar**. Lista vazia = o bot não sobe.

---

## Campanha e teto diário

O bot manda no máximo `repique.porDia` mensagens novas por dia, com intervalo
aleatório e "digitando" antes de cada uma.

> **Número novo: no máximo 20 por dia.**
>
> Volume alto em número sem histórico é o que mais derruba conta no WhatsApp.
> Comece com 20, suba no máximo 10 a cada 3–4 dias de uso normal. Ajuste por
> `config.local.js` ou `BIA_POR_DIA=20`.

Quem responde "não" é marcado como opt-out e **nunca** é contatado de novo —
nem depois de reiniciar, porque a supressão vive fora da sessão.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run subir` / `npm run descer` | sobe / derruba painel e bot |
| `npm run controle` | mostra o que está no ar |
| `npm run painel` | abre só o painel |
| `npm run connect` | pareia o WhatsApp |
| `npm run bot` | roda o bot no terminal |
| `npm run status` | diagnóstico da sessão |
| `npm run simulate` | teste seco: textos + classificador, sem enviar |
| `npm run test` | testes automatizados |
| `npm run check` | portão de segurança/qualidade |
| `npm run pack` | gera o `.zip` para distribuir |
| `npm run privacidade` | onde estão os dados e idade da sessão |
| `npm run limpar` | apaga o dado de sessão agora |

## Backup

O `backup.js` zipa `auth/` + `estado.json` + `supridos.txt` + `sal` e mantém
`backupManter` cópias (padrão: 14). No Windows o destino é a pasta do OneDrive,
se existir; senão `BIA_HOME/backups`.

Restaurar: `npm run backup` no destino errado é inútil — use `RESTAURAR.bat` ou
copie o zip para a pasta de dados e descompacte.

---

## Regras que não se mexem

1. Só fala com quem está na lista.
2. Número da equipe nunca entra em campanha.
3. Opt-out é definitivo e sobrevive ao restart.
4. Fora do horário de funcionamento, não envia e não responde.
5. Uma mensagem nova por pessoa, na vida.
6. Nunca promete preço, desconto, vaga ou emprego.

O `npm run check` verifica 1–6 no código: guard órfão, telefone em claro, nome de
cliente, sessão dentro do projeto e configuração insegura derrubam o check.

---

## Avisos legais

- **Baileys não é a API oficial do WhatsApp.** Automatizar um número viola os
  termos do WhatsApp e pode resultar em bloqueio. O risco é de quem opera.
- **LGPD:** contate apenas quem já teve relação com o negócio e espera o
  contato. Lista comprada ou "fria" é problema jurídico, não só de ban.
- Quem pedir para sair, sai. O sistema já faz isso — não desligue.

---

## Estrutura

```
bot.js               o bot (inbound, campanha, heartbeat)
painel.js            painel local (127.0.0.1, só o operador)
lifecycle.js         conexão e reconexão do socket
supervisor.js        mantém bot e painel de pé
plataforma.js        diferenças Windows/Linux
estado.js / store.js estado por contato (hash)
supressoes.js        opt-out persistente (hash)
privacidade.js       pastas, sessão, migração, detecção de PII
numeros.js           leitura/validação da lista
templates.js         falas padrão (editáveis)
mensagens-campanha.js mensagem da campanha (editável no painel)
*.guard.js           escopo, envio, rajada, dedupe
tests/               testes + check
scripts/pack.js      empacotador com whitelist
```

---

## Publicando

```bash
npm run check   # precisa passar
npm run pack    # dist/atende-bot-vX.Y.Z.zip
```

O `pack` usa whitelist e **relê o zip**: se `auth/`, `data/`, `config.local.js`
ou `node_modules` aparecerem, ele aborta e apaga o arquivo.

Licença: MIT (veja `LICENSE`).
