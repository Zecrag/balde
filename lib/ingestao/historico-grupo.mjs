/**
 * @file historico-grupo.mjs — Histórico compartilhado ao entrar num grupo.
 *
 * Quando o número do balde entra num grupo, o WhatsApp pode mandar as mensagens
 * recentes num `messageHistoryBundle`: um anexo criptografado (CDN do WhatsApp)
 * com uma lista de WebMessageInfo em protobuf comprimido (zlib). A Evolution guarda
 * só o anexo ("unknown") e o getBase64FromMediaMessage recusa ("not of the media type"),
 * então o balde decifra sozinho:
 *   - mídia do WhatsApp: HKDF-SHA256(mediaKey, info) → iv | chave AES-256-CBC | chave HMAC;
 *     os 10 últimos bytes do .enc são o HMAC truncado de iv+cifrado (conferido).
 *   - info do anexo de histórico: "Group History" (sem o "WhatsApp … Keys" das mídias).
 *   - decoder protobuf mínimo só com os campos que o balde usa (sem dependências).
 * As mídias de dentro do histórico (áudio, imagem, PDF) também só existem no CDN:
 * `prepararMidiaHistorico` baixa e decifra cada uma e põe o base64 no registro,
 * que o normalizar grava em dados/midia como qualquer outra.
 * Só leitura: nada é enviado ao WhatsApp nem à Evolution.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { MIDIA_TETO_BYTES } from './midia.mjs';

const CDN = 'https://mmg.whatsapp.net';
const TIMEOUT_MS = 30_000;

export const INFO_HKDF = Object.freeze({
  historico: 'Group History',
  audio: 'WhatsApp Audio Keys',
  imagem: 'WhatsApp Image Keys',
  documento: 'WhatsApp Document Keys',
  video: 'WhatsApp Video Keys',
});

// ─── Protobuf mínimo ────────────────────────────────────────────

function lerVarint(buf, i) {
  let valor = 0n;
  let desloc = 0n;
  for (;;) {
    if (i >= buf.length) throw new Error('varint truncado');
    const b = buf[i++];
    valor |= BigInt(b & 0x7f) << desloc;
    if (!(b & 0x80)) return [valor, i];
    desloc += 7n;
  }
}

/** Campos de uma mensagem protobuf: Map<número, Array<bigint|Buffer>>. */
export function lerCampos(buf) {
  const campos = new Map();
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = lerVarint(buf, i);
    const num = Number(tag >> 3n);
    const tipo = Number(tag & 7n);
    let valor;
    if (tipo === 0) [valor, i] = lerVarint(buf, i);
    else if (tipo === 2) {
      let tam;
      [tam, i] = lerVarint(buf, i);
      const fim = i + Number(tam);
      if (fim > buf.length) throw new Error('campo truncado');
      valor = buf.subarray(i, fim);
      i = fim;
    } else if (tipo === 1) { valor = buf.subarray(i, i + 8); i += 8; }
    else if (tipo === 5) { valor = buf.subarray(i, i + 4); i += 4; }
    else throw new Error(`wire type ${tipo} não suportado`);
    if (!campos.has(num)) campos.set(num, []);
    campos.get(num).push(valor);
  }
  return campos;
}

const um = (c, n) => c.get(n)?.[0];
const texto = (c, n) => { const v = um(c, n); return Buffer.isBuffer(v) ? v.toString('utf8') : undefined; };
const bytes64 = (c, n) => { const v = um(c, n); return Buffer.isBuffer(v) ? v.toString('base64') : undefined; };
const numero = (c, n) => { const v = um(c, n); return typeof v === 'bigint' ? Number(v) : undefined; };
const sub = (c, n) => { const v = um(c, n); return Buffer.isBuffer(v) ? lerCampos(v) : null; };

