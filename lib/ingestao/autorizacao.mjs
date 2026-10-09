import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Mesma regra de lib/config.mjs: BALDE_CONFIG ou balde/config. */
export function caminhoConfigDir() {
  return process.env.BALDE_CONFIG || path.resolve(__dirname, '../../config');
}

async function lerJson(caminho) {
  try {
    return JSON.parse(await fs.readFile(caminho, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Grupos autorizados = config/grupos.json (gerado do GRUPOS.md).
 * @returns {Promise<Array<{jid: string}>>}
 */
export async function carregarGruposAutorizados() {
  const grupos = await lerJson(path.join(caminhoConfigDir(), 'grupos.json'));
  return Array.isArray(grupos) ? grupos.filter((g) => g && typeof g.jid === 'string') : [];
}

/**
 * Um grupo está autorizado se aparece em config/grupos.json ou na lista
 * `grupos` de algum cliente em config/clientes.json (ambos saem do GRUPOS.md).
 * @param {string} jid
 * @returns {Promise<boolean>}
 */
export async function grupoAutorizado(jid) {
  if (!jid || typeof jid !== 'string') return false;
  const grupos = await carregarGruposAutorizados();
  if (grupos.some((g) => g.jid === jid)) return true;
  const clientes = await lerJson(path.join(caminhoConfigDir(), 'clientes.json'));
  return Array.isArray(clientes) && clientes.some((c) => Array.isArray(c?.grupos) && c.grupos.includes(jid));
}
