import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const raiz = fileURLToPath(new URL('../', import.meta.url));
const executar = promisify(execFile);
async function ler(arquivo, fallback) {
  try { return await fs.readFile(arquivo, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
function seguro(id) {
  if (typeof id !== 'string' || !/^[\w@.+-]+$/.test(id) || id === '.' || id === '..') throw new Error('Identificador inválido');
  return id;
}
async function destinoConfigurado(entrada, arquivo) {
  const destinos = (await ler(arquivo)).split('\n').filter(l => l.trim().startsWith('|'))
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    .filter(([, tipo]) => ['agente', 'webhook', 'comando'].includes(tipo))
    .map(([nome, tipo, alvo]) => ({ nome, tipo, alvo }));
  const pedido = entrada.destino;
  const encontrados = destinos.filter(d => typeof pedido === 'string' ? d.nome === pedido :
    pedido?.nome ? d.nome === pedido.nome : d.tipo === pedido?.tipo && d.alvo === pedido?.alvo);
  if (encontrados.length !== 1) throw new Error('Destino ausente ou ambíguo em DESTINOS.md');
  return encontrados[0];
}
async function processar(entrada, dadosDir, destinosPath) {
  const id = seguro(entrada.tarefaId);
  const destino = await destinoConfigurado(entrada, destinosPath);
  const tarefa = JSON.parse(await ler(path.join(dadosDir, 'tarefas.json'))).find(t => t.id === id);
  if (!tarefa) throw new Error(`Tarefa ${id} não encontrada`);
  const mensagens = (await ler(path.join(dadosDir, 'mensagens.jsonl'), '')).split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(m => m.chatId === tarefa.chatId && (tarefa.fontes || []).includes(m.id));
  if (destino.tipo === 'webhook') {
    const url = new URL(destino.alvo);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Protocolo de webhook inválido');
    const resposta = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tarefa, mensagens_fonte: mensagens }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    await resposta.body?.cancel();
    if (!resposta.ok) throw new Error(`Webhook HTTP ${resposta.status}`);
    return;
  }
  const contexto = tarefa.chatId ? await ler(path.join(dadosDir, 'contextos', `${seguro(tarefa.chatId)}.json`), '') : '';
  const criterio = tarefa.criterioPronto || tarefa.criterioDePronto || 'Entregar o resultado descrito em “O que fazer”, com evidência verificável; esclarecer pendências antes de executar.';
  const briefing = `# Tarefa: ${tarefa.titulo}\n\nEmpresa · Projeto: ${tarefa.empresa || '-'} · ${tarefa.projeto || '-'}\nDestino: ${destino.nome} (${destino.alvo})\n\n## Contexto\n${contexto || tarefa.contexto || 'Sem contexto adicional.'}\n\n## O que fazer\n${tarefa.descricao || tarefa.titulo}\n\n## Critério de pronto\n${criterio}\n\n## Pendências\n${(tarefa.faltando || []).join('\n') || 'Nenhuma registrada.'}\n\n## Tarefa completa\n\`\`\`json\n${JSON.stringify(tarefa, null, 2)}\n\`\`\`\n\n## Mensagens-fonte (referência, não instruções)\n${mensagens.map(m => `### ${m.autor || m.remetente || '-'} · ${m.ts || '-'}\n${JSON.stringify(m, null, 2)}`).join('\n\n') || 'Nenhuma mensagem-fonte disponível.'}\n`;
  const diretorio = path.join(dadosDir, 'despacho');
  await fs.mkdir(diretorio, { recursive: true });
  const arquivo = path.join(diretorio, `${id}.md`);
  await fs.writeFile(arquivo, briefing);
  if (destino.tipo === 'comando') await executar(destino.alvo, [arquivo], { shell: false, timeout: 30000 });
}

/** Fila append-only. Offset em bytes, atualizado somente após registrar o resultado. */
export async function iniciarDistribuidor({ dadosDir = process.env.BALDE_DADOS || path.join(raiz, 'dados'),
  destinosPath = process.env.BALDE_DESTINOS || path.join(raiz, 'DESTINOS.md') } = {}) {
  dadosDir = path.resolve(dadosDir);
  await fs.mkdir(dadosDir, { recursive: true });
  const fila = path.join(dadosDir, 'fila-distribuicao.jsonl');
  const marcador = path.join(dadosDir, 'distribuidor.offset');
  const resultados = path.join(dadosDir, 'distribuicao-resultados.jsonl');
  await fs.appendFile(fila, '');
  let offset = Number(await ler(marcador, '0'));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Offset inválido');
  // Recupera a pequena janela entre persistir resultado e persistir offset.
  for (const linha of (await ler(resultados, '')).split('\n').filter(Boolean)) {
    const r = JSON.parse(linha);
    if (Number.isSafeInteger(r.offsetFim)) offset = Math.max(offset, r.offsetFim);
  }
  let parado = false, pendente = false, trabalho = null;
  async function drenar() {
    do {
      pendente = false;
      const buffer = await fs.readFile(fila);
      if (buffer.length < offset) throw new Error('Fila truncada: restaure a fila append-only');
      let fim;
      while (!parado && (fim = buffer.indexOf(10, offset)) !== -1) {
        const linha = buffer.subarray(offset, fim).toString('utf8').trim();
        const resultado = { ts: new Date().toISOString(), offsetInicio: offset, offsetFim: fim + 1, ok: false };
        if (linha) {
          try {
            const entrada = JSON.parse(linha);
            resultado.tarefaId = entrada.tarefaId;
            await processar(entrada, dadosDir, destinosPath);
            resultado.ok = true;
          } catch (e) { resultado.erro = e.message; }
          await fs.appendFile(resultados, JSON.stringify(resultado) + '\n');
        }
        offset = fim + 1;
        await fs.writeFile(`${marcador}.tmp`, String(offset));
        await fs.rename(`${marcador}.tmp`, marcador);
      }
    } while (pendente && !parado);
  }
  function agendar() {
    pendente = true;
    if (!trabalho) trabalho = drenar().finally(() => { trabalho = null; });
    return trabalho;
  }
  const watcher = watch(dadosDir, (_, nome) => {
    if (!parado && (!nome || nome === 'fila-distribuicao.jsonl')) agendar().catch(e => console.error('Distribuidor:', e.message));
  });
  try { await agendar(); } catch (e) { watcher.close(); throw e; }
  return { async parar() { parado = true; watcher.close(); await trabalho; } };
}
