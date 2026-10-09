# Como usar o Balde

O Balde lê as mensagens dos grupos de WhatsApp que você listar e transforma tudo
em micro-tarefas num painel no seu Mac. Todos os comandos abaixo rodam **dentro
da pasta `balde/`**.

## 1. Chaves no `.env`

Crie o arquivo `balde/.env` (uma variável por linha, **sem aspas**):

```
BALDE_LLM=openai
OPENAI_API_KEY=sk-...sua-chave...

BALDE_EVOLUTION_URL=https://sua-evolution.com
BALDE_EVOLUTION_KEY=...
BALDE_EVOLUTION_INSTANCIA=nome-da-instancia
```

- Sem a chave da OpenAI, o Balde continua funcionando no modo heurístico (sem IA).
- Sem as três variáveis da Evolution, nenhuma mensagem chega e os links
  `chat.whatsapp.com/...` não viram grupo.
- Para desligar os avisos do macOS de tarefas novas, coloque `BALDE_NOTIFICAR=0`.
- O `.env` só é lido quando o Balde liga. Depois de mudar o arquivo, reinicie
  (veja o item 5).

## 2. Grupos no `GRUPOS.md`

É uma tabela. Cada linha é um grupo que o Balde pode ler:

```
| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |
|---|---|---|---|---|---|---|
| Alfa Tech | Website | https://chat.whatsapp.com/AbC123 | 6.000,00 | 01/01/2026 | 31/12/2026 | cliente |
| | | 120363099999999999@g.us | | | | despejo |
```

- **Link**: o convite `https://chat.whatsapp.com/...` ou o código `...@g.us`.
- **Ganho**: no formato `6.000,00`. **Início/Fim**: `dd/mm/aaaa`, podem ficar vazios.
- **Tipo**: `cliente` (grupo de um projeto, precisa de Empresa) ou `despejo`
  (grupo onde você joga coisas soltas, Empresa pode ficar vazia).
- **Salvou, valeu.** O Balde recarrega sozinho. Linha com erro é ignorada e
  vira aviso, e o resto continua valendo.
- Não tem o arquivo ainda? No painel, clique em **Grupos** → **Abrir no editor**:
  ele cria o `GRUPOS.md` a partir do exemplo e abre no seu editor.

### Achar, adicionar e criar grupos sem copiar jid

```
node bin/grupos.mjs buscar acme, padaria        # linha pronta de cada grupo achado
node bin/grupos.mjs adicionar acme --projeto Site --ganho 3000
node bin/grupos.mjs criar "Cliente | Site" --participantes 5511999990000 --sim --adicionar
```

- **buscar** ignora acento, maiúscula e emoji. Termo não achado = o número não está nesse grupo.
- **adicionar** põe a linha no fim do `GRUPOS.md` (empresa/projeto sugeridos pelo nome do grupo;
  `--empresa`, `--projeto`, `--tipo`, `--ganho` corrigem). Jid que já está lá não duplica.
- **criar** sem `--sim` só mostra o que faria. Com `--sim` cria de verdade e mostra jid e convite.
- No painel, **Grupos** tem a mesma busca com botão **Adicionar** (criar grupo é só pela linha de comando).

## 3. Painel

Abra **http://127.0.0.1:7391** no navegador. As tarefas aparecem por empresa e
por projeto, com quem paga mais em cima. Dentro de cada projeto, a ordem é
ganho, depois o prazo mais próximo, depois a urgência.

| Estado | Quer dizer |
|---|---|
| **Falta info** | O Balde precisa de algo que não veio. A linha "Falta:" diz o quê. |
| **Pra fazer** | A tarefa está clara e pronta para começar. |
| **Decidir** | A tarefa depende de uma decisão sua. |
| **Fazendo** | A tarefa está em andamento. |
| **Feita** | A tarefa foi concluída e vai para a lista recolhida "Feitas" no fim do projeto. |

- **Check** na tarefa = Feita. Se você desmarcar, ela volta para Pra fazer.
- Clique na seta para abrir a tarefa e editar título, estado, **Ganho R$/mês**,
  **Início** e **Fim**. Se deixar vazio, o campo usa o valor do projeto que está no `GRUPOS.md`.
- **Mensagens-fonte** mostra as mensagens do WhatsApp que geraram a tarefa.

## 4. Distribuir e `DESTINOS.md`

Copie `DESTINOS.exemplo.md` para `DESTINOS.md` e deixe só os destinos que
você autoriza. O arquivo é privado: não suba para o Git.

| Tipo | O que acontece |
|---|---|
| `webhook` | O Balde manda a tarefa e as mensagens-fonte para a URL (ex.: seu n8n). |
| `agente` | O Balde cria um briefing em `dados/despacho/<id-da-tarefa>.md`. |
| `comando` | O Balde roda o programa do Alvo passando o caminho desse briefing. |

No painel: abra a tarefa → **Distribuir** → escolha o tipo e digite o **Alvo
exatamente como está na tabela**. Só é executado o que bate com uma linha do
`DESTINOS.md`. O resto fica registrado como falha.

> **Em breve:** hoje o seletor do painel oferece Automação, Agente, Skill e Fluxo.
> Só **Agente** bate com o `DESTINOS.md`. Pelo painel, ainda não dá para mandar
> para **webhook** (n8n) nem para **comando**.

## 5. Deixar sempre ligado (macOS)

```
node bin/servico.mjs instalar     # liga agora e a cada login; se cair, volta sozinho
node bin/servico.mjs status       # mostra se o processo está rodando e se o painel responde
node bin/servico.mjs logs         # mostra onde ficam os logs (~/Library/Logs/balde/)
node bin/servico.mjs desinstalar  # desliga (os logs ficam guardados)
```

Para **reiniciar** depois de mexer no `.env`, rode `instalar` de novo.
Para testar sem o serviço: `npm start` (para com Ctrl+C).

## 6. O que o Balde NUNCA faz

- **Não envia mensagem** no WhatsApp. Ele só lê.
- **Não mexe no webhook** da Evolution (o que alimenta seu CRM). Ele só liga o
  WebSocket da instância para receber as mensagens.
- **Só lê os grupos listados** no `GRUPOS.md`. Mensagens de qualquer outro
  grupo e as conversas privadas são descartadas.
- **Não distribui** para destinos que não estejam no `DESTINOS.md`.

## 7. Problemas comuns

> **Em breve:** `node bin/diagnostico.mjs` (checagem automática). Por enquanto:

| Sintoma | Verifique |
|---|---|
| O painel não abre | Rode `node bin/servico.mjs status`. Se der erro, rode `instalar` e veja o `err.log`. |
| Um grupo não aparece | Abra **Grupos** no painel e leia os avisos de cada linha. Para usar link de convite, a Evolution precisa estar configurada no `.env`. |
| Nenhuma tarefa nova | Confira as três variáveis `BALDE_EVOLUTION_*` no `.env` e veja o `out.log`. |
| As tarefas saem pobres, sem IA | Confira se `OPENAI_API_KEY` está no `.env` e reinicie o Balde. |
| Distribuir não fez nada | Confira se o Tipo e o Alvo batem com uma linha do `DESTINOS.md`. |
