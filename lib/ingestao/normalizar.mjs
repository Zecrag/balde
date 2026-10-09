import crypto from 'node:crypto';
import { salvarMidia } from './midia.mjs';
import { chatIdValido } from '../store.mjs';

/**
 * Detecta o provedor automaticamente a partir da estrutura do payload.
 * @param {Object} payload
 * @returns {'evolution'|'cloud-api'|'baileys'|'encaminhamento-manual'|'desconhecido'}
 */
export function detectarProvedor(payload) {
  if (!payload || typeof payload !== 'object') return 'desconhecido';
  if (payload.object === 'whatsapp_business_account' || Array.isArray(payload.entry)) {
    return 'cloud-api';
  }
  if (
    payload.event === 'messages.upsert' ||
    payload.event === 'MESSAGES_UPSERT' ||
    Boolean(payload.instance && (payload.data?.key || payload.data?.message))
  ) {
    return 'evolution';
  }
  if (payload.key && (payload.message || payload.messageTimestamp !== undefined)) {
    return 'baileys';
  }
  if (
    payload.texto !== undefined &&
    (payload.de !== undefined || payload.chatNome !== undefined || payload.origem === 'encaminhada')
  ) {
    return 'encaminhamento-manual';
  }
  return 'desconhecido';
}

function resolverProvedor(payload, provedor) {
  const p = (!provedor || provedor === 'auto') ? detectarProvedor(payload) : String(provedor).toLowerCase();
  if (['evolution', 'evolution-api', 'messages.upsert'].includes(p)) return 'evolution';
  if (['cloud-api', 'meta', 'whatsapp-cloud-api'].includes(p)) return 'cloud-api';
  if (['baileys', 'baileys-json'].includes(p)) return 'baileys';
  if (['encaminhamento-manual', 'manual'].includes(p)) return 'encaminhamento-manual';
  const auto = detectarProvedor(payload);
  return auto === 'desconhecido' ? 'encaminhamento-manual' : auto;
}

/**
 * Identifica o chat de um payload cru SEM normalizar (nada é baixado nem gravado).
 * Usado pelo webhook para filtrar grupos não autorizados antes de qualquer custo.
 * @returns {{ provedor: string, chatId: string, grupo: boolean, grupoJid: string|null }}
 */
export function identificarChat(rawPayload, provedor) {
  const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload || {});
  const prov = resolverProvedor(payload, provedor);

  if (prov === 'evolution' || prov === 'baileys') {
    const data = prov === 'baileys' ? payload : (Array.isArray(payload.data) ? payload.data[0] : payload.data || payload);
    const chatId = data?.key?.remoteJid || (prov === 'evolution' ? data?.chatId : '') || '';
    const grupo = chatId.endsWith('@g.us') || Boolean(data?.isGroup || data?.groupInfo);
    return { provedor: prov, chatId, grupo, grupoJid: grupo ? chatId : null };
  }
  if (prov === 'cloud-api') {
    const value = payload.entry?.[0]?.changes?.[0]?.value || payload;
    const message = value.messages?.[0] || {};
    const chatId = message.from || value.contacts?.[0]?.wa_id || '';
    const grupoId = message.group_id || value.group_id || null;
    const grupo = Boolean(value.is_group || grupoId || (message.from && message.from.includes('-')));
    return { provedor: prov, chatId, grupo, grupoJid: grupo ? (grupoId || chatId) : null };
  }
  return { provedor: prov, chatId: payload.chatId || 'manual', grupo: false, grupoJid: null };
}

