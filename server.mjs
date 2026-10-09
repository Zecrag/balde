/**
 * @file server.mjs — Servidor único do Balde (porta padrão: 7391)
 *
 * Monta:
 *   1. Webhook de ingestão (de lib/ingestao, escuta em /webhook/:provedor)
 *   2. API REST (de lib/api.mjs, escuta em /api/*) + leitura manual e custo
 *      (lib/leitura.mjs: POST /api/ler, GET /api/ler, GET /api/uso)
 *   3. Painel web estático (de painel/, servido em / e /painel/*)
 *
 * Sem dependências npm externas (Node.js nativo >= 20 ESM).
 */

import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Carrega balde/.env sem sobrescrever o que já veio do ambiente
 * (BALDE_EVOLUTION=0 no shell/launchd vence BALDE_EVOLUTION=1 no .env).
 */
export function carregarEnvLocal(envPath = join(__dirname, '.env'), env = process.env) {
  try {
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [k, ...v] = trimmed.split('=');
      const chave = k.trim();
      if (chave && !Object.prototype.hasOwnProperty.call(env, chave)) env[chave] = v.join('=').trim();
    }
  } catch (e) {}
}

/**
 * Leitura automática da Evolution (WebSocket, polling, catch-up) é opt-in desde o GB-44:
 * o padrão é leitura MANUAL (POST /api/ler, bin/ler.mjs). Liga com BALDE_LEITURA=auto
 * ou opcoes.evolution=true; BALDE_EVOLUTION=0/false/off ou opcoes.evolution=false desligam sempre.
 */
export function evolutionLigada(opcoes = {}, env = process.env) {
  if (opcoes.evolution === false) return false;
  if (['0', 'false', 'off', 'nao', 'não'].includes(String(env.BALDE_EVOLUTION ?? '').trim().toLowerCase())) return false;
  return opcoes.evolution === true || String(env.BALDE_LEITURA ?? '').trim().toLowerCase() === 'auto';
}

import * as store from './lib/store.mjs';
import { obterStorePadrao } from './lib/store.mjs';
import { processar } from './lib/motor/index.mjs';
import { criarApi } from './lib/api.mjs';
import { criarRotaLeitura, ROTAS_LEITURA } from './lib/leitura.mjs';
import { iniciarWatcher } from './lib/config.mjs';




// ─── Garantia de diretórios e arquivos de configuração básicos ───────────────
function garantirDiretorios() {
  const configDir = process.env.BALDE_CONFIG || join(__dirname, 'config');
  const dadosDir = process.env.BALDE_DADOS || join(__dirname, 'dados');

  mkdirSync(configDir, { recursive: true });
  mkdirSync(dadosDir, { recursive: true });
  mkdirSync(join(dadosDir, 'contextos'), { recursive: true });
  mkdirSync(join(dadosDir, 'midia'), { recursive: true });
  mkdirSync(join(dadosDir, 'midia', '.cache'), { recursive: true });

  const clientesJson = join(configDir, 'clientes.json');
  const clientesExemploJson = join(configDir, 'clientes.exemplo.json');
  // Só cria clientes.exemplo.json se configDir for o default ou se clientesExemplo existir no root
  if (!existsSync(clientesJson)) {
    const sourceExemplo = existsSync(clientesExemploJson) ? clientesExemploJson : join(__dirname, 'config', 'clientes.exemplo.json');
    if (existsSync(sourceExemplo)) {
      try {
        copyFileSync(sourceExemplo, clientesJson);
        console.warn('[Balde] AVISO: config/clientes.json não encontrado. Usando clientes.exemplo.json como fallback (SEM MOTOR REAL).');
      } catch (err) {
        console.warn('[Balde] Aviso ao copiar clientes.exemplo.json:', err.message);
      }
    }
  }
}

// ─── Importação de interfaces dos módulos do contrato ────────────────────────
let enriquecer = async (m) => m;
try {
  const midiaMod = await import('./lib/midia/index.mjs');
  if (typeof midiaMod.enriquecer === 'function') {
    enriquecer = midiaMod.enriquecer;
  }
} catch (e) {
  console.warn('[Balde] Módulo lib/midia/index.mjs não encontrado ou pendente, usando fallback.');
}

// ─── Motor real — sem fallback ──────────────────────────────────────────────
console.log('[Balde] Motor real carregado com sucesso.');

let criarHandlerWebhook = null;
try {
  const ingestaoMod = await import('./lib/ingestao/index.mjs');
  if (typeof ingestaoMod.criarHandlerWebhook === 'function') {
    criarHandlerWebhook = ingestaoMod.criarHandlerWebhook;
  }
} catch (e) {
  try {
    const webhookMod = await import('./lib/ingestao/webhook.mjs');
    if (typeof webhookMod.criarHandlerWebhook === 'function') {
      criarHandlerWebhook = webhookMod.criarHandlerWebhook;
    }
  } catch (e2) {
    console.warn('[Balde] Módulo lib/ingestao não encontrado, webhook indisponível.');
  }
}

// ─── Handler Webhook ─────────────────────────────────────────────────────────
const processarComMotor = async (msg) => {
  try {
    const motorStore = obterStorePadrao();
    return await processar(msg, motorStore);
  } catch (err) {
    console.error('[Balde] Erro no processamento do motor:', err);
  }
};

