import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { iniciarNotificador } from '../lib/notificador.mjs';
const pausa = ms => new Promise(r => setTimeout(r, ms));
test('notificador: baseline, transições, escape, rajada fixa e desligamento', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-notif-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'tarefas.json');
  let tarefas = [{ id: 'antiga', estado: 'pronta' }];
  const gravar = async () => { fs.writeFileSync(arquivo + '.tmp', JSON.stringify(tarefas)); fs.renameSync(arquivo + '.tmp', arquivo); await pausa(300); };
  await gravar();
  const chamadas = [];
  const n = iniciarNotificador({ dadosDir: dir, _executor: args => chamadas.push(args), _janelaMs: 2000 });
  t.after(() => n.parar());
  await pausa(2600); assert.equal(chamadas.length, 0);
  tarefas.push({ id: 'nova', estado: 'pronta', empresa: 'Empresa', projeto: 'Projeto', titulo: 'Dar "oi" \\ agora\nOK' });
  await gravar(); await pausa(2600);
  assert.deepEqual(chamadas[0], ['-e', 'display notification "Dar \\"oi\\" \\\\ agora OK" with title "Empresa · Projeto"']);
  tarefas[0].estado = 'precisa_decisao';
  await gravar();
  await pausa(60);
  tarefas.push({ id: 'decisao', estado: 'precisa_decisao' }); await gravar();
  // Mesmo ID novamente na janela não aumenta a contagem.
  tarefas[0].estado = 'pronta'; await gravar();
  tarefas[0].estado = 'precisa_decisao'; await gravar();
  await pausa(2600);
  assert.equal(chamadas.length, 2);
  assert.equal(chamadas[1][1], 'display notification "" with title "2 tarefas novas"');
  fs.writeFileSync(arquivo, '{'); await pausa(300); await gravar(); await pausa(2600);
  assert.equal(chamadas.length, 2);
  tarefas.push({ id: 'rascunho', estado: 'rascunho' }); await gravar();
  tarefas.at(-1).estado = 'pronta'; await gravar(); await pausa(2600);
  assert.equal(chamadas.length, 2);
  tarefas.push({ id: 'cancelada', estado: 'pronta' }); await gravar(); n.parar(); await pausa(2600);
  assert.equal(chamadas.length, 2);
  const anterior = process.env.BALDE_NOTIFICAR;
  process.env.BALDE_NOTIFICAR = '0';
  try { const desligado = iniciarNotificador({ dadosDir: path.join(dir, 'inexistente'), _executor: () => assert.fail('Desligado') }); desligado.parar(); assert.equal(fs.existsSync(path.join(dir, 'inexistente')), false); }
  finally { if (anterior === undefined) delete process.env.BALDE_NOTIFICAR; else process.env.BALDE_NOTIFICAR = anterior; }
});
