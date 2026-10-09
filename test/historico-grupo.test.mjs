/**
 * historico-grupo.test.mjs — Anexo de histórico do grupo (messageHistoryBundle):
 * protobuf + zlib + mídia criptografada do WhatsApp, montados aqui (CDN mockado).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import {
  decodificarHistorico, decifrarMidiaWhatsApp, expandirHistorico, prepararMidiaHistorico, INFO_HKDF,
} from '../lib/ingestao/historico-grupo.mjs';

const GRUPO = '120363000000000009@g.us';

// ─── Encoder protobuf mínimo (só para o teste) ──────────────────
const varint = n => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const campo = (num, valor) => {
  if (typeof valor === 'number' || typeof valor === 'bigint' || typeof valor === 'boolean') return Buffer.concat([varint((num << 3) | 0), varint(Number(valor))]);
  const buf = Buffer.isBuffer(valor) ? valor : Buffer.from(valor, 'utf8');
  return Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);
};
const msg = (...campos) => Buffer.concat(campos);

/** Cifra como o WhatsApp: HKDF → AES-256-CBC + HMAC truncado em 10 bytes. */
function cifrar(plano, info) {
  const mediaKey = crypto.randomBytes(32);
  const ch = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(0), info, 112));
  const iv = ch.subarray(0, 16);
  const c = crypto.createCipheriv('aes-256-cbc', ch.subarray(16, 48), iv);
  const cifrado = Buffer.concat([c.update(plano), c.final()]);
  const mac = crypto.createHmac('sha256', ch.subarray(48, 80)).update(Buffer.concat([iv, cifrado])).digest().subarray(0, 10);
  return {
    enc: Buffer.concat([cifrado, mac]),
    mediaKey: mediaKey.toString('base64'),
    fileSha256: crypto.createHash('sha256').update(plano).digest().toString('base64'),
  };
}

const AUDIO = Buffer.from('OggS-audio-de-teste');
const audioCifrado = cifrar(AUDIO, INFO_HKDF.audio);

function wmi({ id, ts, fromMe = false, participante = '5511988887777@lid', message }) {
  return msg(
    campo(1, msg(campo(1, GRUPO), campo(2, fromMe ? 1 : 0), campo(3, id), campo(4, participante))),
    campo(2, message),
    campo(3, ts),
  );
}

const HISTORICO = msg(
  campo(1, wmi({ id: 'A1', ts: 1789400000, message: campo(1, 'pedido em texto') })),
  campo(1, wmi({ id: 'A2', ts: 1789400100, fromMe: true, message: campo(6, msg(campo(1, 'resposta estendida'))) })),
  // efêmera embrulhando um áudio
  campo(1, wmi({ id: 'A3', ts: 1789400200, message: campo(40, msg(campo(1, campo(8, msg(
    campo(2, 'audio/ogg; codecs=opus'), campo(3, Buffer.from(audioCifrado.fileSha256, 'base64')), campo(5, 7), campo(6, 1),
    campo(7, Buffer.from(audioCifrado.mediaKey, 'base64')), campo(9, '/v/audio.enc'),
  ))))) })),
  campo(1, wmi({ id: 'A4', ts: 1789400300, message: campo(46, msg(campo(2, '👍'))) })), // reação: sai
);

describe('histórico compartilhado do grupo', () => {
  it('decodifica WebMessageInfo: texto, texto estendido, áudio em efêmera; descarta reação', () => {
    const regs = decodificarHistorico(HISTORICO, GRUPO);
    assert.deepEqual(regs.map(r => r.key.id), ['A1', 'A2', 'A3']);
    assert.equal(regs[0].message.conversation, 'pedido em texto');
    assert.equal(regs[0].messageTimestamp, 1789400000);
    assert.equal(regs[0].pushName, 'Participante …7777');
    assert.equal(regs[1].message.extendedTextMessage.text, 'resposta estendida');
    assert.equal(regs[1].key.fromMe, true);
    assert.equal(regs[1].pushName, 'Eu');
    assert.equal(regs[2].messageType, 'audioMessage');
    assert.equal(regs[2].message.audioMessage.directPath, '/v/audio.enc');
    assert.equal(regs[2].message.audioMessage.seconds, 7);
    assert.equal(regs[2].message.audioMessage.ptt, true);
    assert.ok(regs.every(r => r.key.remoteJid === GRUPO && r.origemHistorico));
  });

  it('decifra mídia do WhatsApp e recusa chave ou info errada', () => {
    const { enc, mediaKey, fileSha256 } = cifrar(Buffer.from('conteudo'), INFO_HKDF.imagem);
    assert.equal(decifrarMidiaWhatsApp(enc, mediaKey, INFO_HKDF.imagem, fileSha256).toString(), 'conteudo');
    assert.equal(decifrarMidiaWhatsApp(enc, mediaKey, INFO_HKDF.audio), null);
    assert.equal(decifrarMidiaWhatsApp(enc, crypto.randomBytes(32).toString('base64'), INFO_HKDF.imagem), null);
  });

  it('expande o anexo (CDN do WhatsApp mockado) e decifra a mídia de dentro', async () => {
    const anexo = cifrar(zlib.deflateSync(HISTORICO), INFO_HKDF.historico);
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      const corpo = url.endsWith('/v/hist.enc') ? anexo.enc : url.endsWith('/v/audio.enc') ? audioCifrado.enc : null;
      return corpo ? new Response(corpo, { status: 200 }) : new Response('', { status: 404 });
    };
    const registro = {
      key: { id: 'BUNDLE', remoteJid: GRUPO },
      message: { messageHistoryBundle: { mediaKey: anexo.mediaKey, fileSha256: anexo.fileSha256, directPath: '/v/hist.enc', mimetype: 'application/protobuf' } },
    };
    const regs = await expandirHistorico(registro, { fetch });
    assert.equal(regs.length, 3);
    assert.equal(urls[0], 'https://mmg.whatsapp.net/v/hist.enc');

    const comMidia = await prepararMidiaHistorico(regs[2], { fetch });
    assert.equal(Buffer.from(comMidia.message.audioMessage.base64, 'base64').toString(), AUDIO.toString());
    // Registro que não veio do histórico passa intacto
    const vivo = { key: { id: 'X' }, message: { audioMessage: { mediaKey: 'x', directPath: '/v/a' } } };
    assert.equal(await prepararMidiaHistorico(vivo, { fetch }), vivo);
    // Mídia expirada no CDN: segue sem base64
    const expirada = await prepararMidiaHistorico({ ...regs[2], message: { audioMessage: { ...regs[2].message.audioMessage, directPath: '/v/sumiu.enc' } } }, { fetch });
    assert.equal(expirada.message.audioMessage.base64, undefined);
  });

  it('registro sem anexo de histórico não expande', async () => {
    assert.deepEqual(await expandirHistorico({ message: { conversation: 'oi' } }), []);
  });
});
