/**
 * @file store.mjs — Store unificado do Balde.
 *
 * Duas interfaces sobre o mesmo código:
 *   1. criarStore(raiz) → objeto com métodos síncronos (usado pelo motor)
 *   2. Funções soltas async → usam um store padrão sobre balde/dados (usadas pela API e ingestão)
 *
 * O motor chama store.lerTarefas(), store.upsertTarefa(), etc.
 * A API chama listarTarefas(), atualizarTarefa(), etc.
 * Ambos operam sobre os mesmos arquivos.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerCache } from './midia/cache.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const RAIZ_PADRAO = join(__dir, '..');

// ─── Helpers síncronos (motor) ──────────────────────────────────

function lerJSON(caminho, fallback = null) {
  try {
    return JSON.parse(readFileSync(caminho, 'utf-8'));
  } catch {
    return fallback;
  }
}

function salvarJSON(caminho, dados) {
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, JSON.stringify(dados, null, 2), 'utf-8');
}

/**
 * chatId vira nome de arquivo em dados/contextos/: só caracteres de jid
 * (letras, dígitos, _ @ . + -) e nunca '..' — bloqueia escrita fora de dados/.
 * @param {unknown} chatId
 * @returns {boolean}
 */
export function chatIdValido(chatId) {
  return typeof chatId === 'string' && /^[\w@.+-]+$/.test(chatId) && !chatId.includes('..');
}

// ─── criarStore(raiz) — interface do motor ──────────────────────

/**
 * Cria uma instância de store sobre um diretório raiz.
 * @param {string} raiz — caminho raiz do balde (contém dados/ e config/)
 * @returns {Store}
 */
export function criarStore(raiz) {
  const dadosDir = process.env.BALDE_DADOS || join(raiz, 'dados');
  const configDir = process.env.BALDE_CONFIG || join(raiz, 'config');
  const caminhos = {
    tarefas:   join(dadosDir, 'tarefas.json'),
    contextos: join(dadosDir, 'contextos'),
    clientes:  join(configDir, 'clientes.json'),
    mensagens: join(dadosDir, 'mensagens.jsonl'),
    distribuicao: join(dadosDir, 'fila-distribuicao.jsonl'),
  };

  return {
    // ── Clientes (read-only) ──────────────────────────────────
    lerClientes() {
      return lerJSON(caminhos.clientes, []);
    },

    // ── Tarefas ───────────────────────────────────────────────
    lerTarefas() {
      return lerJSON(caminhos.tarefas, []);
    },

    salvarTarefas(tarefas) {
      salvarJSON(caminhos.tarefas, tarefas);
    },

    /**
     * Upsert: se já existe tarefa com mesmo ID, atualiza.
     * Se não, insere. Retorna a tarefa resultante.
     */
    upsertTarefa(tarefa) {
      const tarefas = this.lerTarefas();
      const idx = tarefas.findIndex(t => t.id === tarefa.id);
      if (idx >= 0) {
        tarefas[idx] = { ...tarefas[idx], ...tarefa, atualizadaEm: new Date().toISOString() };
      } else {
        tarefas.push(tarefa);
      }
      this.salvarTarefas(tarefas);
      return idx >= 0 ? tarefas[idx] : tarefa;
    },

    // ── Contextos ─────────────────────────────────────────────
    lerContexto(chatId) {
      if (!chatIdValido(chatId)) return null;
      const caminho = join(caminhos.contextos, `${chatId}.json`);
      return lerJSON(caminho, null);
    },

    salvarContexto(contexto) {
      if (!chatIdValido(contexto?.chatId)) {
        throw new Error(`chatId inválido para contexto: ${JSON.stringify(String(contexto?.chatId).slice(0, 80))}`);
      }
      const caminho = join(caminhos.contextos, `${contexto.chatId}.json`);
      salvarJSON(caminho, contexto);
    },

    async listarMensagens(chatId) {
      return listarMensagens(chatId);
    },
  };
}

// ─── Store padrão (singleton sobre balde/dados) ─────────────────


// ─── Funções soltas async (API, ingestão) ───────────────────────

function getDadosDir() {
  return process.env.BALDE_DADOS || join(RAIZ_PADRAO, 'dados');
}

function getTarefasPath() {
  return join(getDadosDir(), 'tarefas.json');
}

async function garantirDados() {
  const dir = getDadosDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

/**
 * Lista todas as tarefas.
 * @returns {Promise<import('./tipos.mjs').Tarefa[]>}
 */
export async function listarTarefas() {
  await garantirDados();
  const path = getTarefasPath();
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Obtém uma tarefa pelo id.
 * @param {string} id
 * @returns {Promise<import('./tipos.mjs').Tarefa|null>}
 */
export async function obterTarefa(id) {
  const todas = await listarTarefas();
  return todas.find(t => t.id === id) ?? null;
}

/**
 * Grava o array completo de tarefas.
 * @param {import('./tipos.mjs').Tarefa[]} tarefas
 */
async function salvarTarefasAsync(tarefas) {
  await garantirDados();
  await writeFile(getTarefasPath(), JSON.stringify(tarefas, null, 2), 'utf8');
}

/**
 * Atualiza campos de uma tarefa pelo id. Faz upsert se não existir.
 * @param {string} id
 * @param {Partial<import('./tipos.mjs').Tarefa>} campos
 * @returns {Promise<import('./tipos.mjs').Tarefa>}
 */
export async function atualizarTarefa(id, campos) {
  const todas = await listarTarefas();
  const idx = todas.findIndex(t => t.id === id);
  const agora = new Date().toISOString();
  if (idx === -1) {
    const nova = { id, criadaEm: agora, atualizadaEm: agora, ...campos };
    todas.push(nova);
    await salvarTarefasAsync(todas);
    return nova;
  }
  const atualizada = { ...todas[idx], ...campos, id, atualizadaEm: agora };
  todas[idx] = atualizada;
  await salvarTarefasAsync(todas);
  return atualizada;
}

/**
 * Obtém mensagens de um chatId a partir de mensagens.jsonl.
 * @param {string} chatId
 * @returns {Promise<import('./tipos.mjs').Mensagem[]>}
 */
export async function listarMensagens(chatId) {
  await garantirDados();
  const path = join(getDadosDir(), 'mensagens.jsonl');
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf8');
    const msgs = raw
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .filter(m => !chatId || m.chatId === chatId);

    for (const m of msgs) {
      if ((!m.transcricao || !m.descricaoImagem) && m.midiaPath) {
        try {
          let arq = m.midiaPath;
          if (!existsSync(arq)) {
            arq = join(getDadosDir(), 'midia', basename(m.midiaPath));
          }
          if (existsSync(arq)) {
            const cache = lerCache(arq);
            if (!m.transcricao && cache?.dados?.transcricao) {
              m.transcricao = cache.dados.transcricao;
            }
            if (!m.descricaoImagem && cache?.dados?.descricaoImagem) {
              m.descricaoImagem = cache.dados.descricaoImagem;
            }
          }
        } catch { /* ignora erro de leitura do cache */ }
      }
    }
    return msgs;
  } catch {
    return [];
  }
}

/**
 * Grava uma linha na fila de distribuição.
 * @param {object} entrada
 */
export async function gravarDistribuicao(entrada) {
  await garantirDados();
  const path = join(getDadosDir(), 'fila-distribuicao.jsonl');
  await appendFile(path, JSON.stringify(entrada) + '\n', 'utf8');
}

/**
 * Retorna o store padrão (singleton) para ser passado ao motor.
 * @returns {ReturnType<typeof criarStore>}
 */
export function obterStorePadrao() {
  return criarStore(RAIZ_PADRAO);
}
