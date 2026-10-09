/**
 * @file api.test.mjs — Testes da API do Balde
 * Roda com: node --test test/api.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarApi } from '../lib/api.mjs';

// ─── Store em memória para testes ─────────────────────────────────────────────
function criarStoreMock() {
  /** @type {Map<string, object>} */
  const db = new Map();
  const fila = [];
  const mensagensDB = [];

  return {
    async listarTarefas() {
      return [...db.values()];
    },
    async obterTarefa(id) {
      return db.get(id) ?? null;
    },
    async atualizarTarefa(id, campos) {
      const agora = new Date().toISOString();
      const anterior = db.get(id) ?? { id, criadaEm: agora };
      const atualizada = { ...anterior, ...campos, id, atualizadaEm: agora };
      db.set(id, atualizada);
      return atualizada;
    },
    async listarMensagens(chatId) {
      if (!chatId) return mensagensDB;
      return mensagensDB.filter(m => m.chatId === chatId);
    },
    async gravarDistribuicao(entrada) {
      fila.push(entrada);
    },
    // helpers de teste
    _db: db,
    _fila: fila,
    _mensagens: mensagensDB,
  };
}

// ─── Utilitários HTTP ─────────────────────────────────────────────────────────
function req(server, options, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opt = {
      hostname: '127.0.0.1',
      port: addr.port,
      ...options,
    };
    const r = http.request(opt, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (body) {
      const payload = JSON.stringify(body);
      r.setHeader('Content-Type', 'application/json');
      r.setHeader('Content-Length', Buffer.byteLength(payload));
      r.write(payload);
    }
    r.end();
  });
}

