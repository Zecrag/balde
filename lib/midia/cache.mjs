/**
 * @file balde/lib/midia/cache.mjs
 * Cache por hash SHA-256 de arquivo em dados/midia/.cache/
 * Funciona mesmo se a pasta dados/ não existir ainda.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Raiz do projeto balde/
const getBaseDados = () => process.env.BALDE_DADOS || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dados');
const getCacheDir = () => path.join(getBaseDados(), 'midia', '.cache');

/**
 * Calcula o hash SHA-256 do arquivo e retorna como hex.
 * @param {string} arquivo - Caminho absoluto do arquivo.
 * @returns {string}
 */
export function hashArquivo(arquivo) {
  const conteudo = fs.readFileSync(arquivo);
  return crypto.createHash('sha256').update(conteudo).digest('hex');
}

/**
 * Retorna o caminho do arquivo de cache para um determinado hash.
 * @param {string} hash
 * @returns {string}
 */
export function caminhoCache(hash) {
  return path.join(getCacheDir(), `${hash}.json`);
}

/**
 * Lê o resultado em cache para um arquivo (por hash).
 * @param {string} arquivo - Caminho absoluto do arquivo.
 * @returns {{ hash: string, dados: any } | null}
 */
export function lerCache(arquivo) {
  let hash;
  try {
    hash = hashArquivo(arquivo);
  } catch {
    return null;
  }
  const arq = caminhoCache(hash);
  try {
    const dados = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return { hash, dados };
  } catch {
    return null;
  }
}

/**
 * Grava o resultado de enriquecimento no cache.
 * @param {string} hash
 * @param {any} dados
 */
export function gravarCache(hash, dados) {
  fs.mkdirSync(getCacheDir(), { recursive: true });
  const arq = caminhoCache(hash);
  const tmp = `${arq}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, arq);
}
