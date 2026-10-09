import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import { lerAmbiente } from './ambiente.mjs';

const cli = resolve('balde/bin/servico.mjs');
test('plist portátil, XML válido, ambiente em runtime e remoção isolada', () => {
  const temp = mkdtempSync(join(tmpdir(), 'gb17-'));
  try {
    const dir = join(temp, 'Balde & "teste"');
    mkdirSync(join(dir, 'deploy'), { recursive: true });
    for (const arquivo of ['iniciar.mjs', 'ambiente.mjs']) copyFileSync(resolve('balde/deploy', arquivo), join(dir, 'deploy', arquivo));
    writeFileSync(join(dir, 'server.mjs'), 'console.log(JSON.stringify({e:process.env.BALDE_EVOLUTION,token:process.env.TOKEN,cwd:process.cwd()}));');
    writeFileSync(join(dir, '.env'), 'export TOKEN="segredo & <local>"\nBALDE_EVOLUTION=0\nBALDE_PORT=8192 # porta\n');
    assert.equal(lerAmbiente(dir).BALDE_PORT, '8192');
    const destino = join(temp, 'plist');
    const gerar = spawnSync(process.execPath, [cli, 'instalar', '--dir', dir, '--destino', destino], { encoding: 'utf8' });
    assert.equal(gerar.status, 0, gerar.stderr);
    const plist = join(destino, 'com.balde.servico.plist');
    const xml = readFileSync(plist, 'utf8');
    assert.ok(xml.includes('&amp; &quot;teste&quot;'));
    assert.ok(!xml.includes('segredo'));
    assert.ok(xml.includes(process.execPath));
    assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
    const lint = spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    console.log(lint.stdout.trim());
    const iniciar = () => spawnSync(process.execPath, [join(dir, 'deploy/iniciar.mjs'), dir], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(iniciar().stdout), { e: '1', token: 'segredo & <local>', cwd: realpathSync(dir) });
    writeFileSync(join(dir, '.env'), 'TOKEN=alterado\n');
    assert.equal(JSON.parse(iniciar().stdout).token, 'alterado');
    const remover = spawnSync(process.execPath, [cli, 'desinstalar', '--dir', dir, '--destino', destino], { encoding: 'utf8' });
    assert.equal(remover.status, 0, remover.stderr);
    assert.ok(!existsSync(plist));
    assert.equal(spawnSync(process.execPath, [cli, 'invalido']).status, 1);
    assert.equal(spawnSync(process.execPath, [cli, 'logs']).status, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('status consulta GET /api/tarefas na porta configurada', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'gb17-status-'));
  let consultado = false;
  const server = http.createServer((req, res) => { consultado = req.method === 'GET' && req.url === '/api/tarefas'; res.end('[]'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(join(temp, '.env'), `BALDE_PORT=${server.address().port}\nBALDE_HOST=0.0.0.0\n`);
    const child = spawn(process.execPath, [cli, 'status', '--dir', temp]);
    let saida = '';
    child.stdout.on('data', chunk => { saida += chunk; });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.ok(consultado);
    assert.match(saida, /Processo launchd:/);
    assert.match(saida, /HTTP 200 — acessível/);
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
});