function parseTimestamp(ts) {
  if (!ts) return new Date().toISOString();
  if (typeof ts === 'string') {
    const num = Number(ts);
    if (!Number.isNaN(num)) {
      const ms = num < 1e11 ? num * 1000 : num;
      return new Date(ms).toISOString();
    }
    const d = new Date(ts);
    return !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
  }
  if (typeof ts === 'number') {
    const ms = ts < 1e11 ? ts * 1000 : ts;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Normaliza mensagens do Evolution API (messages.upsert).
 */
async function normalizarEvolution(payload, options) {
  const data = Array.isArray(payload.data) ? payload.data[0] : payload.data || payload;
  const key = data.key || {};
  const message = data.message || {};

  const id = key.id || crypto.randomUUID();
  const chatId = key.remoteJid || data.chatId || '';

  const isForwarded = Boolean(
    data.isForwarded ||
    message.contextInfo?.isForwarded ||
    key.isForwarded ||
    data.forwarded
  );

  let origem = 'pessoal';
  if (isForwarded) {
    origem = 'encaminhada';
  } else if (chatId.endsWith('@g.us') || data.isGroup || data.groupInfo) {
    origem = 'grupo';
  }

  const chatNome =
    data.groupInfo?.subject ||
    data.groupInfo?.name ||
    data.chatName ||
    data.chat?.name ||
    data.group?.subject ||
    (origem === 'grupo' ? chatId : data.pushName || chatId || 'Pessoal');

  const autor = data.pushName || key.participant || key.remoteJid || 'Desconhecido';
  const ts = parseTimestamp(data.messageTimestamp);

  let tipo = 'texto';
  let texto = '';
  let midiaInfo = null;

  if (message.audioMessage || data.messageType === 'audioMessage' || data.messageType === 'voiceMessage') {
    tipo = 'audio';
    const aud = message.audioMessage || {};
    texto = message.conversation || '';
    midiaInfo = {
      base64: aud.base64 || data.base64,
      url: aud.url || data.url,
      mimetype: aud.mimetype || 'audio/ogg',
      fileName: aud.fileName || `${id}.ogg`,
    };
  } else if (message.documentMessage || data.messageType === 'documentMessage') {
    const doc = message.documentMessage || {};
    const mimetype = doc.mimetype || '';
    const fileName = doc.fileName || doc.title || '';
    if (mimetype.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) {
      tipo = 'pdf';
    } else {
      tipo = 'outro';
    }
    texto = doc.caption || doc.title || '';
    midiaInfo = {
      base64: doc.base64 || data.base64,
      url: doc.url || data.url,
      mimetype: mimetype || 'application/pdf',
      fileName,
    };
  } else if (message.imageMessage || data.messageType === 'imageMessage') {
    tipo = 'imagem';
    const img = message.imageMessage || {};
    texto = img.caption || '';
    midiaInfo = {
      base64: img.base64 || data.base64,
      url: img.url || data.url,
      mimetype: img.mimetype || 'image/jpeg',
      fileName: img.fileName || `${id}.jpg`,
    };
  } else if (message.conversation) {
    tipo = 'texto';
    texto = message.conversation;
  } else if (message.extendedTextMessage) {
    tipo = 'texto';
    texto = message.extendedTextMessage.text || message.extendedTextMessage.description || '';
  } else if (data.body) {
    tipo = 'texto';
    texto = data.body;
  } else {
    tipo = 'outro';
  }

  let midiaPath;
  if (midiaInfo) {
    // O url do payload é o CDN do WhatsApp (criptografado): a Evolution decifra pelo key.id
    const bruto = message.audioMessage || message.documentMessage || message.imageMessage || {};
    if (key.id) midiaInfo.evolutionId = key.id;
    midiaInfo.criptografada = Boolean(bruto.mediaKey);
  }
  if (midiaInfo && (midiaInfo.base64 || midiaInfo.url || midiaInfo.evolutionId)) {
    const saved = await salvarMidia({
      id,
      ...midiaInfo,
      midiaDir: options.midiaDir,
      deps: options.midiaDeps,
    });
    if (saved) midiaPath = saved;
  }

  return {
    id,
    chatId,
    chatNome,
    origem,
    autor,
    ts,
    tipo,
    texto,
    ...(midiaPath ? { midiaPath } : {}),
    raw: payload,
  };
}

/**
 * Normaliza mensagens do WhatsApp Cloud API (Meta Webhook).
 */
async function normalizarCloudApi(payload, options) {
  const value = payload.entry?.[0]?.changes?.[0]?.value || payload;
  const contact = value.contacts?.[0] || {};
  const message = value.messages?.[0] || {};

  const id = message.id || crypto.randomUUID();
  const chatId = message.from || contact.wa_id || '';

  const isForwarded = Boolean(message.context?.forwarded || message.forwarded);
  const isGroup = Boolean(value.is_group || value.group_id || message.group_id || (message.from && message.from.includes('-')));

  let origem = 'pessoal';
  if (isForwarded) {
    origem = 'encaminhada';
  } else if (isGroup) {
    origem = 'grupo';
  }

  const chatNome =
    value.chat_name ||
    value.group?.name ||
    value.group_info?.subject ||
    contact.profile?.name ||
    message.from ||
    'WhatsApp';

  const autor = contact.profile?.name || message.from || 'Desconhecido';
  const ts = parseTimestamp(message.timestamp);

  let tipo = 'texto';
  let texto = '';
  let midiaInfo = null;

  if (message.type === 'text') {
    tipo = 'texto';
    texto = message.text?.body || '';
  } else if (message.type === 'audio') {
    tipo = 'audio';
    const aud = message.audio || {};
    midiaInfo = {
      base64: aud.base64,
      url: aud.url || aud.link,
      mimetype: aud.mime_type || 'audio/ogg',
      fileName: `${id}.ogg`,
    };
  } else if (message.type === 'document') {
    const doc = message.document || {};
    const mimetype = doc.mime_type || '';
    const fileName = doc.filename || '';
    if (mimetype.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) {
      tipo = 'pdf';
    } else {
      tipo = 'outro';
    }
    texto = doc.caption || fileName || '';
    midiaInfo = {
      base64: doc.base64,
      url: doc.url || doc.link,
      mimetype: mimetype || 'application/pdf',
      fileName,
    };
  } else if (message.type === 'image') {
    tipo = 'imagem';
    const img = message.image || {};
    texto = img.caption || '';
    midiaInfo = {
      base64: img.base64,
      url: img.url || img.link,
      mimetype: img.mime_type || 'image/jpeg',
      fileName: `${id}.jpg`,
    };
  } else {
    tipo = 'outro';
  }

  let midiaPath;
  if (midiaInfo && (midiaInfo.base64 || midiaInfo.url)) {
    const saved = await salvarMidia({
      id,
      ...midiaInfo,
      midiaDir: options.midiaDir,
    });
    if (saved) midiaPath = saved;
  }

  return {
    id,
    chatId,
    chatNome,
    origem,
    autor,
    ts,
    tipo,
    texto,
    ...(midiaPath ? { midiaPath } : {}),
    raw: payload,
  };
}

/**
 * Normaliza mensagens do Baileys JSON.
 */
async function normalizarBaileys(payload, options) {
  const key = payload.key || {};
  const message = payload.message || {};

  const id = key.id || crypto.randomUUID();
  const chatId = key.remoteJid || '';

  const isForwarded = Boolean(message.contextInfo?.isForwarded || payload.isForwarded);

  let origem = 'pessoal';
  if (isForwarded) {
    origem = 'encaminhada';
  } else if (chatId.endsWith('@g.us') || payload.isGroup) {
    origem = 'grupo';
  }

  const chatNome =
    payload.chatName ||
    payload.groupInfo?.subject ||
    payload.subject ||
    (origem === 'grupo' ? chatId : payload.pushName || chatId || 'Pessoal');

  const autor = payload.pushName || key.participant || key.remoteJid || 'Desconhecido';
  const ts = parseTimestamp(payload.messageTimestamp);

  let tipo = 'texto';
  let texto = '';
  let midiaInfo = null;

  if (message.audioMessage) {
    tipo = 'audio';
    const aud = message.audioMessage;
    midiaInfo = {
      base64: aud.base64,
      url: aud.url,
      mimetype: aud.mimetype || 'audio/ogg',
      fileName: `${id}.ogg`,
    };
  } else if (message.documentMessage) {
    const doc = message.documentMessage;
    const mimetype = doc.mimetype || '';
    const fileName = doc.fileName || doc.title || '';
    if (mimetype.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) {
      tipo = 'pdf';
    } else {
      tipo = 'outro';
    }
    texto = doc.caption || doc.title || '';
    midiaInfo = {
      base64: doc.base64,
      url: doc.url,
      mimetype: mimetype || 'application/pdf',
      fileName,
    };
  } else if (message.imageMessage) {
    tipo = 'imagem';
    const img = message.imageMessage;
    texto = img.caption || '';
    midiaInfo = {
      base64: img.base64,
      url: img.url,
      mimetype: img.mimetype || 'image/jpeg',
      fileName: `${id}.jpg`,
    };
  } else if (message.conversation) {
    tipo = 'texto';
    texto = message.conversation;
  } else if (message.extendedTextMessage) {
    tipo = 'texto';
    texto = message.extendedTextMessage.text || '';
  } else {
    tipo = 'outro';
  }

  let midiaPath;
  if (midiaInfo && (midiaInfo.base64 || midiaInfo.url)) {
    const saved = await salvarMidia({
      id,
      ...midiaInfo,
      midiaDir: options.midiaDir,
    });
    if (saved) midiaPath = saved;
  }

  return {
    id,
    chatId,
    chatNome,
    origem,
    autor,
    ts,
    tipo,
    texto,
    ...(midiaPath ? { midiaPath } : {}),
    raw: payload,
  };
}

/**
 * Normaliza encaminhamento manual ({texto, de, chatNome?}).
 */
async function normalizarManual(payload, options) {
  const id = payload.id || `manual-${crypto.randomUUID()}`;
  const chatId = payload.chatId || 'manual';
  const chatNome = payload.chatNome || 'Encaminhado Pessoal';
  const origem = 'encaminhada';
  const autor = payload.de || payload.autor || 'eu';
  const ts = parseTimestamp(payload.ts);
  const tipo = payload.tipo || 'texto';
  const texto = payload.texto || '';

  let midiaPath;
  const midiaInfo = payload.midia || (payload.base64 || payload.url ? payload : null);
  if (midiaInfo && (midiaInfo.base64 || midiaInfo.url)) {
    const saved = await salvarMidia({
      id,
      base64: midiaInfo.base64,
      url: midiaInfo.url,
      mimetype: midiaInfo.mimetype,
      fileName: midiaInfo.fileName,
      midiaDir: options.midiaDir,
    });
    if (saved) midiaPath = saved;
  }

  return {
    id,
    chatId,
    chatNome,
    origem,
    autor,
    ts,
    tipo,
    texto,
    ...(midiaPath ? { midiaPath } : {}),
    raw: payload,
  };
}

/**
 * Normaliza qualquer payload de WhatsApp para o formato unificado Mensagem.
 * @param {Object|string} rawPayload
 * @param {string} [provedor] 'evolution' | 'cloud-api' | 'baileys' | 'encaminhamento-manual'
 * @param {Object} [options]
 * @param {string} [options.midiaDir]
 * @returns {Promise<import('../tipos.mjs').Mensagem>}
 */
export async function normalizar(rawPayload, provedor, options = {}) {
  const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  // chatId vira nome de arquivo em dados/contextos: rejeita antes de baixar mídia
  const { chatId } = identificarChat(payload, provedor);
  if (chatId && !chatIdValido(chatId)) {
    const err = new Error(`chatId inválido: ${JSON.stringify(String(chatId).slice(0, 80))}`);
    err.code = 'CHATID_INVALIDO';
    throw err;
  }
  const prov = (!provedor || provedor === 'auto') ? detectarProvedor(payload) : provedor.toLowerCase();

  switch (prov) {
    case 'evolution':
    case 'evolution-api':
    case 'messages.upsert':
      return normalizarEvolution(payload, options);

    case 'cloud-api':
    case 'meta':
    case 'whatsapp-cloud-api':
      return normalizarCloudApi(payload, options);

    case 'baileys':
    case 'baileys-json':
      return normalizarBaileys(payload, options);

    case 'encaminhamento-manual':
    case 'manual':
      return normalizarManual(payload, options);

    default:
      // Se não reconheceu o provedor explicitamente, tenta auto-detecção
      const auto = detectarProvedor(payload);
      if (auto !== 'desconhecido' && auto !== prov) {
        return normalizar(payload, auto, options);
      }
      // Fallback gracioso para manual ou genérico
      return normalizarManual(payload, options);
  }
}
