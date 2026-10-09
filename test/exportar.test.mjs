import test from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJETO_ROOT = path.resolve(__dirname, '..');

import os from 'node:os';

test('Exportação limpa funciona', (t) => {
  const destino = path.join(PROJETO_ROOT, '..', 'balde-app-teste-exportacao-' + Date.now());
  const gruposPath = path.join(PROJETO_ROOT, 'GRUPOS.md');
  const backupGrupos = fs.existsSync(gruposPath) ? fs.readFileSync(gruposPath, 'utf8') : null;
  const agentsPath = path.join(PROJETO_ROOT, '.agents');
  const nomesPath = path.join(PROJETO_ROOT, 'config', 'nomes-grupos.json');

  const tmpBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-test-export-'));
  const backupAgents = fs.existsSync(agentsPath) ? path.join(tmpBackupDir, '.agents') : null;
  const backupNomes = fs.existsSync(nomesPath) ? path.join(tmpBackupDir, 'nomes-grupos.json') : null;

  const gruposLimpo = backupGrupos ? backupGrupos.replace(/\|\s*Balde\s*\|\s*Balde\s*\|/g, '| | |') : null;

  try {
    if (backupAgents) fs.renameSync(agentsPath, backupAgents);
    if (backupNomes) fs.renameSync(nomesPath, backupNomes);
    if (gruposLimpo) fs.writeFileSync(gruposPath, gruposLimpo);

    const out = execSync(`node bin/exportar.mjs --destino ${destino}`, { cwd: PROJETO_ROOT, encoding: 'utf8' });
    assert.ok(out.includes('Nenhum vazamento detectado'));
    
    // Check if git is initialized
    assert.ok(fs.existsSync(path.join(destino, '.git')));
    assert.ok(fs.existsSync(path.join(destino, 'README.md')));
    assert.ok(!fs.existsSync(path.join(destino, 'dados')));
    assert.ok(!fs.existsSync(path.join(destino, '.env')));
    
  } finally {
    if (backupGrupos) fs.writeFileSync(gruposPath, backupGrupos);
    if (backupAgents && fs.existsSync(backupAgents)) fs.renameSync(backupAgents, agentsPath);
    if (backupNomes && fs.existsSync(backupNomes)) fs.renameSync(backupNomes, nomesPath);
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
    if (fs.existsSync(destino)) {
      fs.rmSync(destino, { recursive: true, force: true });
    }
  }
});
