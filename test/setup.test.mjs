import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarSetup } from '../lib/setup.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('criarSetup - injeta conectores, valida origem/host, configura chave e url', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-setup-test-'));
    
    // Mock do global fetch via conectores.fetch
    let fetchCalls = [];
    const mockFetch = async (url, options) => {
        fetchCalls.push({ url, options });
        if (url === 'https://api.openai.com/v1/models') {
            if (options.headers.Authorization === 'Bearer sk-valida') {
                return { ok: true, json: async () => ({}) };
            }
            return { ok: false, status: 401 };
        }
        if (url.includes('/instance/connectionState/')) {
            if (options.headers.apikey === 'evo-key') {
                return { ok: true, json: async () => ({ instance: { state: 'open' } }) };
            }
            return { ok: false, status: 401 };
        }
        return { ok: false, status: 404 };
    };

    let baileysStarted = false;
    const mockBaileys = {
        iniciar: async () => {
            baileysStarted = true;
            return {
                obterEstado: async () => ({ status: 'connected' }),
                listarGrupos: async () => [{ jid: '123@g.us', nome: 'Grupo 1' }]
            };
        }
    };

    const handler = criarSetup({ 
        dir, 
        conectores: { fetch: mockFetch, baileys: mockBaileys }
    });

    const mockRes = () => {
        let statusCode = 200;
        let body = '';
        return {
            writeHead: (code) => statusCode = code,
            end: (data) => body = data,
            getStatus: () => statusCode,
            getBody: () => JSON.parse(body)
        };
    };

    // Helper p/ requisição
    const request = async (method, url, headers = {}, bodyObj = null) => {
        const req = {
            method,
            url,
            headers: { host: '127.0.0.1:8080', ...headers },
            socket: { localPort: 8080 },
            on: (event, cb) => {
                if (event === 'data' && bodyObj) cb(Buffer.from(JSON.stringify(bodyObj)));
                if (event === 'end') cb();
            },
            off: () => {},
            resume: () => {}
        };
        const res = mockRes();
        await handler(req, res);
        return { status: res.getStatus(), body: res.getBody() };
    };

    // 1. Falha por origem não local
    let res = await request('POST', '/api/setup/openai', { host: 'malicious.com' }, { key: 'sk-valida' });
    assert.equal(res.status, 403);

    // 2. Chave OpenAI Inválida
    res = await request('POST', '/api/setup/openai', { 'content-type': 'application/json' }, { key: 'sk-invalida' });
    assert.equal(res.status, 401);

    // 3. Chave OpenAI Válida
    res = await request('POST', '/api/setup/openai', { 'content-type': 'application/json' }, { key: 'sk-valida' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    
    // Verifica se gravou no .env
    const envContent = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(envContent, /OPENAI_API_KEY=sk-valida/);
    
    // 4. Evolution config
    res = await request('POST', '/api/setup/evolution', { 'content-type': 'application/json' }, { 
        url: 'http://evo.local', 
        apikey: 'evo-key', 
        instance: 'balde' 
    });
    assert.equal(res.status, 200);
    const envContent2 = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(envContent2, /BALDE_EVOLUTION_URL=http:\/\/evo.local/);

    // 5. Baileys
    res = await request('POST', '/api/setup/baileys/start', { 'content-type': 'application/json' }, {});
    assert.equal(res.status, 200);
    assert.equal(baileysStarted, true);
    
    res = await request('GET', '/api/setup/qr');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'connected');

    // 6. Grupos POST
    res = await request('POST', '/api/setup/grupos', { 'content-type': 'application/json' }, {
        grupos: [{ jid: '999@g.us', empresa: 'Empresa', projeto: 'Proj', tipo: 'cliente' }]
    });
    assert.equal(res.status, 200);
    
    const gruposMd = fs.readFileSync(path.join(dir, 'GRUPOS.md'), 'utf8');
    assert.match(gruposMd, /Empresa/);
    assert.match(gruposMd, /Proj/);
    assert.match(gruposMd, /999@g\.us/);
    
    fs.rmSync(dir, { recursive: true, force: true });
});