/** Campos de mídia → mesmo formato JSON que a Evolution devolve (bytes em base64). */
function midia(c, campos) {
  const obj = { url: texto(c, 1), mimetype: texto(c, 2) };
  for (const [nome, num] of Object.entries(campos)) {
    if (nome === 'seconds') obj[nome] = numero(c, num);
    else if (nome === 'ptt') obj[nome] = numero(c, num) === undefined ? undefined : numero(c, num) === 1;
    else if (/Sha256$|^mediaKey$/.test(nome)) obj[nome] = bytes64(c, num);
    else obj[nome] = texto(c, num);
  }
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Message (proto) → objeto `message` da Evolution, só com o que o balde lê. */
export function decodificarMessage(buf, profundidade = 0) {
  const c = lerCampos(buf);
  // Embrulhos FutureProofMessage: viewOnce, ephemeral, documentWithCaption, edited
  for (const n of [40, 37, 55, 53, 58]) {
    const embrulho = sub(c, n);
    const interno = embrulho && um(embrulho, 1);
    if (Buffer.isBuffer(interno) && profundidade < 3) return decodificarMessage(interno, profundidade + 1);
  }
  if (um(c, 1) !== undefined) return { conversation: texto(c, 1) };
  const ext = sub(c, 6);
  if (ext) return { extendedTextMessage: { text: texto(ext, 1) ?? '' } };
  const img = sub(c, 3);
  if (img) return { imageMessage: midia(img, { caption: 3, fileSha256: 4, mediaKey: 8, fileEncSha256: 9, directPath: 11 }) };
  const aud = sub(c, 8);
  if (aud) return { audioMessage: midia(aud, { fileSha256: 3, seconds: 5, ptt: 6, mediaKey: 7, fileEncSha256: 8, directPath: 9 }) };
  const doc = sub(c, 7);
  if (doc) return { documentMessage: midia(doc, { title: 3, fileSha256: 4, mediaKey: 7, fileName: 8, fileEncSha256: 9, directPath: 10, caption: 20 }) };
  const vid = sub(c, 9);
  if (vid) return { videoMessage: midia(vid, { fileSha256: 3, seconds: 5, mediaKey: 6, caption: 7, fileEncSha256: 11, directPath: 13 }) };
  return {};
}

const rotuloParticipante = jid => (jid ? `Participante …${String(jid).split('@')[0].slice(-4)}` : undefined);

const TIPO_EVOLUTION = {
  conversation: 'conversation', extendedTextMessage: 'extendedTextMessage', imageMessage: 'imageMessage',
  audioMessage: 'audioMessage', documentMessage: 'documentMessage', videoMessage: 'videoMessage',
};

/**
 * Conteúdo (já descomprimido) do anexo de histórico → registros no formato do
 * /chat/findMessages da Evolution. Mensagens sem conteúdo útil (sistema, reação) saem.
 * @param {Buffer} buf
 * @param {string} jidGrupo — fallback quando a chave não traz o remoteJid
 */
export function decodificarHistorico(buf, jidGrupo) {
  const registros = [];
  for (const wmi of lerCampos(buf).get(1) ?? []) {
    if (!Buffer.isBuffer(wmi)) continue;
    try {
      const c = lerCampos(wmi);
      const k = sub(c, 1);
      const id = k && texto(k, 3);
      const ts = numero(c, 3);
      const msgBuf = um(c, 2);
      if (!id || !ts || !Buffer.isBuffer(msgBuf)) continue;
      const message = decodificarMessage(msgBuf);
      const tipo = Object.keys(message)[0];
      if (!tipo) continue;
      registros.push({
        key: { id, remoteJid: texto(k, 1) || jidGrupo, fromMe: numero(k, 2) === 1, participant: texto(k, 4) ?? texto(c, 5) },
        // O histórico não traz o nome: "Eu" para o número do balde, final do número para os outros
        pushName: texto(c, 19) || (numero(k, 2) === 1 ? 'Eu' : rotuloParticipante(texto(k, 4) ?? texto(c, 5))),
        message,
        messageType: TIPO_EVOLUTION[tipo],
        messageTimestamp: ts,
        origemHistorico: true,
      });
    } catch { /* mensagem corrompida: pula */ }
  }
  return registros;
}

// ─── Mídia criptografada do WhatsApp ────────────────────────────

const b64 = v => (Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'base64'));

