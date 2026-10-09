import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Subconjunto dotenv: export, comentários, aspas e valores multilinha.
export function lerAmbiente(dir) {
  let texto;
  try { texto = readFileSync(join(dir, '.env'), 'utf8'); }
  catch (erro) { if (erro.code === 'ENOENT') return {}; throw erro; }
  const env = {};
  const linhas = /(?:^|\n)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\r\n]*))/g;
  for (const match of texto.matchAll(linhas)) {
    env[match[1]] = match[2] !== undefined
      ? match[2].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : match[3] !== undefined ? match[3] : match[4].split('#')[0].trim();
  }
  return env;
}
