#!/usr/bin/env node
/** Só leitura por padrão. Aplicação exige pares explícitos: --par filha:principal. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { candidatasComplemento, converterComplementos } from '../lib/motor/subitens.mjs';
const args = process.argv.slice(2), pares = [];
let aplicar = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--aplicar') aplicar = true;
  else if (args[i] === '--par' && args[i + 1]) {
    const [id, principalId, extra] = args[++i].split(':');
    if (!id || !principalId || extra) throw new Error('Par inválido: use filha:principal');
    pares.push({ id, principalId });
  } else throw new Error('Uso: converter-subitens.mjs [--aplicar --par filha:principal]');
}
const dados = process.env.BALDE_DADOS || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dados');
const arquivo = path.join(dados, 'tarefas.json');
const antes = fs.readFileSync(arquivo, 'utf8'), tarefas = JSON.parse(antes);
const candidatas = candidatasComplemento(tarefas);
if (!aplicar) {
  console.log(JSON.stringify({ modo: 'somente-leitura', total: candidatas.length, candidatas }, null, 2));
} else {
  if (!pares.length) throw new Error('--aplicar exige --par; nunca converte todas automaticamente');
  const resultado = converterComplementos(tarefas, pares);
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-subitens-backup-'));
  fs.cpSync(dados, path.join(backup, 'dados'), { recursive: true });
  if (fs.readFileSync(arquivo, 'utf8') !== antes) throw new Error('Dados mudaram durante backup; repita a revisão');
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(resultado, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, arquivo);
  console.log(JSON.stringify({ backup, convertidas: pares, candidatasRestantes: candidatasComplemento(resultado).length }, null, 2));
}
