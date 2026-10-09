# Conector WhatsApp Direto via QR (Baileys)

> **GB-37** — Modo "WhatsApp direto" para quem não tem Evolution.  
> Conecta um número pelo QR code e ouve mensagens de grupos selecionados.

---

## ⚠️ Aviso importante

Este conector usa **Baileys** (`@whiskeysockets/baileys`), um cliente **não oficial** do WhatsApp.

- O WhatsApp pode detectar e **bloquear o número** conectado.
- **Use sempre um número secundário**, nunca o número principal da empresa.
- O risco de bloqueio é real. Leia a licença do Baileys antes de usar em produção.

---

## O que faz

- Conecta um número WhatsApp via QR code (escaneado pelo celular)
- Ouve mensagens de grupos selecionados em **modo somente leitura**
- Converte cada mensagem para o formato Baileys JSON que `lib/ingestao/normalizar.mjs` já aceita
- Baixa e descriptografa mídia (áudio, imagem, documento) automaticamente
- Gera o QR code como PNG data-URL (sem dependência extra — usa o pacote `qrcode`)
- **Nunca envia mensagem, nunca marca como lida, nunca vai online**

---

## Instalação

As dependências ficam **separadas** do balde principal.

```bash
# De dentro de balde/
cd conectores/baileys
npm install
```

O `balde/package.json` principal continua **sem dependências**.

---

## API do módulo

```js
import { iniciarBaileys } from '../../lib/whatsapp/index.mjs';

const handle = await iniciarBaileys({
  // Diretório onde a sessão é persistida (gitignored)
  pastaSessao: 'dados/whatsapp-sessao',

  // Chamado quando o QR code está pronto para escanear
  aoQR(qrString, qrPngDataUrl) {
    // qrString: string raw do QR (para terminais ou outros renderers)
    // qrPngDataUrl: 'data:image/png;base64,...' — pronto para <img src>
    console.log('Escaneie o QR:', qrPngDataUrl);
  },

  // Chamado quando a conexão é estabelecida
  aoConectar(info) {
    // info: { telefone, nome, pushName }
    console.log('Conectado como', info.nome);
  },

  // Chamado a cada mensagem de grupo recebida
  aoMensagem(payload) {
    // payload: formato Baileys JSON (compatível com normalizar.mjs, provedor 'baileys')
    // Passe para: await normalizar(payload, 'baileys', { midiaDir })
  },

  // Opcional: filtra grupos. Retorna array de JIDs ou [] para todos.
  gruposPermitidos() {
    return ['120363098765432100@g.us', '120363000000000001@g.us'];
  },
});

// Métodos disponíveis:
const grupos = await handle.listarGrupos();
// → [{ jid: '120363...@g.us', nome: 'Projeto Alpha', participantes: ['5511...'] }]

handle.estado();
// → 'aguardando-qr' | 'conectado' | 'desconectado' | 'reconectando'

handle.desconectar();
// Encerra a conexão permanentemente
```

---

## Integrando com o normalizador

```js
import { iniciarBaileys } from '../../lib/whatsapp/index.mjs';
import { normalizar } from '../../lib/ingestao/normalizar.mjs';

const handle = await iniciarBaileys({
  pastaSessao: 'dados/whatsapp-sessao',
  aoQR:        (str, png) => exibirQrNopainel(png),
  aoConectar:  (info)     => console.log('Conectado:', info.nome),
  aoMensagem:  async (payload) => {
    // Normaliza para o formato unificado Mensagem do balde
    const msg = await normalizar(payload, 'baileys', {
      midiaDir: 'dados/midia',
    });
    // msg: { id, chatId, chatNome, origem, autor, ts, tipo, texto, midiaPath?, raw }
  },
  gruposPermitidos: () => config.grupos.map(g => g.jid),
});
```

---

## Sessão persistida

A sessão fica em `dados/whatsapp-sessao/` (já no `.gitignore`).

- Enquanto a sessão existir, não é necessário escanear o QR novamente
- Para desconectar e forçar novo QR: apague a pasta `dados/whatsapp-sessao/`
- Em caso de logout pelo celular: o conector detecta e avisa no console

---

## Modos de estado

| Estado | Significado |
|--------|-------------|
| `aguardando-qr` | Conexão iniciada, aguardando escanear o QR |
| `conectado` | QR escaneado, ouvindo mensagens |
| `reconectando` | Conexão caiu, tentando reconectar (automático) |
| `desconectado` | Logout ou `desconectar()` chamado manualmente |

---

## Testes

```bash
# Da raiz do projeto (sem as deps do conector instaladas — usa mocks)
cd balde/
node --test test/whatsapp-baileys.test.mjs
```

Os testes usam socket mockado: **sem rede, sem WhatsApp real**.

---

## Estrutura de arquivos

```
balde/
  lib/whatsapp/
    baileys.mjs         ← implementação do conector
    index.mjs           ← re-export estável
  test/
    whatsapp-baileys.test.mjs  ← testes com mock
  conectores/baileys/
    package.json        ← deps do conector (separadas)
    LEIA.md             ← este arquivo
    node_modules/       ← instalados com: cd aqui && npm install
  dados/
    whatsapp-sessao/    ← sessão persistida (gitignored)
```

---

## Limitações conhecidas

- Não envia mensagens (by design — modo leitura)
- Não suporta múltiplos números simultaneamente (uma instância por número)
- Pode ser bloqueado pelo WhatsApp se detectado como cliente não oficial
- Requer Node.js ≥ 20