// ─── Suite principal ──────────────────────────────────────────────────────────
describe('API Balde', () => {
  let server;
  let store;
  let clientes = [];
  let tmp;
  let gruposMdPath;
  const abertos = [];

  before(async () => {
    store = criarStoreMock();

    // Dados de exemplo
    await store.atualizarTarefa('t1', {
      empresa: 'Acme', projeto: 'Site', titulo: 'Corrigir login',
      descricao: 'Botão de login não funciona no Safari', estado: 'pronta',
      urgencia: 80, prazo: null, responsavel: 'ia', faltando: [], fontes: [], chatId: 'chat-acme',
    });
    await store.atualizarTarefa('t2', {
      empresa: 'Acme', projeto: 'App', titulo: 'Revisar fluxo de pagamento',
      descricao: 'Verificar gateway', estado: 'aguardando_info',
      urgencia: 60, prazo: null, responsavel: 'eu', faltando: ['resposta do cliente'], fontes: [], chatId: 'chat-acme',
    });
    await store.atualizarTarefa('t3', {
      empresa: 'Beta', projeto: 'API', titulo: 'Documentar endpoints',
      descricao: 'Swagger desatualizado', estado: 'pronta',
      urgencia: 40, prazo: null, responsavel: 'ia', faltando: [], fontes: [], chatId: 'chat-beta',
    });

    // Mensagem de exemplo
    store._mensagens.push({
      id: 'm1', chatId: 'chat-acme', chatNome: 'Acme Group',
      origem: 'grupo', autor: 'João', ts: new Date().toISOString(),
      tipo: 'texto', texto: 'Precisamos corrigir o login urgente.', raw: {},
    });

    tmp = mkdtempSync(join(tmpdir(), 'balde-api-'));
    gruposMdPath = join(tmp, 'GRUPOS.md');
    const handler = criarApi({
      store,
      lerClientes: () => clientes,
      gruposMdPath,
      abrirArquivo: p => abertos.push(p),
      destinosPath: join(tmp, 'DESTINOS.md'),
      listarGruposEvolution: async () => [{ jid: '120363011111111111@g.us', nome: 'Alfa - Site (WhatsApp)' }],
    });
    writeFileSync(join(tmp, 'DESTINOS.md'), `| Nome | Tipo | Alvo |
|---|---|---|
| n8n | webhook | https://n8n.exemplo/webhook/x |
| Agente Local | agente | agy-agent |
| Deploy | comando | /usr/local/bin/deploy.sh |
| Lixo | skill | nada |`);
    server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });

  // ── GET /api/tarefas ───────────────────────────────────────────────────────
  describe('GET /api/tarefas', () => {
    it('retorna todas as tarefas ordenadas por urgência', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas', method: 'GET' });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.tarefas));
      assert.equal(body.tarefas.length, 3);
      // primeira deve ser a de maior urgência
      assert.equal(body.tarefas[0].id, 't1');
    });

    it('filtra por empresa', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas?empresa=Acme', method: 'GET' });
      assert.equal(status, 200);
      assert.equal(body.tarefas.length, 2);
      assert.ok(body.tarefas.every(t => t.empresa === 'Acme'));
    });

    it('filtra por estado', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas?estado=pronta', method: 'GET' });
      assert.equal(status, 200);
      assert.ok(body.tarefas.every(t => t.estado === 'pronta'));
    });

    it('filtra por projeto', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas?projeto=Site', method: 'GET' });
      assert.equal(status, 200);
      assert.equal(body.tarefas.length, 1);
      assert.equal(body.tarefas[0].projeto, 'Site');
    });

    it('GET /api/tarefas?empresa=Acme retorna só tarefas da Acme ordenadas por urgência', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas?empresa=Acme', method: 'GET' });
      assert.equal(status, 200);
      const ts = body.tarefas;
      assert.ok(ts.every(t => t.empresa === 'Acme'));
      // ordenadas por urgência desc
      for (let i = 1; i < ts.length; i++) {
        assert.ok(ts[i - 1].urgencia >= ts[i].urgencia);
      }
    });
  });

  // ── PATCH /api/tarefas/:id ─────────────────────────────────────────────────
  describe('PATCH /api/tarefas/:id', () => {
    it('atualiza o estado de uma tarefa', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas/t1', method: 'PATCH' }, { estado: 'em_execucao' });
      assert.equal(status, 200);
      assert.equal(body.tarefa.estado, 'em_execucao');
    });

    it('atualiza titulo e responsavel', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas/t2', method: 'PATCH' }, { titulo: 'Novo título', responsavel: 'ia' });
      assert.equal(status, 200);
      assert.equal(body.tarefa.titulo, 'Novo título');
      assert.equal(body.tarefa.responsavel, 'ia');
    });

    it('ignora campos não permitidos', async () => {
      const { status, body } = await req(server, { path: '/api/tarefas/t3', method: 'PATCH' }, { urgencia: 99, estado: 'feita' });
      assert.equal(status, 200);
      // urgencia não é campo permitido no PATCH
      assert.equal(body.tarefa.urgencia, 40);
      assert.equal(body.tarefa.estado, 'feita');
    });
  });

  // ── POST /api/tarefas/:id/distribuir ──────────────────────────────────────
  describe('POST /api/tarefas/:id/distribuir', () => {
    it('grava destino na tarefa e linha em fila', async () => {
      const { status, body } = await req(
        server,
        { path: '/api/tarefas/t1/distribuir', method: 'POST' },
        { tipo: 'agente', alvo: 'agy-deployer' }
      );
      assert.equal(status, 200);
      assert.deepEqual(body.tarefa.destino, { tipo: 'agente', alvo: 'agy-deployer' });
      assert.equal(body.distribuicao.tarefaId, 't1');
      assert.equal(body.distribuicao.destino.tipo, 'agente');
      // fila em memória deve ter a entrada
      assert.equal(store._fila.length, 1);
      assert.equal(store._fila[0].tarefaId, 't1');
    });

    it('retorna 400 se tipo ou alvo faltam', async () => {
      const { status } = await req(server, { path: '/api/tarefas/t2/distribuir', method: 'POST' }, { tipo: 'skill' });
      assert.equal(status, 400);
    });

    it('POST distribuir → tarefa ganha destino e fila tem 1 linha', async () => {
      const filaAntes = store._fila.length;
      const { status, body } = await req(
        server,
        { path: '/api/tarefas/t2/distribuir', method: 'POST' },
        { tipo: 'fluxo', alvo: 'revisar-pagamento' }
      );
      assert.equal(status, 200);
      assert.ok(body.tarefa.destino);
      assert.equal(store._fila.length, filaAntes + 1);
    });
  });

  // ── GET /api/mensagens ─────────────────────────────────────────────────────
  describe('GET /api/mensagens', () => {
    it('filtra mensagens por chatId', async () => {
      const { status, body } = await req(server, { path: '/api/mensagens?chatId=chat-acme', method: 'GET' });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.mensagens));
      assert.equal(body.mensagens.length, 1);
      assert.equal(body.mensagens[0].chatId, 'chat-acme');
    });

    it('retorna lista vazia para chatId sem mensagens', async () => {
      const { status, body } = await req(server, { path: '/api/mensagens?chatId=nao-existe', method: 'GET' });
      assert.equal(status, 200);
      assert.equal(body.mensagens.length, 0);
    });
  });

  // ── GB-16: ganho/início/fim, ordem, resumo por empresa ─────────────────────
  describe('Ganho e ordem (GB-16)', () => {
    it('PATCH ignora ganho, inicio e fim (são do projeto) e grava o resto', async () => {
      await store.atualizarTarefa('t-patch-datas', { empresa: 'Zeta', projeto: 'Z', titulo: 'T1', estado: 'pronta', urgencia: 0 });
      const { status, body } = await req(server, { path: '/api/tarefas/t-patch-datas', method: 'PATCH' },
        { ganho: 150, inicio: '2026-01-01', fim: 'lixo', titulo: 'T1 editada' });
      assert.equal(status, 200);
      assert.equal(body.tarefa.titulo, 'T1 editada');
      assert.equal('ganho' in body.tarefa, false);
      assert.equal('inicio' in body.tarefa, false);
      assert.equal('fim' in body.tarefa, false);
    });

    it('ganho/início/fim vêm do projeto; ganho antigo gravado na tarefa não conta; ordem ganho → prazo → urgência', async () => {
      clientes = [
        { empresa: 'Acme', projeto: 'App', receitaMensal: 9000, inicio: '2026-01-01', fim: '2026-12-31', tipoTicket: 'cliente' },
        { empresa: 'Acme', projeto: 'Site', receitaMensal: 9000, inicio: null, fim: '2026-06-30', tipoTicket: 'cliente' },
        { empresa: 'Beta', projeto: 'API', receitaMensal: 500, inicio: null, fim: null, tipoTicket: 'despejo' },
      ];
      await store.atualizarTarefa('t3', { ganho: 99999 }); // legado de antes do GB-29
      const { body } = await req(server, { path: '/api/tarefas', method: 'GET' });
      const t2 = body.tarefas.find(t => t.id === 't2');
      assert.deepEqual(t2.efetivo, { ganho: 9000, inicio: '2026-01-01', fim: '2026-12-31' });
      assert.equal(body.tarefas.find(t => t.id === 't3').efetivo.ganho, 500);
      assert.equal(body.tarefas.find(t => t.id === 't-patch-datas').efetivo.ganho, 0);
      // empate em 9000 → Site (fim 30/06) antes de App (fim 31/12); depois Beta 500, depois Zeta 0
      assert.deepEqual(body.tarefas.map(t => t.id), ['t1', 't2', 't3', 't-patch-datas']);
    });

    it('empresas por ganho total; projeto traz ganho, início, fim e tipo', async () => {
      const { body } = await req(server, { path: '/api/tarefas?empresa=Beta', method: 'GET' });
      assert.equal(body.tarefas.length, 1);
      // resumo usa a lista COMPLETA, mesmo com filtro
      assert.deepEqual(body.empresas.map(e => [e.empresa, e.ganhoTotal]), [['Acme', 18000], ['Beta', 500], ['Zeta', 0]]);
      const acme = body.empresas[0];
      assert.deepEqual(acme.projetos.map(p => p.projeto), ['App', 'Site']);
      assert.deepEqual(acme.projetos[1], { projeto: 'Site', ganho: 9000, inicio: null, fim: '2026-06-30', tipo: 'cliente', grupos: [] });
      assert.equal(body.empresas[1].projetos[0].tipo, 'despejo');
      clientes = [];
    });
  });

  // ── GB-16: destinos reais (DESTINOS.md) ──────────────────────────────────
  describe('Destinos', () => {
    it('GET /api/destinos lista webhook, agente e comando do DESTINOS.md', async () => {
      const { status, body } = await req(server, { path: '/api/destinos', method: 'GET' });
      assert.equal(status, 200);
      assert.deepEqual(body.destinos.map(d => [d.nome, d.tipo]), [['n8n', 'webhook'], ['Agente Local', 'agente'], ['Deploy', 'comando']]);
    });

    it('distribuir por nome grava o nome na fila e o destino completo na tarefa', async () => {
      const antes = store._fila.length;
      const { status, body } = await req(server, { path: '/api/tarefas/t3/distribuir', method: 'POST' }, { nome: 'Deploy' });
      assert.equal(status, 200);
      assert.deepEqual(body.tarefa.destino, { nome: 'Deploy', tipo: 'comando', alvo: '/usr/local/bin/deploy.sh' });
      assert.equal(store._fila.length, antes + 1);
      assert.equal(store._fila.at(-1).destino, 'Deploy');
    });

    it('distribuir para nome fora do DESTINOS.md → 400, nada na fila', async () => {
      const antes = store._fila.length;
      const { status } = await req(server, { path: '/api/tarefas/t3/distribuir', method: 'POST' }, { nome: 'Lixo' });
      assert.equal(status, 400);
      assert.equal(store._fila.length, antes);
    });
  });

  // ── GB-16: GRUPOS.md ───────────────────────────────────────────────────────
  describe('Config GRUPOS.md', () => {
    it('GET /api/config/grupos devolve caminho absoluto, linhas e avisos', async () => {
      writeFileSync(gruposMdPath, `| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |
|---|---|---|---|---|---|---|
| Alfa | Site | 120363011111111111@g.us | 6.000,00 | | | cliente |
| Beta | App | nada | 1,00 | | | cliente |`);
      const { status, body } = await req(server, { path: '/api/config/grupos', method: 'GET' });
      assert.equal(status, 200);
      assert.equal(body.arquivo, gruposMdPath);
      assert.equal(body.existe, true);
      assert.equal(body.linhas.length, 1);
      assert.equal(body.linhas[0].ganho, 6000);
      assert.equal(body.avisos.length, 1);
    });

    it('POST /api/config/abrir abre só o caminho fixo, ignorando o corpo', async () => {
      const { status, body } = await req(server, { path: '/api/config/abrir', method: 'POST' },
        { arquivo: '/etc/passwd', caminho: '../../.env' });
      assert.equal(status, 200);
      assert.equal(body.arquivo, gruposMdPath);
      assert.deepEqual(abertos, [gruposMdPath]);
    });

    it('POST /api/config/abrir cria GRUPOS.md a partir do exemplo se faltar', async () => {
      rmSync(gruposMdPath);
      const { status } = await req(server, { path: '/api/config/abrir', method: 'POST' }, {});
      assert.equal(status, 200);
      assert.equal(existsSync(gruposMdPath), true);
    });
  });

  // ── GB-29: aba Projetos (GRUPOS.md editável) ───────────────────────────────
  describe('Projetos (GB-29)', () => {
    const INSTR = '# Grupos do Balde\n\nInstruções que precisam ficar.';
    const TAB = `| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |
|---|---|---|---|---|---|---|
| Alfa | Site | 120363011111111111@g.us | 6.000,00 | 01/01/2026 | 31/12/2026 | cliente |
| Beta | App | nada | | | | cliente |`;
    const linhaOk = { empresa: 'Alfa', projeto: 'Site', link: '120363011111111111@g.us', ganho: '6.000,00', inicio: '01/01/2026', fim: '31/12/2026', tipo: 'cliente' };

    it('GET /api/projetos devolve linhas cruas (até inválidas), nome do grupo e versão', async () => {
      writeFileSync(gruposMdPath, `${INSTR}\n\n${TAB}\n`);
      const { status, body } = await req(server, { path: '/api/projetos', method: 'GET' });
      assert.equal(status, 200);
      assert.equal(body.arquivo, gruposMdPath);
      assert.equal(body.linhas.length, 2);
      assert.equal(body.linhas[0].jid, '120363011111111111@g.us');
      assert.equal(body.linhas[0].grupoNome, 'Alfa - Site (WhatsApp)');
      assert.equal(body.linhas[1].link, 'nada');
      assert.equal(body.avisos.length, 1);
      assert.match(body.versao, /^[0-9a-f]{16}$/);
    });

    it('PUT válido regrava a tabela, mantém instruções e devolve o estado novo', async () => {
      const { body: antes } = await req(server, { path: '/api/projetos', method: 'GET' });
      const linhas = [
        linhaOk,
        { empresa: 'Alfa', projeto: 'Ads', link: 'https://chat.whatsapp.com/AbC123', ganho: '2000', inicio: '', fim: '', tipo: 'cliente' },
      ];
      const { status, body } = await req(server, { path: '/api/projetos', method: 'PUT' }, { linhas, versao: antes.versao });
      assert.equal(status, 200);
      const texto = readFileSync(gruposMdPath, 'utf8');
      assert.ok(texto.startsWith(INSTR));
      assert.ok(texto.includes('| Alfa | Ads | https://chat.whatsapp.com/AbC123 | 2.000,00 | | | cliente |'));
      assert.equal(texto.includes('Beta'), false);
      assert.equal(body.linhas.length, 2);
      assert.deepEqual(body.avisos, []);
      assert.notEqual(body.versao, antes.versao);
    });

    it('PUT inválido → 400 com erros por linha e arquivo intocado', async () => {
      const antes = readFileSync(gruposMdPath, 'utf8');
      const { status, body } = await req(server, { path: '/api/projetos', method: 'PUT' }, {
        linhas: [{ ...linhaOk, empresa: '', ganho: 'muito', inicio: '2026', link: 'http://evil' }],
      });
      assert.equal(status, 400);
      assert.deepEqual(body.erros.map(e => e.campo), ['empresa', 'link', 'ganho', 'inicio']);
      assert.equal(readFileSync(gruposMdPath, 'utf8'), antes);
    });

    it('PUT com jid duplicado → 400', async () => {
      const antes = readFileSync(gruposMdPath, 'utf8');
      const { status, body } = await req(server, { path: '/api/projetos', method: 'PUT' }, {
        linhas: [linhaOk, { ...linhaOk, projeto: 'Outro' }],
      });
      assert.equal(status, 400);
      assert.equal(body.erros[0].linha, 2);
      assert.match(body.erros[0].msg, /repetido/);
      assert.equal(readFileSync(gruposMdPath, 'utf8'), antes);
    });

    it('PUT com versão velha (arquivo editado fora) → 409, nada gravado', async () => {
      writeFileSync(gruposMdPath, `${INSTR}\n\n${TAB}\n| Gama | X | 120363033333333333@g.us | | | | cliente |\n`);
      const antes = readFileSync(gruposMdPath, 'utf8');
      const { status } = await req(server, { path: '/api/projetos', method: 'PUT' }, { linhas: [linhaOk], versao: '0000000000000000' });
      assert.equal(status, 409);
      assert.equal(readFileSync(gruposMdPath, 'utf8'), antes);
    });

    it('PUT exige Content-Type JSON e Origin do próprio painel', async () => {
      const semJson = await new Promise((resolve, reject) => {
        const r = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/projetos', method: 'PUT',
          headers: { 'Content-Type': 'text/plain' } }, res => { res.resume(); resolve(res.statusCode); });
        r.on('error', reject); r.end('{"linhas":[]}');
      });
      assert.equal(semJson, 403);
      const outraOrigem = await req(server, { path: '/api/projetos', method: 'PUT', headers: { Origin: 'http://evil.example' } }, { linhas: [] });
      assert.equal(outraOrigem.status, 403);
    });
  });

  // ── Rotas inválidas ────────────────────────────────────────────────────────
  describe('Rotas desconhecidas', () => {
    it('retorna 404 para rota inexistente', async () => {
      const { status } = await req(server, { path: '/api/naoexiste', method: 'DELETE' }, {});
      assert.equal(status, 404);
    });
  });
});
