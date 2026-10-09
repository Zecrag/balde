import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugNome, nomeInstancia, codificarConvite, decodificarConvite, linkConvite,
  criarInstancia, listarInstancias, revogarInstancia, qrDaInstancia, planejarConvite,
} from '../lib/whatsapp/convite.mjs';
import { executar } from '../bin/convite.mjs';

const URL_EVO = 'https://evo.exemplo.test';
const TOKEN = 'ABCDEF0123456789TOKEN';

/** fetch falso que grava as chamadas e responde por rota. */
function fetchFalso(rotas) {
  const chamadas = [];
  const f = async (url, opts = {}) => {
    const metodo = opts.method ?? 'GET';
    chamadas.push({ url, metodo, headers: opts.headers, corpo: opts.body ? JSON.parse(opts.body) : undefined });
    const caminho = url.replace(URL_EVO, '').split('?')[0];
    for (const [chave, resp] of Object.entries(rotas)) {
      const [m, prefixo] = chave.split(' ');
      if (m === metodo && caminho.startsWith(prefixo)) {
        const r = typeof resp === 'function' ? resp(opts) : resp;
        const status = r.status ?? 200;
        return { ok: status < 400, status, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
  f.chamadas = chamadas;
  return f;
}

test('slug e nome da instância', () => {
  assert.equal(slugNome('Maria José da Silva'), 'maria-jose-da-silva');
  assert.equal(nomeInstancia('  Ana  '), 'balde-ana');
  assert.throws(() => nomeInstancia('!!!'), /Nome vazio/);
});

test('código de convite: ida e volta, link e entradas ruins', () => {
  const codigo = codificarConvite({ url: `${URL_EVO}/`, instancia: 'balde-ana', tokenInstancia: TOKEN });
  assert.match(codigo, /^[A-Za-z0-9_-]+$/);
  const volta = decodificarConvite(codigo);
  assert.deepEqual(volta, { url: URL_EVO, instancia: 'balde-ana', tokenInstancia: TOKEN });
  const link = linkConvite(codigo);
  assert.equal(link, `http://127.0.0.1:7391/setup#convite=${codigo}`);
  assert.deepEqual(decodificarConvite(link), volta, 'aceita o link inteiro colado');
  assert.deepEqual(decodificarConvite(`  ${codigo.slice(0, 10)}\n${codigo.slice(10)} `), volta, 'tolera quebra de linha');
  assert.throws(() => decodificarConvite('lixo'), /inválido/);
  // Instância que não é de convite (ex.: a principal do dono) é recusada.
  const outra = Buffer.from(JSON.stringify({ u: URL_EVO, i: 'PrincipalDono', t: TOKEN })).toString('base64url');
  assert.throws(() => decodificarConvite(outra), /inválido/);
});

test('criarInstancia: sem webhook, só leitura, devolve o token da instância (v2 e v1)', async () => {
  const f = fetchFalso({ 'POST /instance/create': { status: 201, body: { instance: { instanceName: 'balde-ana' }, hash: 'TOKEN-V2-123456' } } });
  const r = await criarInstancia({ url: URL_EVO, key: 'GLOBAL', fetch: f }, 'balde-ana');
  assert.equal(r.tokenInstancia, 'TOKEN-V2-123456');
  const c = f.chamadas[0];
  assert.equal(c.headers.apikey, 'GLOBAL');
  assert.equal(c.corpo.instanceName, 'balde-ana');
  assert.equal(c.corpo.webhook, undefined);
  assert.equal(c.corpo.readMessages, false);

  const f1 = fetchFalso({ 'POST /instance/create': { body: { hash: { apikey: 'TOKEN-V1-123456' } } } });
  assert.equal((await criarInstancia({ url: URL_EVO, key: 'G', fetch: f1 }, 'balde-ana')).tokenInstancia, 'TOKEN-V1-123456');

  await assert.rejects(criarInstancia({ url: URL_EVO, key: 'G', fetch: f1 }, 'PrincipalDono'), /Recusado/);
});

test('planejar recusa nome existente; listar não vaza token', async () => {
  const f = fetchFalso({ 'GET /instance/fetchInstances': { body: [
    { name: 'PrincipalDono', connectionStatus: 'open', ownerJid: '5511@s.whatsapp.net', token: 'SEGREDO' },
    { name: 'balde-ana', connectionStatus: 'close', token: 'SEGREDO2' },
  ] } });
  const conexao = { url: URL_EVO, key: 'G', fetch: f };
  const lista = await listarInstancias(conexao);
  assert.equal(lista.length, 2);
  assert.ok(!JSON.stringify(lista).includes('SEGREDO'));
  await assert.rejects(planejarConvite(conexao, 'Ana'), /Já existe/);
  assert.equal((await planejarConvite(conexao, 'Bia')).instancia, 'balde-bia');
});

test('revogar: logout + delete só em balde-*', async () => {
  const f = fetchFalso({ 'DELETE /instance/logout/': { status: 400 }, 'DELETE /instance/delete/': { body: { status: 'SUCCESS' } } });
  const r = await revogarInstancia({ url: URL_EVO, key: 'G', fetch: f }, 'balde-ana');
  assert.equal(r.deslogou, false);
  assert.deepEqual(f.chamadas.map(c => c.metodo), ['DELETE', 'DELETE']);
  assert.ok(f.chamadas[1].url.endsWith('/instance/delete/balde-ana'));
  await assert.rejects(revogarInstancia({ url: URL_EVO, key: 'G', fetch: f }, 'PrincipalDono'), /Recusado/);
  await assert.rejects(revogarInstancia({ url: URL_EVO, key: 'G', fetch: f }, 'balde-x', { instanciaDono: 'balde-x' }), /principal/);
});

test('qrDaInstancia usa o token da instância e devolve data URL', async () => {
  const f = fetchFalso({
    'GET /instance/connectionState/': { body: { instance: { state: 'close' } } },
    'GET /instance/connect/': { body: { base64: 'data:image/png;base64,AAAA', pairingCode: 'XYZ' } },
  });
  const r = await qrDaInstancia({ url: URL_EVO, key: TOKEN, fetch: f }, 'balde-ana');
  assert.deepEqual(r, { status: 'qr', qr: 'data:image/png;base64,AAAA', pairingCode: 'XYZ' });
  assert.ok(f.chamadas.every(c => c.headers.apikey === TOKEN));

  const aberto = fetchFalso({ 'GET /instance/connectionState/': { body: { instance: { state: 'open' } } } });
  assert.deepEqual(await qrDaInstancia({ url: URL_EVO, key: TOKEN, fetch: aberto }, 'balde-ana'), { status: 'connected' });
});

test('CLI criar sem --sim só simula (nenhum POST)', async () => {
  const f = fetchFalso({ 'GET /instance/fetchInstances': { body: [{ name: 'PrincipalDono', connectionStatus: 'open' }] } });
  const saida = [];
  const code = await executar(['criar', 'Maria', 'Silva'], {
    env: { BALDE_EVOLUTION_URL: URL_EVO, BALDE_EVOLUTION_KEY: 'GLOBAL', BALDE_EVOLUTION_INSTANCIA: 'PrincipalDono' },
    fetch: f, log: s => saida.push(s),
  });
  assert.equal(code, 0);
  assert.match(saida.join('\n'), /SIMULAÇÃO/);
  assert.match(saida.join('\n'), /balde-maria-silva/);
  assert.ok(f.chamadas.every(c => c.metodo === 'GET'));
});

test('CLI criar --sim gera código decodificável com o token da instância (não a global)', async () => {
  const f = fetchFalso({
    'GET /instance/fetchInstances': { body: [] },
    'POST /instance/create': { body: { hash: 'TOKEN-INSTANCIA-1' } },
  });
  const saida = [];
  await executar(['criar', 'Ana', '--sim'], {
    env: { BALDE_EVOLUTION_URL: URL_EVO, BALDE_EVOLUTION_KEY: 'GLOBAL-SECRETA' }, fetch: f, log: s => saida.push(s),
  });
  const texto = saida.join('\n');
  assert.ok(!texto.includes('GLOBAL-SECRETA'));
  const codigo = saida[saida.indexOf('CÓDIGO DE CONVITE (é uma senha: mande só para essa pessoa):') + 1];
  assert.deepEqual(decodificarConvite(codigo), { url: URL_EVO, instancia: 'balde-ana', tokenInstancia: 'TOKEN-INSTANCIA-1' });
  assert.match(texto, /127\.0\.0\.1:7391\/setup#convite=/);
});

test('CLI revogar sem --sim só simula; listar mostra só balde-*', async () => {
  const f = fetchFalso({ 'GET /instance/fetchInstances': { body: [{ name: 'PrincipalDono' }, { name: 'balde-ana', connectionStatus: 'open' }] } });
  const env = { BALDE_EVOLUTION_URL: URL_EVO, BALDE_EVOLUTION_KEY: 'G', BALDE_EVOLUTION_INSTANCIA: 'PrincipalDono' };
  const saida = [];
  await executar(['revogar', 'Ana'], { env, fetch: f, log: s => saida.push(s) });
  assert.equal(f.chamadas.length, 0);
  assert.match(saida.join('\n'), /SIMULAÇÃO/);
  saida.length = 0;
  await executar(['listar'], { env, fetch: f, log: s => saida.push(s) });
  assert.match(saida.join('\n'), /balde-ana/);
  assert.ok(!saida.join('\n').includes('PrincipalDono '));
});

test('convite malicioso não injeta linhas no .env (URL/instância com quebra de linha)', () => {
  const cod = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const ok = { u: 'https://evo.exemplo.com', i: 'balde-ana', t: 'tok_123456789' };
  assert.equal(decodificarConvite(cod(ok)).url, 'https://evo.exemplo.com');
  assert.equal(decodificarConvite(cod({ ...ok, u: 'https://evo.exemplo.com/base/' })).url, 'https://evo.exemplo.com/base');
  assert.throws(() => decodificarConvite(cod({ ...ok, u: 'https://evo.exemplo.com/x\nBALDE_LLM_KEY=mal' })), /inválido/);
  assert.throws(() => decodificarConvite(cod({ ...ok, u: 'https://evo.exemplo.com/?a=1' })), /inválido/);
  assert.throws(() => decodificarConvite(cod({ ...ok, i: 'balde-ana\nOPENAI_API_KEY=x' })), /inválido/);
  assert.throws(() => decodificarConvite(cod({ ...ok, i: 'balde-' })), /inválido/);
});
