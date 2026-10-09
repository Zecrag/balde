/**
 * @file test/whatsapp-baileys.test.mjs
 *
 * Testes do conector Baileys (GB-37).
 * Todos os testes usam socket mockado — sem rede, sem WhatsApp real.
 *
 * O módulo iniciarBaileys aceita um segundo argumento _deps (injeção de deps)
 * que permite substituir makeWASocket, useMultiFileAuthState, QRCode etc.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { iniciarBaileys } from '../lib/whatsapp/baileys.mjs';

/* ─── Helpers para criar mocks ────────────────────────────────────────────── */

/**
 * Cria um EventEmitter mínimo compatível com o sock.ev do Baileys.
 */
function criarEventEmitter() {
  const handlers = {};
  return {
    on(evento, fn) {
      handlers[evento] = handlers[evento] || [];
      handlers[evento].push(fn);
    },
    emit(evento, dados) {
      for (const fn of handlers[evento] || []) fn(dados);
    },
    _handlers: handlers,
  };
}

/**
 * Cria um socket Baileys mockado.
 * @param {Object} opts
 * @param {string} [opts.userId] — ID do usuário conectado
 * @param {string} [opts.userName] — nome do usuário
 */
function criarSocketMock(opts = {}) {
  const ev = criarEventEmitter();
  return {
    ev,
    user: { id: opts.userId ?? '5511999990001@s.whatsapp.net', name: opts.userName ?? 'Teste' },
    end:  () => {},
    groupFetchAllParticipating: async () => ({}),
    updateMediaMessage: async (msg) => msg,
  };
}

/**
 * Deps mockadas para iniciarBaileys.
 * makeWASocket emite 'connection.update' com connection:'open' imediatamente.
 */
function criarDepsMock(overrides = {}) {
  let socketCriado = null;

  const makeWASocket = overrides.makeWASocket ?? function(cfg) {
    const sock = criarSocketMock();
    socketCriado = sock;
    // Simula conexão aberta no próximo tick
    setImmediate(() => {
      sock.ev.emit('connection.update', { connection: 'open' });
    });
    return sock;
  };

  return {
    makeWASocket,
    useMultiFileAuthState: overrides.useMultiFileAuthState ?? async function() {
      return { state: {}, saveCreds: () => {} };
    },
    DisconnectReason: overrides.DisconnectReason ?? { loggedOut: 401 },
    downloadMediaMessage: overrides.downloadMediaMessage ?? async function() {
      return Buffer.from('audio-mock-bytes');
    },
    fetchLatestBaileysVersion: overrides.fetchLatestBaileysVersion ?? async function() {
      return { version: [2, 3000, 1023509563] };
    },
    isJidGroup: overrides.isJidGroup ?? function(jid) { return jid?.endsWith('@g.us'); },
    QRCode: overrides.QRCode ?? {
      toDataURL: async (str) => `data:image/png;base64,MOCK_QR_${str.slice(0, 10)}`,
    },
    _getSocket: () => socketCriado,
  };
}

/**
 * Aguarda até que uma condição seja verdadeira (polling leve).
 */
function aguardar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ─── Fixture de mensagem Baileys ─────────────────────────────────────────── */

function mensagemTextoFixture(overrides = {}) {
  return {
    key: {
      remoteJid:   '120363098765432100@g.us',
      fromMe:      false,
      id:          'TEST_MSG_001',
      participant: '5511977770001@s.whatsapp.net',
      ...overrides.key,
    },
    messageTimestamp: 1728312300,
    pushName:         'Lucas Gestor',
    message: {
      conversation: 'Alguém pode me passar o link da reunião?',
      ...overrides.message,
    },
    ...overrides,
  };
}

function mensagemAudioFixture() {
  return {
    key: {
      remoteJid:   '120363098765432100@g.us',
      fromMe:      false,
      id:          'TEST_MSG_AUDIO_002',
      participant: '5511977770002@s.whatsapp.net',
    },
    messageTimestamp: 1728312400,
    pushName:         'Ana Paula',
    message: {
      audioMessage: {
        url:      'https://mmg.whatsapp.net/fake.enc',
        mimetype: 'audio/ogg; codecs=opus',
        mediaKey: Buffer.from('mockkey12345678901234567890123456').toString('base64'),
        fileEncSha256: Buffer.from('hash').toString('base64'),
        fileSha256:    Buffer.from('sha').toString('base64'),
        fileLength:    '12345',
      },
    },
  };
}

