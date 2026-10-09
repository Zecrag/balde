/**
 * @file balde/lib/midia/audio.mjs
 * Transcrição de áudio via provedor configurado por BALDE_TRANSCRICAO.
 *
 * Provedores suportados:
 *   openai       → API OpenAI Whisper (BALDE_OPENAI_KEY ou OPENAI_API_KEY, a mesma do LLM);
 *                   é o padrão quando BALDE_TRANSCRICAO não está definido e há chave OpenAI
 *   groq         → API Groq Whisper (requer BALDE_GROQ_KEY)
 *   whisper-local → binário `whisper` ou `whisper-cli` no PATH +
 *                   ffmpeg para converter ogg/opus → wav antes
 *
 * Sem provedor configurado ou sem key/binário: retorna null (nunca lança).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { caminhoUso, gastoHojeUSD, limiteDiaUSD, precoTranscricaoMin, registrarUso } from '../llm.mjs';
import { lerCache, gravarCache, hashArquivo } from './cache.mjs';

// ---------- helpers internos ------------------------------------------------

/**
 * Verifica se um binário está disponível no PATH.
 * @param {string} nome
 * @returns {boolean}
 */
function binarioDisponivel(nome) {
  try {
    const resultado = spawnSync('which', [nome], { encoding: 'utf8' });
    return resultado.status === 0 && Boolean(resultado.stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Converte ogg/opus para wav temporário usando ffmpeg.
 * @param {string} origem
 * @returns {string} caminho do wav temporário
 */
function converterParaWav(origem) {
  const destino = `${origem}.${process.pid}.wav`;
  const r = spawnSync('ffmpeg', ['-y', '-i', origem, destino], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg falhou: ${r.stderr}`);
  return destino;
}

/**
 * Determina se o arquivo precisa ser convertido (ogg/opus/oga).
 * @param {string} arquivo
 * @returns {boolean}
 */
function precisaConverter(arquivo) {
  return /\.(ogg|opus|oga)$/i.test(arquivo);
}

// ---------- provedores -------------------------------------------------------

/**
 * Transcrição via OpenAI Whisper API.
 * @param {string} arquivo
 * @returns {Promise<string|null>}
 */
async function transcreverOpenAI(arquivo) {
  const key = chaveOpenAI();
  if (!key) return null;

  // node:http nativo — sem dependências npm
  const { default: https } = await import('node:https');
  const boundary = `----BaldeBoundary${Date.now()}`;
  const ext = path.extname(arquivo).slice(1) || 'ogg';
  const dadosArquivo = fs.readFileSync(arquivo);
  const nome = path.basename(arquivo);

  const corpo = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: audio/${ext}\r\n\r\n`),
    dadosArquivo,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': corpo.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            resolve(json.text ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(corpo);
    req.end();
  });
}

/**
 * Transcrição via Groq Whisper API.
 * @param {string} arquivo
 * @returns {Promise<string|null>}
 */
async function transcreverGroq(arquivo) {
  const key = process.env.BALDE_GROQ_KEY;
  if (!key) return null;

  const { default: https } = await import('node:https');
  const boundary = `----BaldeBoundaryGroq${Date.now()}`;
  const ext = path.extname(arquivo).slice(1) || 'ogg';
  const dadosArquivo = fs.readFileSync(arquivo);
  const nome = path.basename(arquivo);

  const corpo = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${nome}"\r\nContent-Type: audio/${ext}\r\n\r\n`),
    dadosArquivo,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': corpo.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            resolve(json.text ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(corpo);
    req.end();
  });
}

/**
 * Transcrição via binário local `whisper` ou `whisper-cli`.
 * Converte ogg/opus para wav com ffmpeg quando necessário.
 * @param {string} arquivo
 * @returns {Promise<string|null>}
 */
async function transcreverWhisperLocal(arquivo) {
  const bin = binarioDisponivel('whisper') ? 'whisper'
    : binarioDisponivel('whisper-cli') ? 'whisper-cli'
    : null;
  if (!bin) return null;

  let entrada = arquivo;
  let tmpWav = null;

  try {
    if (precisaConverter(arquivo)) {
      if (!binarioDisponivel('ffmpeg')) return null;
      tmpWav = converterParaWav(arquivo);
      entrada = tmpWav;
    }

    // whisper grava arquivos de saída; usamos --output_format txt e --output_dir /tmp
    const tmpDir = '/tmp';
    const baseName = path.basename(entrada, path.extname(entrada));
    const r = spawnSync(
      bin,
      [entrada, '--output_format', 'txt', '--output_dir', tmpDir],
      { encoding: 'utf8', timeout: 300_000 },
    );

    const txtPath = path.join(tmpDir, `${baseName}.txt`);
    if (fs.existsSync(txtPath)) {
      const texto = fs.readFileSync(txtPath, 'utf8').trim();
      try { fs.unlinkSync(txtPath); } catch { /* ignora */ }
      return texto || null;
    }

    // Algumas versões do whisper-cli imprimem o texto em stdout
    const saida = (r.stdout ?? '').trim();
    return saida || null;
  } catch {
    return null;
  } finally {
    if (tmpWav) {
      try { fs.unlinkSync(tmpWav); } catch { /* ignora */ }
    }
  }
}