test('criarSetup - código de convite grava o .env com o token da instância e serve o QR', async () => {
    const { codificarConvite } = await import('../lib/whatsapp/convite.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-setup-convite-'));
    const chamadas = [];
    let estado = 'close';
    const mockFetch = async (url, options = {}) => {
        chamadas.push({ url, apikey: options.headers?.apikey });
        if (options.headers?.apikey !== 'TOKEN-DA-INSTANCIA') return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
        if (url.includes('/instance/connectionState/balde-ana')) return { ok: true, json: async () => ({ instance: { state: estado } }) };
        if (url.includes('/instance/connect/balde-ana')) return { ok: true, json: async () => ({ base64: 'data:image/png;base64,QR' }) };
        if (url.includes('/group/fetchAllGroups/balde-ana')) return { ok: true, json: async () => ([{ id: '1@g.us', subject: 'Casa' }]) };
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    };
    const handler = criarSetup({ dir, conectores: { fetch: mockFetch } });
    const request = async (method, url, bodyObj = null) => {
        let status = 200, body = '';
        const req = {
            method, url,
            headers: { host: '127.0.0.1:8080', 'content-type': 'application/json' },
            socket: { localPort: 8080 },
            on: (event, cb) => {
                if (event === 'data' && bodyObj) cb(Buffer.from(JSON.stringify(bodyObj)));
                if (event === 'end') cb();
            },
            off: () => {}, resume: () => {}
        };
        await handler(req, { writeHead: c => status = c, end: d => body = d });
        return { status, body: JSON.parse(body) };
    };

    const codigo = codificarConvite({ url: 'https://evo.exemplo.test', instancia: 'balde-ana', tokenInstancia: 'TOKEN-DA-INSTANCIA' });

    let res = await request('POST', '/api/setup/convite', { codigo: 'nao-e-um-codigo' });
    assert.equal(res.status, 400);

    const revogado = codificarConvite({ url: 'https://evo.exemplo.test', instancia: 'balde-ana', tokenInstancia: 'TOKEN-REVOGADO' });
    res = await request('POST', '/api/setup/convite', { codigo: revogado });
    assert.equal(res.status, 400);
    assert.match(res.body.erro, /não vale mais/);

    res = await request('POST', '/api/setup/convite', { codigo: `http://127.0.0.1:7391/setup#convite=${codigo}` });
    assert.equal(res.status, 200);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, /BALDE_EVOLUTION_URL=https:\/\/evo\.exemplo\.test/);
    assert.match(env, /BALDE_EVOLUTION_INSTANCIA=balde-ana/);
    assert.match(env, /BALDE_EVOLUTION_KEY=TOKEN-DA-INSTANCIA/);

    res = await request('GET', '/api/setup/convite/qr');
    assert.deepEqual(res.body, { status: 'qr', qr: 'data:image/png;base64,QR', pairingCode: null });
    estado = 'open';
    res = await request('GET', '/api/setup/convite/qr');
    assert.deepEqual(res.body, { status: 'connected' });

    res = await request('GET', '/api/setup/grupos');
    assert.deepEqual(res.body.grupos.map(g => g.jid), ['1@g.us']);

    // Depois do convite aplicado, toda chamada usou o token da instância (nunca uma chave global).
    assert.ok(chamadas.slice(2).every(c => c.apikey === 'TOKEN-DA-INSTANCIA'));

    // Balde já ligado a outra instância: recusa, não sobrescreve.
    fs.writeFileSync(path.join(dir, '.env'), 'BALDE_EVOLUTION_INSTANCIA=PrincipalDono\nBALDE_EVOLUTION_KEY=KEY-DO-DONO\n');
    res = await request('POST', '/api/setup/convite', { codigo });
    assert.equal(res.status, 409);
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /KEY-DO-DONO/);

    fs.rmSync(dir, { recursive: true, force: true });
});