// ─── Criação da aplicação HTTP ───────────────────────────────────────────────
export function criarServidor({ host } = {}) {
  const webhookToken = process.env.BALDE_WEBHOOK_TOKEN;

  const webhookHandler = criarHandlerWebhook
    ? criarHandlerWebhook({
        enriquecer,
        processar: processarComMotor,
        store,
        token: webhookToken,
      })
    : null;

  const apiHandler = criarApi({ store, ...(host ? { host } : {}) });
  const rotaLeitura = criarRotaLeitura({ ...(host ? { host } : {}) });

  return http.createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    let pathname = '/';
    try {
      const u = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
      pathname = u.pathname;
    } catch {
      pathname = rawUrl.split('?')[0];
    }

    // 1. Rota de webhook (/webhook/:provedor ou /webhook)
    if (pathname.startsWith('/webhook')) {
      if (webhookHandler) {
        return webhookHandler(req, res);
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erro: 'Handler de webhook não configurado' }));
      return;
    }

    // 2. Leitura manual e custo (GB-44)
    if (ROTAS_LEITURA.includes(pathname)) {
      return rotaLeitura(req, res);
    }

    // 3. Rotas de API e Painel estático (gerenciadas por criarApi)
    if (apiHandler) {
      return apiHandler(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Não encontrado');
  });
}

/**
 * Inicia o servidor HTTP na porta e host especificados.
 * @param {Object} [opcoes]
 * @param {number} [opcoes.porta]
 * @param {string} [opcoes.host]
 * @returns {Promise<http.Server>}
 */
export async function iniciarServidor(opcoes = {}) {
  garantirDiretorios();

  const porta = Number(opcoes.porta ?? process.env.BALDE_PORT ?? 7391);
  const host = opcoes.host ?? process.env.BALDE_HOST ?? '127.0.0.1';

  // Iniciar ingestão por WebSocket/Polling
  let evolutionFn = null;
  try {
    const evo = await import('./lib/ingestao/evolution.mjs');
    if (evo.iniciarEvolution) evolutionFn = evo.iniciarEvolution;
  } catch (e) {}
  
  if (evolutionFn && evolutionLigada(opcoes)) {
    evolutionFn({
      enriquecer,
      processar: processarComMotor,
      store
    }).catch(err => console.error('[Balde] Erro iniciarEvolution:', err));
  } else if (evolutionFn) {
    console.log('[Balde] Leitura manual: use "Ler agora" no painel (POST /api/ler) ou node bin/ler.mjs. BALDE_LEITURA=auto liga a leitura contínua.');
  }

  const servidor = criarServidor({ host });

  // Serviços de fundo: só fora de `node --test` (testes nunca tocam GRUPOS.md real nem a Evolution).
  const emTeste = Boolean(process.env.NODE_TEST_CONTEXT);
  const dadosDir = process.env.BALDE_DADOS || join(__dirname, 'dados');
  const paradas = [];
  if (!emTeste && opcoes.servicos !== false) {
    const watcher = iniciarWatcher();
    paradas.push(() => watcher.close());

    const destinosPath = process.env.BALDE_DESTINOS || join(__dirname, 'DESTINOS.md');
    try {
      const { iniciarDistribuidor } = await import('./lib/distribuidor.mjs');
      const dist = await iniciarDistribuidor({ dadosDir, destinosPath });
      paradas.push(() => dist.parar());
    } catch (e) {
      console.warn('[Balde] Distribuidor não iniciado:', e.message);
    }
    try {
      const { iniciarNotificador } = await import('./lib/notificador.mjs');
      const notif = iniciarNotificador({ dadosDir });
      paradas.push(() => notif.parar());
    } catch (e) {
      console.warn('[Balde] Notificador não iniciado:', e.message);
    }
  }

  return new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(porta, host, () => {
      const addr = servidor.address();
      const realPort = typeof addr === 'object' && addr ? addr.port : porta;
      console.log(`[Balde] Servidor rodando em http://${host}:${realPort}`);
      console.log(`[Balde]  - Painel: http://${host}:${realPort}/`);
      console.log(`[Balde]  - Webhooks: http://${host}:${realPort}/webhook/:provedor`);
      console.log(`[Balde]  - API Tarefas: http://${host}:${realPort}/api/tarefas`);
      
      const originalClose = servidor.close.bind(servidor);
      servidor.close = async (cb) => {
          let stopFn = null;
          try {
             const evo = await import('./lib/ingestao/evolution.mjs');
             if (evo.pararEvolution) stopFn = evo.pararEvolution;
          } catch(e) {}
          if (stopFn) stopFn();
          for (const parar of paradas) { try { await parar(); } catch {} }
          return originalClose(cb);
      };
      resolve(servidor);
    });
  });
}

// Execução direta via CLI (ex: node server.mjs ou npm run dev)
const isMain = process.argv[1] && process.argv[1].endsWith('server.mjs');

if (isMain || process.env.BALDE_EVOLUTION === '1') { carregarEnvLocal(); }

if (isMain) {
  iniciarServidor().catch(err => {
    console.error('[Balde] Falha ao iniciar servidor:', err);
    process.exit(1);
  });
}