const chaveOpenAI = (env = process.env) => env.BALDE_OPENAI_KEY || env.OPENAI_API_KEY || '';

/** BALDE_TRANSCRICAO explícito; sem ele, OpenAI se houver chave (a do LLM serve). */
export function provedorTranscricao(env = process.env) {
  const explicito = (env.BALDE_TRANSCRICAO ?? '').trim().toLowerCase();
  if (explicito) return explicito;
  return chaveOpenAI(env) ? 'openai' : '';
}

// ---------- exportação pública -----------------------------------------------

/**
 * Tenta transcrever o arquivo de áudio usando o provedor configurado em
 * `BALDE_TRANSCRICAO`. Nunca lança — retorna null em caso de falha.
 * @param {string} arquivo - Caminho absoluto do arquivo de áudio.
 * @returns {Promise<string|null>}
 */
export async function transcrever(arquivo) {
  const provedor = provedorTranscricao();
  try {
    if (provedor === 'openai') return await transcreverOpenAI(arquivo);
    if (provedor === 'groq') return await transcreverGroq(arquivo);
    if (provedor === 'whisper-local') return await transcreverWhisperLocal(arquivo);
  } catch {
    // nunca propaga
  }
  return null;
}

// ---------- transcrição barata da leitura manual (GB-44) ---------------------

export const MODELO_TRANSCRICAO_PADRAO = 'gpt-4o-mini-transcribe';
export const AUDIO_MAX_SEG_PADRAO = 300;

/** Binário do whisper local (whisper.cpp primeiro), ou null. */
export function whisperLocal(disponivel = binarioDisponivel, env = process.env) {
  const modelo = env.BALDE_WHISPER_MODELO;
  const cpp = ['whisper-cli', 'whisper-cpp'].find(b => disponivel(b));
  // whisper.cpp precisa do modelo ggml (BALDE_WHISPER_MODELO=/caminho/ggml-base.bin)
  if (cpp && modelo && fs.existsSync(modelo)) return cpp;
  return disponivel('whisper') ? 'whisper' : null;
}

/** whisper.cpp: wav 16 kHz mono → texto em stdout (-nt sem timestamps). */
function transcreverWhisperCpp(bin, arquivo, env = process.env) {
  const wav = `${arquivo}.${process.pid}.16k.wav`;
  try {
    const c = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', arquivo, '-ar', '16000', '-ac', '1', wav], { encoding: 'utf8' });
    if (c.status !== 0) return null;
    const r = spawnSync(bin, ['-m', env.BALDE_WHISPER_MODELO, '-f', wav, '-l', env.BALDE_WHISPER_IDIOMA || 'pt', '-nt'], { encoding: 'utf8', timeout: 600_000 });
    const texto = (r.stdout ?? '').replace(/\s+/g, ' ').trim();
    return r.status === 0 && texto ? texto : null;
  } finally {
    try { fs.unlinkSync(wav); } catch { /* ignora */ }
  }
}

/** Áudio ligado na leitura? Padrão sim; BALDE_LER_AUDIO=0/off desliga. */
export function lerAudioLigado(env = process.env) {
  return !['0', 'false', 'off', 'nao', 'não'].includes(String(env.BALDE_LER_AUDIO ?? '1').trim().toLowerCase());
}

export function audioMaxSeg(env = process.env) {
  const n = Number(env.BALDE_AUDIO_MAX_SEG);
  return Number.isFinite(n) && n > 0 ? n : AUDIO_MAX_SEG_PADRAO;
}

