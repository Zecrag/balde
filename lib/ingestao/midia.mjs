import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const getBaseDados = () => process.env.BALDE_DADOS || path.resolve(__dirname, '../../dados');
const getMidiaDir = () => path.join(getBaseDados(), 'midia');

const MIME_EXT_MAP = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const MIDIA_TETO_BYTES = 25 * 1024 * 1024;
const MIDIA_TIMEOUT_MS = 20_000;

/**
 * Só baixa mídia de hosts do WhatsApp/Meta ou da própria Evolution (BALDE_EVOLUTION_URL).
 * Evita que um payload aponte o servidor para a rede interna (SSRF).
 * @param {string} url
 * @returns {boolean}
 */
export function hostMidiaPermitido(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'whatsapp.net' || host.endsWith('.whatsapp.net')) return true;
  if (host === 'lookaside.fbsbx.com') return true;
  const evo = process.env.BALDE_EVOLUTION_URL;
  if (evo) {
    try {
      if (new URL(evo).host.toLowerCase() === u.host.toLowerCase()) return true;
    } catch {}
  }
  return false;
}

/** Lê o corpo até o teto; acima disso aborta (null). */
async function lerCorpoLimitado(res, teto) {
  const declarado = Number(res.headers.get('content-length'));
  if (declarado && declarado > teto) return null;
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const partes = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > teto) return null;
    partes.push(chunk);
  }
  return Buffer.concat(partes);
}

function extrairExtensao(mimetype, fileName) {
  if (mimetype) {
    const limpo = mimetype.toLowerCase().split(';')[0].trim();
    if (MIME_EXT_MAP[limpo]) return MIME_EXT_MAP[limpo];
    if (MIME_EXT_MAP[mimetype.toLowerCase().trim()]) return MIME_EXT_MAP[mimetype.toLowerCase().trim()];
  }
  if (fileName) {
    const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
    if (ext) return ext;
  }
  return 'bin';
}

/**
 * Mídia decifrada pela Evolution (POST /chat/getBase64FromMediaMessage/{instancia}).
 * O `url` do payload aponta pro CDN do WhatsApp, que serve o arquivo criptografado
 * com o mediaKey — só a Evolution (que tem a sessão) devolve os bytes reais.
 * @param {string} keyId — key.id da mensagem
 * @param {{ env?: NodeJS.ProcessEnv, fetch?: typeof fetch }} [deps]
 * @returns {Promise<Buffer|null>} null sem Evolution configurada ou em falha
 */
export async function baixarMidiaEvolution(keyId, { env = process.env, fetch: f = globalThis.fetch } = {}) {
  const url = String(env.BALDE_EVOLUTION_URL ?? '').replace(/\/+$/, '');
  const key = env.BALDE_EVOLUTION_KEY;
  const inst = env.BALDE_EVOLUTION_INSTANCIA;
  if (!keyId || !url || !key || !inst) return null;
  try {
    const res = await f(`${url}/chat/getBase64FromMediaMessage/${encodeURIComponent(inst)}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { key: { id: keyId } }, convertToMp4: false }),
      signal: AbortSignal.timeout(MIDIA_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[ingestao/midia] Evolution não decifrou a mídia ${keyId}: HTTP ${res.status}`);
      return null;
    }
    const dados = await res.json();
    if (typeof dados?.base64 !== 'string' || !dados.base64) return null;
    const buf = Buffer.from(dados.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length || buf.length > MIDIA_TETO_BYTES) return null;
    return buf;
  } catch (err) {
    console.warn(`[ingestao/midia] Falha ao decifrar mídia ${keyId} na Evolution:`, err.message);
    return null;
  }
}

/**
 * Salva mídia em disco a partir de base64 ou URL.
 * @param {Object} params
 * @param {string} params.id
 * @param {string} [params.base64]
 * @param {string} [params.url]
 * @param {string} [params.mimetype]
 * @param {string} [params.fileName]
 * @param {string} [params.midiaDir]
 * @param {string} [params.evolutionId]   — key.id: decifra pela Evolution antes de tentar a URL
 * @param {boolean} [params.criptografada] — tem mediaKey: o arquivo do CDN do WhatsApp é .enc
 * @param {{ env?: NodeJS.ProcessEnv, fetch?: typeof fetch }} [params.deps]
 * @returns {Promise<string|null>} Caminho salvo do arquivo ou null
 */
export async function salvarMidia({ id, base64, url, mimetype, fileName, midiaDir, evolutionId, criptografada, deps }) {
  if (!base64 && !url && !evolutionId) return null;

  const targetDir = midiaDir || process.env.BALDE_MIDIA_DIR || getMidiaDir();
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const ext = extrairExtensao(mimetype, fileName);
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeId}.${ext}`;
  const filePath = path.join(targetDir, filename);

  // 1. Prioriza base64 direto (sem requisição de rede)
  if (base64) {
    try {
      // Remove prefixos do tipo data:*/*;base64, se houver
      const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(cleanBase64, 'base64');
      await fs.promises.writeFile(filePath, buf);
      return filePath;
    } catch (err) {
      console.warn(`[ingestao/midia] Falha ao gravar base64 para ${id}:`, err.message);
    }
  }

  // 2. Evolution decifra a mídia do WhatsApp
  if (evolutionId) {
    const buf = await baixarMidiaEvolution(evolutionId, deps);
    if (buf) {
      await fs.promises.writeFile(filePath, buf);
      return filePath;
    }
  }

  // Criptografada no CDN do WhatsApp: baixar dá bytes ilegíveis (viraria 400 no LLM)
  if (criptografada && url && /^https?:\/\/([^/]+\.)?whatsapp\.net\//i.test(url)) {
    console.warn(`[ingestao/midia] Mídia ${id} só existe criptografada no CDN — não salva`);
    return null;
  }

  // 3. Se houver URL http/https de host permitido, tenta baixar (timeout, teto, sem redirect)
  if (url && typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    if (!hostMidiaPermitido(url)) {
      console.warn(`[ingestao/midia] Host de mídia não permitido para ${id}: ${url.slice(0, 120)}`);
      return null;
    }
    try {
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(MIDIA_TIMEOUT_MS) });
      if (res.ok) {
        const buf = await lerCorpoLimitado(res, MIDIA_TETO_BYTES);
        if (!buf) {
          console.warn(`[ingestao/midia] Mídia acima de ${MIDIA_TETO_BYTES} bytes descartada para ${id}`);
          return null;
        }
        await fs.promises.writeFile(filePath, buf);
        return filePath;
      }
    } catch (err) {
      console.warn(`[ingestao/midia] Falha ao baixar URL ${url} para ${id}:`, err.message);
    }
  }

  return null;
}
