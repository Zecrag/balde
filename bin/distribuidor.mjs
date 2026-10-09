#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iniciarDistribuidor } from '../lib/distribuidor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const dadosDir = process.env.BALDE_DADOS || path.join(ROOT, 'dados');
const destinosPath = process.env.BALDE_DESTINOS || path.join(ROOT, 'DESTINOS.md');

console.log(`[Distribuidor] Iniciando... (dadosDir: ${dadosDir})`);

iniciarDistribuidor({ dadosDir, destinosPath })
  .then((dist) => {
    console.log('[Distribuidor] Rodando. Pressione Ctrl+C para parar.');
    for (const sinal of ['SIGINT', 'SIGTERM']) process.once(sinal, async () => {
      console.log('\n[Distribuidor] Parando...');
      await dist.parar();
    });
  })
  .catch((err) => {
    console.error('[Distribuidor] Erro fatal:', err);
    process.exit(1);
  });
