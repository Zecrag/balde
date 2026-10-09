import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const padrao = fileURLToPath(new URL('../dados', import.meta.url));
// Literais AppleScript: remove controles e escapa barras/aspas antes de interpolar.
const esc = valor => String(valor || '').replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
export function iniciarNotificador({ dadosDir = process.env.BALDE_DADOS || padrao,
  _executor = args => execFile('osascript', args, { timeout: 10000 }, e => {
    if (e) console.error('Notificador:', e.message);
  }), _janelaMs = 30000 } = {}) {
  if (process.env.BALDE_NOTIFICAR === '0') return { parar() {} };
  fs.mkdirSync(dadosDir, { recursive: true });
  const arquivo = path.join(dadosDir, 'tarefas.json');
  function ler() {
    try { const valor = JSON.parse(fs.readFileSync(arquivo, 'utf8')); return Array.isArray(valor) ? valor : null; }
    catch { return null; }
  }
  let anteriores = new Map((ler() || []).map(t => [t.id, t.estado]));
  const fila = new Map();
  let timer;
  function observar() {
    const tarefas = ler();
    if (!tarefas) return; // Escrita parcial não apaga o snapshot anterior.
    for (const t of tarefas) {
      if ((!anteriores.has(t.id) && ['pronta', 'precisa_decisao'].includes(t.estado)) ||
        (anteriores.has(t.id) && anteriores.get(t.id) !== t.estado && t.estado === 'precisa_decisao')) fila.set(t.id, t);
    }
    anteriores = new Map(tarefas.map(t => [t.id, t.estado]));
    if (!fila.size || timer) return;
    // Janela fixa desde o primeiro evento: uma única notificação por rajada de 30s.
    timer = setTimeout(() => {
      timer = null;
      const lote = [...fila.values()];
      fila.clear();
      const texto = lote.length === 1 ? esc(lote[0].titulo) : '';
      const titulo = lote.length === 1 ? esc(`${lote[0].empresa || '-'} · ${lote[0].projeto || '-'}`) : `${lote.length} tarefas novas`;
      try {
        const resultado = _executor(['-e', `display notification "${texto}" with title "${titulo}"`]);
        resultado?.catch?.(e => console.error('Notificador:', e.message));
      } catch (e) { console.error('Notificador:', e.message); }
    }, _janelaMs);
  }
  const watcher = fs.watch(dadosDir, (_, nome) => { if (!nome || nome === 'tarefas.json') observar(); });
  observar();
  return { parar() { watcher.close(); clearTimeout(timer); fila.clear(); } };
}
