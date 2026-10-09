import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Cursor do catch-up da Evolution, por grupo:
 *   { "<jid>@g.us": { "ts": <messageTimestamp em segundos>, "ids": ["<key.id>", ...] } }
 * `ids` guarda as mensagens já processadas exatamente no segundo `ts`, para que
 * duas mensagens no mesmo segundo não se percam nem sejam reprocessadas.
 */

/** messageTimestamp da Evolution → segundos (aceita número, string, Long {low} e ms). */
export function tsSegundos(valor) {
  const bruto = valor && typeof valor === 'object' ? valor.low : valor;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n >= 1e11 ? n / 1000 : n);
}

export async function lerCursor(caminho) {
  try {
    const dados = JSON.parse(await fs.readFile(caminho, 'utf8'));
    return dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : {};
  } catch {
    return {};
  }
}

/** Gravação atômica (tmp + rename) para um desligamento no meio não corromper o cursor. */
export async function gravarCursor(caminho, cursor) {
  await fs.mkdir(path.dirname(caminho), { recursive: true });
  const tmp = `${caminho}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cursor, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, caminho);
}

/** A mensagem (ts, id) ainda não passou pelo cursor do grupo? */
export function depoisDoCursor(entrada, ts, id) {
  if (!entrada) return true;
  if (ts > entrada.ts) return true;
  return ts === entrada.ts && !(entrada.ids || []).includes(id);
}

/** Avança o cursor do grupo para a mensagem (ts, id) — nunca recua. */
export function avancarCursor(cursor, jid, ts, id) {
  const atual = cursor[jid];
  if (!atual || ts > atual.ts) cursor[jid] = { ts, ids: id ? [id] : [] };
  else if (ts === atual.ts && id && !(atual.ids ||= []).includes(id)) atual.ids.push(id);
}
