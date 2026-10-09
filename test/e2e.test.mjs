/**
 * @file e2e.test.mjs — Teste ponta a ponta (E2E) do Balde.
 *
 * Sobe o servidor único em porta aleatória (porta 0),
 * roda o fluxo da simulação completa contra os webhooks,
 * e valida que as micro-tarefas aparecem corretamente na API e no painel.
 *
 * Execução: node --test test/e2e.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'balde-e2e-'));
process.env.BALDE_DADOS = join(tempDir, 'dados');
process.env.BALDE_CONFIG = join(tempDir, 'config');
process.env.BALDE_WEBHOOK_INSEGURO = '1';
mkdirSync(process.env.BALDE_CONFIG, { recursive: true });
cpSync(join(process.cwd(), 'config/clientes.exemplo.json'), join(process.env.BALDE_CONFIG, 'clientes.json'));

import { iniciarServidor } from '../server.mjs';
import { rodarSimulacao } from '../bin/simular.mjs';

describe('E2E Balde — Fluxo Completo', () => {
  let servidor;
  let baseUrl;

  before(async () => {
    // Sobe o servidor em porta aleatória (0) para isolamento total dos testes
    servidor = await iniciarServidor({ porta: 0, host: '127.0.0.1', evolution: false });
    const porta = servidor.address().port;
    baseUrl = `http://127.0.0.1:${porta}`;
  });

  after(async () => {
    if (servidor) {
      await new Promise(r => servidor.close(r));
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('servidor sobe e responde no endpoint raiz / servindo o painel', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Balde/i);
    assert.match(html, /Painel/i);
  });

  it('executa a simulação e confere extração e separação por empresa/projeto na API', async () => {
    const tarefas = await rodarSimulacao({ baseUrl });
    assert.ok(Array.isArray(tarefas));
    assert.ok(tarefas.length >= 3, `Esperava pelo menos 3 tarefas geradas, obteve ${tarefas.length}`);

    // Verifica presença de campos essenciais do contrato da missão
    for (const t of tarefas) {
      assert.ok(t.id, 'Tarefa deve ter id');
      assert.ok(t.titulo, 'Tarefa deve ter título');
      assert.ok(t.empresa, 'Tarefa deve ter empresa associada');
      assert.ok(t.projeto, 'Tarefa deve ter projeto associado');
      assert.ok(typeof t.urgencia === 'number', 'Tarefa deve ter urgência numérica');
      assert.ok(t.estado, 'Tarefa deve ter estado');
    }

    // Verifica que tarefas foram separadas por diferentes empresas/projetos
    const empresas = new Set(tarefas.map(t => t.empresa));
    assert.ok(empresas.size >= 2, 'Deve haver tarefas de pelo menos 2 empresas diferentes');

    // Confere filtro por empresa via API GET /api/tarefas?empresa=...
    const resEmpresa = await fetch(`${baseUrl}/api/tarefas?empresa=Alfa%20Tech`);
    assert.equal(resEmpresa.status, 200);
    const dadosEmpresa = await resEmpresa.json();
    assert.ok(dadosEmpresa.tarefas.length >= 1);
    for (const t of dadosEmpresa.tarefas) {
      assert.equal(t.empresa, 'Alfa Tech');
    }
  });
});
