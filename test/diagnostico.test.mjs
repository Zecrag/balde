/**
 * @file diagnostico.test.mjs — bin/diagnostico.mjs com fetch/launchctl/arquivos injetados (nunca há rede).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticar, formatar, carregarEnv, segredosDe, mascarar } from '../bin/diagnostico.mjs';

const KEY_EVO = 'evo-segredo-123456';
const KEY_OPENAI = 'sk-teste-abcdef987654';

const ENV = {
  BALDE_EVOLUTION_URL: 'https://evo.exemplo.com/',
  BALDE_EVOLUTION_KEY: KEY_EVO,
  BALDE_EVOLUTION_INSTANCIA: 'desenvolvedor',
  BALDE_LLM: 'openai',
  OPENAI_API_KEY: KEY_OPENAI,
  BALDE_WEBHOOK_ESPERADO: 'exemplo.com',
};

const GRUPOS = `| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |
|---|---|---|---|---|---|---|
| Alfa Tech | Site | https://chat.whatsapp.com/Conv1 | 6.000,00 | | | cliente |
| Beta | App | 120363000000000001@g.us | 900 | | | cliente |
| Gama | Loja | https://chat.whatsapp.com/Morto | 100 | | | cliente |
| quebrada |
`;

const resposta = (status, corpo) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

/** fetch falso que registra chamadas e responde por rota. */
function fetchFalso(rotas) {
  const chamadas = [];
  const fn = async (url, init = {}) => {
    chamadas.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    for (const [padrao, resp] of rotas) {
      if (String(url).includes(padrao)) {
        if (resp instanceof Error) throw resp;
        return typeof resp === 'function' ? resp(url, init) : resp;
      }
    }
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  fn.chamadas = chamadas;
  return fn;
}

const ROTAS_OK = [
  ['/instance/connectionState/desenvolvedor', resposta(200, { instance: { instanceName: 'desenvolvedor', state: 'open' } })],
  ['inviteCode=Conv1', resposta(200, { id: '120363999@g.us', subject: 'Alfa · Site oficial' })],
  ['inviteCode=Morto', resposta(404, { message: 'not found' })],
  ['api.openai.com/v1/chat/completions', resposta(200, { choices: [{ message: { content: 'ok' } }] })],
  ['127.0.0.1:7391/api/tarefas', resposta(200, [])],
  ['/webhook/find/desenvolvedor', resposta(200, { enabled: true, url: `https://exemplo.com/hook?token=${KEY_EVO}` })],
];

const launchctlCarregado = () => ({ status: 0, stdout: '\tstate = running\n\tpid = 4242\n' });

function rodar(over = {}) {
  return diagnosticar({
    env: ENV,
    fetch: over.fetch ?? fetchFalso(ROTAS_OK),
    lerArquivo: over.lerArquivo ?? (() => GRUPOS),
    launchctl: over.launchctl ?? launchctlCarregado,
    versaoNode: over.versaoNode ?? 'v22.3.0',
    plataforma: 'darwin',
    uid: 501,
    mdPath: '/falso/GRUPOS.md',
    ...over.extra,
  });
}

describe('diagnóstico do balde', () => {
  it('monta os 7 itens na ordem, com resultado de cada um', async () => {
    const r = await rodar();
    assert.equal(r.length, 7);
    const [node, evo, grupos, llm, servidor, launchd, webhook] = r;
    assert.equal(node.ok, true);
    assert.equal(evo.ok, true);
    assert.match(evo.detalhes[0], /open/);
    assert.equal(grupos.ok, false, 'convite morto reprova o item');
    assert.match(grupos.titulo, /3 linha\(s\) válida\(s\), 1 aviso/);
    assert.ok(grupos.detalhes.some(d => d.includes('Alfa Tech · Site → "Alfa · Site oficial" 120363999@g.us')));
    assert.ok(grupos.detalhes.some(d => d.includes('Beta · App → 120363000000000001@g.us (jid direto)')));
    assert.ok(grupos.detalhes.some(d => d.startsWith('❌ Gama · Loja')));
    assert.equal(llm.ok, true);
    assert.match(llm.titulo, /openai · modelo /);
    assert.equal(servidor.ok, true);
    assert.equal(launchd.ok, true);
    assert.match(launchd.detalhes[0], /running · pid 4242/);
    assert.equal(webhook.ok, true);
    assert.match(webhook.detalhes[0], /exemplo\.com/);
  });

  it('é somente leitura: Evolution só recebe GET; o único POST é o teste mínimo do LLM', async () => {
    const f = fetchFalso(ROTAS_OK);
    await rodar({ fetch: f });
    for (const c of f.chamadas.filter(c => c.url.startsWith('https://evo.exemplo.com'))) {
      assert.equal(c.method, 'GET', c.url);
      assert.equal(c.headers.apikey, KEY_EVO);
      assert.ok(!c.url.includes('//instance'), 'barra final da URL removida');
    }
    const posts = f.chamadas.filter(c => c.method !== 'GET');
    assert.equal(posts.length, 1);
    const corpo = JSON.parse(posts[0].body);
    assert.equal(corpo.max_completion_tokens, 5);
    assert.equal(corpo.messages[0].content, 'responda ok');
    assert.ok(!posts[0].url.includes(KEY_OPENAI), 'key nunca vai na URL');
  });

  it('saída formatada nunca contém segredo', async () => {
    const r = await rodar();
    const texto = formatar(r, segredosDe(ENV));
    assert.ok(!texto.includes(KEY_EVO));
    assert.ok(!texto.includes(KEY_OPENAI));
    assert.ok(!texto.includes('token='), 'webhook mostra só o host');
    assert.match(texto, /^✅ 1\. Node v22\.3\.0/m);
    assert.match(texto, /^❌ 3\. GRUPOS\.md/m);
    assert.match(texto, /1 de 7 item\(ns\) com problema\./);
  });

  it('falhas viram ❌ com motivo, sem lançar', async () => {
    const f = fetchFalso([
      ['/instance/connectionState/', resposta(200, { instance: { state: 'close' } })],
      ['api.openai.com', resposta(401, { error: { message: 'Incorrect API key' } })],
      ['/webhook/find/', resposta(200, { webhook: { url: 'https://outro.host/x', enabled: true } })],
    ]);
    const r = await rodar({
      fetch: f,
      versaoNode: 'v18.19.0',
      lerArquivo: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      launchctl: () => ({ status: 113, stdout: '' }),
    });
    assert.deepEqual(r.map(i => i.ok), [false, false, false, false, false, false, false]);
    assert.match(r[1].detalhes[0], /close/);
    assert.match(r[2].detalhes[0], /não encontrado/);
    assert.match(r[3].detalhes[0], /HTTP 401 — Incorrect API key/);
    assert.match(r[4].detalhes[0], /ECONNREFUSED/);
    assert.match(r[5].detalhes[0], /não carregado/);
    assert.match(r[6].detalhes[0], /outro\.host — mudou!/);
  });

  it('sem .env da Evolution nem key de LLM, não faz rede para elas', async () => {
    const f = fetchFalso([]);
    const r = await diagnosticar({
      env: { BALDE_LLM: 'openai' }, fetch: f, lerArquivo: () => GRUPOS,
      launchctl: launchctlCarregado, versaoNode: 'v22.0.0', plataforma: 'darwin', uid: 501, mdPath: '/x',
    });
    assert.match(r[1].detalhes[0], /BALDE_EVOLUTION_URL, BALDE_EVOLUTION_KEY, BALDE_EVOLUTION_INSTANCIA/);
    assert.match(r[3].detalhes[0], /sem key/);
    assert.deepEqual(f.chamadas.map(c => c.url), ['http://127.0.0.1:7391/api/tarefas']);
  });

  it('BALDE_PORT muda a porta checada', async () => {
    const f = fetchFalso([['127.0.0.1:8080/api/tarefas', resposta(200, [])]]);
    const r = await diagnosticar({
      env: { BALDE_PORT: '8080' }, fetch: f, lerArquivo: () => '', launchctl: launchctlCarregado,
      versaoNode: 'v22.0.0', plataforma: 'darwin', uid: 501, mdPath: '/x',
    });
    assert.equal(r[4].ok, true);
    assert.match(r[4].titulo, /:8080/);
  });
});

describe('helpers', () => {
  it('carregarEnv não sobrescreve o ambiente e aceita = no valor', () => {
    const env = carregarEnv('# c\nA=1\nB=x=y\n\nC = 3\n', { A: 'já' });
    assert.deepEqual(env, { A: 'já', B: 'x=y', C: '3' });
  });

  it('segredosDe pega KEY/TOKEN e mascarar troca por ***', () => {
    const seg = segredosDe({ BALDE_EVOLUTION_KEY: 'abcd1234', BALDE_WEBHOOK_TOKEN: 'tok-999', BALDE_LLM: 'openai' });
    assert.deepEqual(seg, ['abcd1234', 'tok-999']);
    assert.equal(mascarar('k=abcd1234 t=tok-999 p=openai', seg), 'k=*** t=*** p=openai');
  });
});