function mensagemImagemFixture() {
  return {
    key: {
      remoteJid:   '120363098765432100@g.us',
      fromMe:      false,
      id:          'TEST_MSG_IMG_003',
      participant: '5511977770003@s.whatsapp.net',
    },
    messageTimestamp: 1728312500,
    pushName:         'Carlos',
    message: {
      imageMessage: {
        url:      'https://mmg.whatsapp.net/fake-img.enc',
        mimetype: 'image/jpeg',
        caption:  'Segue o print',
        mediaKey: Buffer.from('mockkey12345678901234567890123456').toString('base64'),
      },
    },
  };
}

/* ─── Testes ──────────────────────────────────────────────────────────────── */

test('iniciarBaileys: retorna interface correta (listarGrupos, desconectar, estado)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    const handle = await iniciarBaileys({
      pastaSessao:   tmpDir,
      aoQR:          () => {},
      aoConectar:    () => {},
      aoMensagem:    () => {},
      gruposPermitidos: null,
    }, criarDepsMock());

    assert.equal(typeof handle.listarGrupos, 'function',  'deve ter listarGrupos');
    assert.equal(typeof handle.desconectar,  'function',  'deve ter desconectar');
    assert.equal(typeof handle.estado,       'function',  'deve ter estado');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: estado inicial é aguardando-qr, vira conectado após connection:open', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    const deps = criarDepsMock();
    const handle = await iniciarBaileys({
      pastaSessao: tmpDir,
      aoConectar:  () => {},
      aoMensagem:  () => {},
    }, deps);

    // Inicialmente aguardando-qr (antes do open chegar)
    // Após setImmediate, connection.update dispara com open
    await aguardar(20);
    assert.equal(handle.estado(), 'conectado', 'deve estar conectado após connection:open');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: aoQR é chamado com string e data-URL PNG', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let qrString  = null;
    let qrDataUrl = null;

    const deps = criarDepsMock({
      makeWASocket(cfg) {
        const sock = criarSocketMock();
        setImmediate(() => {
          // Emite QR primeiro, depois open
          sock.ev.emit('connection.update', { qr: 'QR_STRING_FAKE_123' });
          sock.ev.emit('connection.update', { connection: 'open' });
        });
        return sock;
      },
    });

    await iniciarBaileys({
      pastaSessao: tmpDir,
      aoQR: (str, png) => {
        qrString  = str;
        qrDataUrl = png;
      },
      aoConectar: () => {},
      aoMensagem: () => {},
    }, deps);

    await aguardar(30);

    assert.equal(qrString, 'QR_STRING_FAKE_123', 'deve passar a string do QR');
    assert.ok(qrDataUrl?.startsWith('data:image/png;base64,'), 'deve gerar data-URL PNG');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: aoConectar é chamado com info do usuário', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let infoConexao = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock({ userId: '5511999990001@s.whatsapp.net', userName: 'Dono' });
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({
      pastaSessao: tmpDir,
      aoQR:        () => {},
      aoConectar:  (info) => { infoConexao = info; },
      aoMensagem:  () => {},
    }, deps);

    await aguardar(20);

    assert.ok(infoConexao, 'aoConectar deve ter sido chamado');
    assert.equal(infoConexao.telefone, '5511999990001@s.whatsapp.net');
    assert.equal(infoConexao.nome, 'Dono');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: aoMensagem recebe payload de mensagem de texto (formato Baileys JSON)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let payloadRecebido = null;
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({
      pastaSessao:      tmpDir,
      aoMensagem:       (p) => { payloadRecebido = p; },
      gruposPermitidos: null, // todos
    }, deps);

    await aguardar(20);

    // Simula chegada de mensagem de grupo
    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemTextoFixture()],
    });

    await aguardar(20);

    assert.ok(payloadRecebido, 'aoMensagem deve ter sido chamado');
    assert.equal(payloadRecebido.key.id,         'TEST_MSG_001');
    assert.equal(payloadRecebido.key.remoteJid,  '120363098765432100@g.us');
    assert.equal(payloadRecebido.pushName,        'Lucas Gestor');
    assert.equal(payloadRecebido.isGroup,         true);
    assert.ok(payloadRecebido.message?.conversation?.includes('link da reunião'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: mensagem de chat privado é ignorada (só grupos)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let chamado = false;
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({
      pastaSessao: tmpDir,
      aoMensagem:  () => { chamado = true; },
    }, deps);

    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemTextoFixture({ key: { remoteJid: '5511999990001@s.whatsapp.net', fromMe: false, id: 'MSG_PRIVADA' } })],
    });

    await aguardar(20);
    assert.equal(chamado, false, 'mensagem privada não deve acionar aoMensagem');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: mensagem fromMe é ignorada', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let chamado = false;
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({ pastaSessao: tmpDir, aoMensagem: () => { chamado = true; } }, deps);
    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemTextoFixture({ key: { remoteJid: '120363098765432100@g.us', fromMe: true, id: 'MSG_MEU' } })],
    });

    await aguardar(20);
    assert.equal(chamado, false, 'mensagem fromMe não deve acionar aoMensagem');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: filtro gruposPermitidos (função) bloqueia grupo não autorizado', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    const recebidos = [];
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({
      pastaSessao:      tmpDir,
      aoMensagem:       (p) => recebidos.push(p),
      gruposPermitidos: () => ['120363000000000001@g.us'], // só este
    }, deps);

    await aguardar(20);

    // Grupo NÃO permitido
    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemTextoFixture()], // jid: 120363098765432100@g.us
    });

    // Grupo PERMITIDO
    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemTextoFixture({ key: { remoteJid: '120363000000000001@g.us', fromMe: false, id: 'MSG_OK' } })],
    });

    await aguardar(20);

    assert.equal(recebidos.length, 1, 'apenas o grupo permitido deve gerar mensagem');
    assert.equal(recebidos[0].key.remoteJid, '120363000000000001@g.us');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: filtro gruposPermitidos (array) bloqueia grupo não autorizado', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    const recebidos = [];
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({
      pastaSessao:      tmpDir,
      aoMensagem:       (p) => recebidos.push(p),
      gruposPermitidos: ['120363000000000001@g.us'],
    }, deps);

    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [
        mensagemTextoFixture({ key: { remoteJid: '120363098765432100@g.us', fromMe: false, id: 'MSG_NEGADO' } }),
        mensagemTextoFixture({ key: { remoteJid: '120363000000000001@g.us', fromMe: false, id: 'MSG_ACEITO' } }),
      ],
    });

    await aguardar(20);

    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0].key.id, 'MSG_ACEITO');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: payload de áudio chama downloadMediaMessage e inclui base64', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let payloadRecebido = null;
    let sockRef = null;
    let downloadChamado = false;

    const AUDIO_BYTES = Buffer.from('ogg-vorbis-mock-audio');

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
      downloadMediaMessage: async (msg) => {
        downloadChamado = true;
        return AUDIO_BYTES;
      },
    });

    await iniciarBaileys({
      pastaSessao: tmpDir,
      aoMensagem:  (p) => { payloadRecebido = p; },
    }, deps);

    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemAudioFixture()],
    });

    await aguardar(50);

    assert.ok(payloadRecebido, 'deve receber o payload');
    assert.ok(downloadChamado, 'downloadMediaMessage deve ter sido chamado');
    assert.equal(
      payloadRecebido.message.audioMessage.base64,
      AUDIO_BYTES.toString('base64'),
      'base64 do áudio deve estar presente no payload'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: payload de imagem chama downloadMediaMessage e inclui base64', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let payloadRecebido = null;
    let sockRef = null;

    const IMG_BYTES = Buffer.from('fake-jpeg-bytes');

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
      downloadMediaMessage: async () => IMG_BYTES,
    });

    await iniciarBaileys({ pastaSessao: tmpDir, aoMensagem: (p) => { payloadRecebido = p; } }, deps);
    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemImagemFixture()],
    });

    await aguardar(50);

    assert.ok(payloadRecebido);
    assert.equal(
      payloadRecebido.message.imageMessage.base64,
      IMG_BYTES.toString('base64')
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: cache de grupos é atualizado no events groups.upsert', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    const handle = await iniciarBaileys({ pastaSessao: tmpDir, aoMensagem: () => {} }, deps);
    await aguardar(20);

    sockRef.ev.emit('groups.upsert', [{
      id:           '120363098765432100@g.us',
      subject:      'Projeto Alpha',
      participants: [{ id: '5511977770001@s.whatsapp.net' }, { id: '5511977770002@s.whatsapp.net' }],
    }]);

    await aguardar(10);
    const grupos = await handle.listarGrupos();

    assert.equal(grupos.length, 1);
    assert.equal(grupos[0].jid,  '120363098765432100@g.us');
    assert.equal(grupos[0].nome, 'Projeto Alpha');
    assert.equal(grupos[0].participantes.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: chatName e groupInfo são incluídos no payload para o normalizador', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let payloadRecebido = null;
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    const handle = await iniciarBaileys({
      pastaSessao: tmpDir,
      aoMensagem:  (p) => { payloadRecebido = p; },
    }, deps);

    await aguardar(20);

    // Pré-popula cache de grupos
    sockRef.ev.emit('groups.upsert', [{
      id:           '120363098765432100@g.us',
      subject:      'Comunidade VIP',
      participants: [{ id: '5511977770001@s.whatsapp.net' }],
    }]);

    await aguardar(10);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemTextoFixture()],
    });

    await aguardar(20);

    assert.ok(payloadRecebido);
    assert.equal(payloadRecebido.chatName, 'Comunidade VIP', 'chatName deve vir do cache de grupos');
    assert.equal(payloadRecebido.groupInfo?.subject, 'Comunidade VIP');
    assert.ok(Array.isArray(payloadRecebido.groupInfo?.participants));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: desconectar muda estado para desconectado', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    const deps = criarDepsMock();
    const handle = await iniciarBaileys({
      pastaSessao: tmpDir,
      aoMensagem:  () => {},
    }, deps);

    await aguardar(20);
    assert.equal(handle.estado(), 'conectado');

    handle.desconectar();
    assert.equal(handle.estado(), 'desconectado');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: histórico (type !== notify) é ignorado', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let chamado = false;
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({ pastaSessao: tmpDir, aoMensagem: () => { chamado = true; } }, deps);
    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'append', // histórico, não notificação nova
      messages: [mensagemTextoFixture()],
    });

    await aguardar(20);
    assert.equal(chamado, false, 'histórico não deve acionar aoMensagem');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: gruposPermitidos=[] (array vazio) permite todos os grupos', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    const recebidos = [];
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({
      pastaSessao:      tmpDir,
      aoMensagem:       (p) => recebidos.push(p),
      gruposPermitidos: [],
    }, deps);

    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [
        mensagemTextoFixture({ key: { remoteJid: '111111111111@g.us', fromMe: false, id: 'G1' } }),
        mensagemTextoFixture({ key: { remoteJid: '222222222222@g.us', fromMe: false, id: 'G2' } }),
      ],
    });

    await aguardar(20);
    assert.equal(recebidos.length, 2, 'array vazio deve permitir todos os grupos');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: downloadMediaMessage falha graciosamente (sem crash)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let payloadRecebido = null;
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
      downloadMediaMessage: async () => { throw new Error('Erro de rede simulado'); },
    });

    await iniciarBaileys({ pastaSessao: tmpDir, aoMensagem: (p) => { payloadRecebido = p; } }, deps);
    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemAudioFixture()],
    });

    await aguardar(50);

    // Deve receber o payload mesmo sem base64 (falha silenciosa)
    assert.ok(payloadRecebido, 'payload deve chegar mesmo com erro de mídia');
    assert.equal(payloadRecebido.key.id, 'TEST_MSG_AUDIO_002');
    // base64 não deve estar presente se o download falhou
    assert.equal(payloadRecebido.message?.audioMessage?.base64, undefined,
      'base64 não deve ser preenchido se download falhou');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('iniciarBaileys: pasta de sessão é criada se não existir', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-base-'));
  const pastaSessao = path.join(tmpBase, 'whatsapp-sessao');
  try {
    assert.equal(fs.existsSync(pastaSessao), false, 'pasta não deve existir antes');

    await iniciarBaileys({ pastaSessao, aoMensagem: () => {} }, criarDepsMock());

    assert.equal(fs.existsSync(pastaSessao), true, 'pasta deve ter sido criada');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('iniciarBaileys: payload inclui campos obrigatórios para normalizar.mjs (baileys)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-baileys-test-'));
  try {
    let payloadRecebido = null;
    let sockRef = null;

    const deps = criarDepsMock({
      makeWASocket() {
        const sock = criarSocketMock();
        sockRef = sock;
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
      },
    });

    await iniciarBaileys({ pastaSessao: tmpDir, aoMensagem: (p) => { payloadRecebido = p; } }, deps);
    await aguardar(20);

    sockRef.ev.emit('messages.upsert', {
      type:     'notify',
      messages: [mensagemTextoFixture()],
    });

    await aguardar(20);

    // Campos que normalizar.mjs usa para o provedor 'baileys'
    assert.ok(payloadRecebido.key,                        'key obrigatório');
    assert.ok(payloadRecebido.key.remoteJid,              'key.remoteJid obrigatório');
    assert.ok(payloadRecebido.key.id,                     'key.id obrigatório');
    assert.ok(payloadRecebido.message,                    'message obrigatório');
    assert.ok(payloadRecebido.messageTimestamp,            'messageTimestamp obrigatório');
    assert.equal(typeof payloadRecebido.pushName, 'string', 'pushName deve ser string');
    assert.equal(payloadRecebido.isGroup, true,            'isGroup deve ser true');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
