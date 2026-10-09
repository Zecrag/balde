import test from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJETO_ROOT = path.resolve(__dirname, '..');

test('Exportação limpa funciona', (t) => {
  const destino = path.join(PROJETO_ROOT, '..', 'balde-app-teste-exportacao-' + Date.now());
  try {
    const out = execSync(`node bin/exportar.mjs --destino ${destino}`, { cwd: PROJETO_ROOT, encoding: 'utf8' });
    assert.ok(out.includes('Nenhum vazamento detectado'));
    
    // Check if git is initialized
    assert.ok(fs.existsSync(path.join(destino, '.git')));
    assert.ok(fs.existsSync(path.join(destino, 'README.md')));
    assert.ok(!fs.existsSync(path.join(destino, 'dados')));
    assert.ok(!fs.existsSync(path.join(destino, '.env')));
    
  } finally {
    if (fs.existsSync(destino)) {
      fs.rmSync(destino, { recursive: true, force: true });
    }
  }
});
