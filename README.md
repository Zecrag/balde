# Balde WhatsApp

Ferramenta para organização e automação de micro tarefas a partir do WhatsApp. 

## Requisitos

- Mac
- Node.js versão 20 ou superior

## Como instalar

1. Baixe o repositório para o seu computador.
2. Dê um duplo clique no arquivo `instalar.command`.
3. O script irá verificar os requisitos, instalar dependências e iniciar o serviço.
4. O seu navegador abrirá automaticamente no endereço: `http://127.0.0.1:7391/setup`.
5. Cole a sua chave da OpenAI.
6. Conecte o seu WhatsApp (veja abaixo).
7. Marque os grupos que deseja monitorar.
8. Pronto!

## Como conectar seu WhatsApp

No passo 2 do assistente há três caminhos:

1. **Tenho um código de convite (recomendado).** Quem te indicou o Balde roda `node bin/convite.mjs criar "Seu Nome" --sim` e te manda um código (ou um link `http://127.0.0.1:7391/setup#convite=...`). Cole o código, escaneie o QR code no celular (WhatsApp › Aparelhos conectados › Conectar aparelho) e pronto: não precisa de servidor. O código só abre o seu WhatsApp, nunca o de quem convidou; para desligar, essa pessoa roda `node bin/convite.mjs revogar "Seu Nome" --sim`.
2. **QR direto neste Mac (Baileys).** Conecta sem servidor nenhum, mas o Mac precisa ficar ligado para o Balde ler os grupos.
3. **Tenho Evolution própria.** Informe a URL, a chave e o nome da instância do seu servidor Evolution.

Depois de conectar, marque os grupos que o Balde deve ler e diga de qual empresa/projeto é cada um.

## Como deixar ligado sempre (Background)

Se desejar que o serviço continue rodando mesmo após fechar o terminal, você pode instalar o serviço em background rodando no terminal:

```bash
node bin/servico.mjs instalar
```