/** Duração em segundos: o que o WhatsApp informou, senão ffprobe; null se não souber. */
export function duracaoAudio(mensagem, { ffprobe = binarioDisponivel('ffprobe') } = {}) {
  const raw = mensagem?.raw?.data?.message?.audioMessage?.seconds ?? mensagem?.raw?.message?.audioMessage?.seconds ?? mensagem?.segundos;
  if (Number(raw) > 0) return Number(raw);
  if (!ffprobe || !mensagem?.midiaPath) return null;
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mensagem.midiaPath], { encoding: 'utf8' });
  const n = Number((r.stdout ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Corta os primeiros `seg` segundos com ffmpeg (sem recodificar). Devolve o caminho temporário ou null. */
function cortarAudio(arquivo, seg) {
  if (!binarioDisponivel('ffmpeg')) return null;
  const destino = `${arquivo}.${process.pid}.corte${path.extname(arquivo) || '.ogg'}`;
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', arquivo, '-t', String(seg), '-c', 'copy', destino], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(destino) ? destino : null;
}

/**
 * Transcrição via /v1/audio/transcriptions (OpenAI ou Groq) com fetch injetável.
 * @returns {Promise<string|null>}
 */
async function transcreverApi(arquivo, { modelo, key, url, fetch: f }) {
  const form = new FormData();
  form.append('model', modelo);
  form.append('file', new Blob([fs.readFileSync(arquivo)]), path.basename(arquivo));
  const res = await f(url, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) { console.warn(`[balde] transcrição HTTP ${res.status}`); return null; }
  const json = await res.json().catch(() => null);
  return typeof json?.text === 'string' && json.text.trim() ? json.text.trim() : null;
}

/**
 * Transcreve um áudio da leitura manual, gastando o mínimo:
 *  - cache por hash do arquivo: nunca retranscreve o mesmo áudio;
 *  - whisper local (grátis) quando o binário existe; senão OpenAI/Groq com
 *    BALDE_TRANSCRICAO_MODELO (padrão gpt-4o-mini-transcribe);
 *  - áudio acima de BALDE_AUDIO_MAX_SEG (300s) vai só no começo, marcado `cortado`;
 *  - custo (minutos × preço) vai para uso-llm.jsonl e respeita o teto diário.
 *
 * @param {Object} mensagem — com midiaPath
 * @param {{ env?: object, fetch?: typeof fetch, usoPath?: string|null, local?: string|null, ffprobe?: boolean, uso?: Object }} [opcoes]
 *   uso: campos extras da linha em uso-llm.jsonl (leituraId, empresa, projeto, grupoJid)
 * @returns {Promise<{ transcricao: string|null, cortado?: boolean, custoUSD: number, motivo?: string, provedor?: string }>}
 */
export async function transcreverAudioLeitura(mensagem, opcoes = {}) {
  const env = opcoes.env ?? process.env;
  const arquivo = mensagem?.midiaPath;
  if (!arquivo || !fs.existsSync(arquivo)) return { transcricao: null, custoUSD: 0, motivo: 'sem arquivo' };

  let hash = null;
  try {
    hash = hashArquivo(arquivo);
    const cache = lerCache(arquivo);
    if (cache?.dados?.transcricao) return { transcricao: cache.dados.transcricao, ...(cache.dados.cortado ? { cortado: true } : {}), custoUSD: 0, provedor: 'cache' };
  } catch { /* segue sem cache */ }

  const maxSeg = audioMaxSeg(env);
  const segundos = duracaoAudio(mensagem, { ffprobe: opcoes.ffprobe ?? binarioDisponivel('ffprobe') });
  const longo = segundos !== null && segundos > maxSeg;
  const local = opcoes.local !== undefined ? opcoes.local : whisperLocal(binarioDisponivel, env);
  const explicito = (env.BALDE_TRANSCRICAO ?? '').trim().toLowerCase();

  let entrada = arquivo;
  let tmp = null;
  try {
    if (longo) {
      tmp = cortarAudio(arquivo, maxSeg);
      if (!tmp) return { transcricao: null, custoUSD: 0, motivo: `áudio de ${Math.round(segundos)}s sem ffmpeg para cortar` };
      entrada = tmp;
    }
    const minutos = Math.min(segundos ?? maxSeg, maxSeg) / 60;

    let transcricao = null;
    let custoUSD = 0;
    let provedor;
    if (local && explicito !== 'openai' && explicito !== 'groq') {
      provedor = 'local';
      transcricao = local === 'whisper' ? await transcreverWhisperLocal(entrada) : transcreverWhisperCpp(local, entrada, env);
    } else {
      const groq = explicito === 'groq';
      const key = groq ? env.BALDE_GROQ_KEY : (env.BALDE_OPENAI_KEY || env.OPENAI_API_KEY);
      if (!key || ['off', 'nenhum', '0'].includes(explicito)) return { transcricao: null, custoUSD: 0, motivo: 'sem transcrição configurada' };
      const modelo = env.BALDE_TRANSCRICAO_MODELO?.trim() || (groq ? 'whisper-large-v3-turbo' : MODELO_TRANSCRICAO_PADRAO);
      const usoPath = caminhoUso(opcoes, env);
      const estimativa = minutos * precoTranscricaoMin(modelo, env);
      if (usoPath && gastoHojeUSD(usoPath) + estimativa > limiteDiaUSD(env)) return { transcricao: null, custoUSD: 0, motivo: 'limite do dia atingido' };
      provedor = groq ? 'groq' : 'openai';
      transcricao = await transcreverApi(entrada, {
        modelo, key, fetch: opcoes.fetch ?? globalThis.fetch,
        url: groq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions',
      });
      // A API cobra mesmo quando o texto vem vazio
      custoUSD = estimativa;
      registrarUso(usoPath, {
        ts: new Date().toISOString(), ...(opcoes.uso ?? {}), tipo: 'transcricao', provedor, modelo,
        tokensIn: 0, tokensOut: 0, segundosAudio: Math.round(minutos * 60), custoUSD: Number(custoUSD.toFixed(6)),
      });
    }
    if (transcricao && hash) {
      try { gravarCache(hash, { transcricao, ...(longo ? { cortado: true } : {}) }); } catch { /* cache é bônus */ }
    }
    return { transcricao, ...(longo ? { cortado: true } : {}), custoUSD, provedor };
  } catch (err) {
    return { transcricao: null, custoUSD: 0, motivo: err.message };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignora */ } }
  }
}