/**
 * Decifra um .enc do CDN do WhatsApp. Confere o HMAC (e o fileSha256, se vier).
 * @returns {Buffer|null} null se a chave/info não bate
 */
export function decifrarMidiaWhatsApp(enc, mediaKey, info, fileSha256) {
  if (!enc || enc.length < 26) return null;
  const chaves = Buffer.from(crypto.hkdfSync('sha256', b64(mediaKey), Buffer.alloc(0), info, 112));
  const iv = chaves.subarray(0, 16);
  const cifrado = enc.subarray(0, -10);
  const mac = crypto.createHmac('sha256', chaves.subarray(48, 80)).update(Buffer.concat([iv, cifrado])).digest().subarray(0, 10);
  if (!mac.equals(enc.subarray(-10))) return null;
  try {
    const dec = crypto.createDecipheriv('aes-256-cbc', chaves.subarray(16, 48), iv);
    const plano = Buffer.concat([dec.update(cifrado), dec.final()]);
    if (fileSha256 && !crypto.createHash('sha256').update(plano).digest().equals(b64(fileSha256))) return null;
    return plano;
  } catch {
    return null;
  }
}

/** Baixa o .enc do CDN do WhatsApp pelo directPath (nunca outro host). */
export async function baixarCdn(directPath, { fetch: f = globalThis.fetch } = {}) {
  if (typeof directPath !== 'string' || !directPath.startsWith('/')) return null;
  const res = await f(CDN + directPath, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length && buf.length <= MIDIA_TETO_BYTES ? buf : null;
}

/**
 * Registro da Evolution com `messageHistoryBundle` → registros das mensagens de dentro.
 * @returns {Promise<Object[]>} vazio se não for anexo de histórico ou se falhar
 */
export async function expandirHistorico(registro, deps = {}) {
  const anexo = registro?.message?.messageHistoryBundle;
  if (!anexo?.mediaKey || !anexo.directPath) return [];
  const enc = await baixarCdn(anexo.directPath, deps);
  const plano = enc && decifrarMidiaWhatsApp(enc, anexo.mediaKey, INFO_HKDF.historico, anexo.fileSha256);
  if (!plano) return [];
  let conteudo = plano;
  try { conteudo = zlib.inflateSync(plano); } catch { /* já veio sem compressão */ }
  return decodificarHistorico(conteudo, registro.key?.remoteJid);
}

const CAMPO_MIDIA = [
  ['audioMessage', INFO_HKDF.audio],
  ['imageMessage', INFO_HKDF.imagem],
  ['documentMessage', INFO_HKDF.documento],
];

/**
 * Registro vindo do histórico com mídia: baixa e decifra do CDN e põe em `base64`
 * (o normalizar usa o base64 antes de pedir para a Evolution, que não tem essa mídia).
 * Mídia expirada no CDN fica sem arquivo — a mensagem segue só com o texto/legenda.
 */
export async function prepararMidiaHistorico(registro, deps = {}) {
  if (!registro?.origemHistorico) return registro;
  for (const [campo, info] of CAMPO_MIDIA) {
    const m = registro.message?.[campo];
    if (!m?.mediaKey || !m.directPath) continue;
    try {
      const enc = await baixarCdn(m.directPath, deps);
      const plano = enc && decifrarMidiaWhatsApp(enc, m.mediaKey, info, m.fileSha256);
      if (plano) return { ...registro, message: { ...registro.message, [campo]: { ...m, base64: plano.toString('base64') } } };
    } catch { /* CDN fora ou mídia expirada */ }
  }
  return registro;
}
