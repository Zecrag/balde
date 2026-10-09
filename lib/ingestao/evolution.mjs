import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizar } from './normalizar.mjs';
import { carregarGruposAutorizados, grupoAutorizado } from './autorizacao.mjs';
import { lerCursor, gravarCursor, depoisDoCursor, avancarCursor, tsSegundos } from './evolution-cursor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const getBaseDados = () => process.env.BALDE_DADOS || path.resolve(__dirname, '../../dados');

const seenIds = new Set();
const processandoIds = new Set();
let wsObj = null;
let pingIntervalId = null;

// Carregar .env


// Grupos autorizados: lib/ingestao/autorizacao.mjs (respeita BALDE_CONFIG, como lib/config.mjs)
const loadGruposAutorizados = carregarGruposAutorizados;

async function garantirWebSocketConfigurado(url, key, inst) {
    const resGet = await fetch(`${url}/websocket/find/${inst}`, { headers: { apikey: key } });
    if (resGet.ok) {
        const data = await resGet.json().catch(() => null);
        let events = data?.events || [];
        const enabled = data?.enabled;
        
        if (!enabled || !events.includes('MESSAGES_UPSERT')) {
            // Mexer na config da instância é opt-in: sem BALDE_EVOLUTION_ATIVAR_WS=1 só avisa
            if (process.env.BALDE_EVOLUTION_ATIVAR_WS !== '1') {
                console.warn('[ingestao/evolution] WebSocket da Evolution sem MESSAGES_UPSERT; defina BALDE_EVOLUTION_ATIVAR_WS=1 para ativar automaticamente.');
                return;
            }
            const newEvents = new Set([...events, 'MESSAGES_UPSERT']);
            await fetch(`${url}/websocket/set/${inst}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key },
                body: JSON.stringify({ enabled: true, events: [...newEvents] })
            });
            console.log('[ingestao/evolution] WebSocket ativado/atualizado na Evolution.');
        }
    }
}

async function processarMensagemPayload(payload, opcoes) {
    // payload é o evento da evolution: { instance, data: <mensagem> } (v2) ou { data: { messages: [<mensagem>] } }
    const msgData = payload?.data?.messages?.[0] ?? payload?.data;
    const remoteJid = msgData?.key?.remoteJid;
    if (!remoteJid || !remoteJid.endsWith('@g.us')) return; // Só grupos
    
    // Verificar se o grupo está autorizado
    if (!(await grupoAutorizado(remoteJid))) return; // descarta se não autorizado
    
    // WebSocket e catch-up podem entregar a mesma mensagem ao mesmo tempo
    const chave = msgData.key.id;
    if (chave && processandoIds.has(chave)) return;
    if (chave) processandoIds.add(chave);
    
    try {
        // normalizar espera { data: <mensagem> } para ler key.id / remoteJid / messageTimestamp
        const mensagem = await normalizar({ data: msgData }, 'evolution', { midiaDir: opcoes.midiaDir });
        if (!mensagem || !mensagem.id || seenIds.has(mensagem.id)) return;
        seenIds.add(mensagem.id);
        
        const mensagensPath = opcoes.mensagensPath || path.join(getBaseDados(), 'mensagens.jsonl');
        await fs.appendFile(mensagensPath, JSON.stringify(mensagem) + '\n', 'utf8');
        
        if (opcoes.store) {
            if (typeof opcoes.store.gravarMensagem === 'function') await opcoes.store.gravarMensagem(mensagem);
            else if (typeof opcoes.store.salvarMensagem === 'function') await opcoes.store.salvarMensagem(mensagem);
        }
        
        // Pipeline
        let msgProcessar = mensagem;
        if (typeof opcoes.enriquecer === 'function') {
            const enr = await opcoes.enriquecer(msgProcessar);
            if (enr) msgProcessar = enr;
        }
        if (typeof opcoes.processar === 'function') {
            await opcoes.processar(msgProcessar);
        }
    } catch (e) {
        console.error('[ingestao/evolution] Erro ao processar:', e);
    } finally {
        if (chave) processandoIds.delete(chave);
    }
}

// ---- Catch-up paginado (Mac desligado / WebSocket fora) ------------------------------

const PAGINA = 50;          // offset por página no /chat/findMessages
const MAX_PAGINAS = 200;    // por grupo e por ciclo (10 mil mensagens)

const numeroEnv = (nome, padrao) => {
    const n = Number(process.env[nome]);
    return Number.isFinite(n) && n > 0 ? n : padrao;
};

let sincronizacaoAtual = null;

/**
 * Um ciclo de catch-up: para cada grupo autorizado, pagina /chat/findMessages
 * (mais recentes primeiro) até alcançar o cursor do grupo e processa o que faltou
 * em ordem cronológica crescente, avançando dados/evolution-cursor.json.
 * Grupo sem cursor: só os últimos BALDE_CATCHUP_DIAS (padrão 15).
 * Teto por ciclo: BALDE_CATCHUP_TETO (padrão 500) — o resto fica para o próximo ciclo.
 * @returns {Promise<{processadas: number, pendentes: string[]}>}
 */
export function sincronizarEvolution({ url, key, inst, opcoes = {}, agora = Date.now() }) {
    // Nunca dois ciclos ao mesmo tempo (polling + reconexão do WebSocket)
    if (!sincronizacaoAtual) {
        sincronizacaoAtual = executarSincronizacao({ url, key, inst, opcoes, agora })
            .finally(() => { sincronizacaoAtual = null; });
    }
    return sincronizacaoAtual;
}

/** Uma página de /chat/findMessages do grupo (mais recentes primeiro). */
export async function buscarPagina(url, key, inst, jid, page) {
    const res = await fetch(`${url}/chat/findMessages/${inst}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key },
        body: JSON.stringify({ where: { key: { remoteJid: jid } }, page, offset: PAGINA })
    });
    if (!res.ok) throw new Error(`findMessages HTTP ${res.status}`);
    const data = await res.json();
    return { records: data?.messages?.records || [], pages: Number(data?.messages?.pages) || 1 };
}

async function executarSincronizacao({ url, key, inst, opcoes, agora }) {
    const teto = numeroEnv('BALDE_CATCHUP_TETO', 500);
    const dias = numeroEnv('BALDE_CATCHUP_DIAS', 15);
    const cursorPath = opcoes.cursorPath || path.join(getBaseDados(), 'evolution-cursor.json');
    const piso = Math.floor(agora / 1000) - Math.round(dias * 86400);
    const cursor = await lerCursor(cursorPath);
    const grupos = await loadGruposAutorizados();
    let orcamento = teto;
    let processadas = 0;
    const pendentes = [];

    for (const { jid } of grupos) {
        if (orcamento <= 0) { pendentes.push(jid); continue; }
        const entrada = cursor[jid];
        const novas = new Map(); // key.id → { r, ts, id } (páginas podem repetir se chegar mensagem no meio)
        try {
            for (let page = 1; page <= MAX_PAGINAS; page++) {
                const { records, pages } = await buscarPagina(url, key, inst, jid, page);
                let alcancou = false;
                for (const r of records) {
                    const ts = tsSegundos(r.messageTimestamp);
                    const id = r.key?.id;
                    if (ts === null || !id || r.key?.remoteJid !== jid) continue;
                    const nova = entrada ? depoisDoCursor(entrada, ts, id) : ts >= piso;
                    if (nova) novas.set(id, { r, ts, id });
                    else alcancou = true;
                }
                if (alcancou || records.length === 0 || page >= pages) break;
                if (page === MAX_PAGINAS) {
                    console.warn(`[ingestao/evolution] Catch-up de ${jid}: ${MAX_PAGINAS} páginas sem alcançar o cursor; seguindo do mais antigo encontrado.`);
                }
            }
        } catch (e) {
            // Sem a lista completa não dá para garantir a ordem: tenta o grupo no próximo ciclo
            console.error(`[ingestao/evolution] Catch-up de ${jid} falhou: ${e.message}`);
            pendentes.push(jid);
            continue;
        }

        const fila = [...novas.values()].sort((a, b) => a.ts - b.ts);
        if (fila.length > orcamento) {
            console.warn(`[ingestao/evolution] Catch-up: teto de ${teto} mensagens por ciclo atingido em ${jid}; ${fila.length - orcamento} ficam para o próximo ciclo.`);
            pendentes.push(jid);
        }
        for (const { r, ts, id } of fila.slice(0, orcamento)) {
            await processarMensagemPayload({ data: r }, opcoes);
            avancarCursor(cursor, jid, ts, id);
            await gravarCursor(cursorPath, cursor);
            orcamento--;
            processadas++;
        }
        // Grupo novo sem nada na janela: fixa o piso para um downtime longo não perder o intervalo
        if (!cursor[jid]) {
            cursor[jid] = { ts: piso, ids: [] };
            await gravarCursor(cursorPath, cursor);
        }
    }
    if (processadas > 0) console.log(`[ingestao/evolution] Catch-up: ${processadas} mensagem(ns) recuperada(s).`);
    return { processadas, pendentes };
}

function conectarWebSocket(url, key, inst, opcoes, tentativa = 1) {
    if (stopRequested) return;
    if (consecutiveFailures >= 3) {
        if (!pollingId) fallbackPolling(url, key, inst, opcoes);
        setTimeout(() => { consecutiveFailures = 0; conectarWebSocket(url, key, inst, opcoes); }, 10 * 60 * 1000);
        return;
    }
    const wsUrl = new URL(url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/socket.io/';
    wsUrl.searchParams.set('EIO', '4');
    wsUrl.searchParams.set('transport', 'websocket');
    
    if (consecutiveFailures < 3) console.log(`[ingestao/evolution] Conectando WebSocket: ${wsUrl.href} (namespace /${inst})`);
    wsObj = new WebSocket(wsUrl.href);
    
    let connected = false;
    let closed = false;

    const connectionTimeout = setTimeout(() => {
        if (!connected && !closed) {
            if (consecutiveFailures < 3) console.error('[ingestao/evolution] WebSocket timeout sem conexão.');
            if (wsObj) wsObj.close();
            if (!pollingId) fallbackPolling(url, key, inst, opcoes);
        }
    }, 10000);
    
    wsObj.onopen = () => {
        // Aguarda pacote inicial do socket.io
    };
    
    wsObj.onmessage = async (evt) => {
        const msg = evt.data.toString();
        if (msg.startsWith('0')) {
            connected = true;
            clearTimeout(connectionTimeout);
            const handshake = JSON.parse(msg.slice(1));
            wsObj.send('40/' + inst + ',');
            pingIntervalId = setInterval(() => {
                if (wsObj.readyState === WebSocket.OPEN) wsObj.send('2');
            }, handshake.pingInterval || 25000);
        } else if (msg.startsWith('40/' + inst)) {
            console.log(`[ingestao/evolution] WebSocket conectado (namespace /${inst}).`);
            if (pollingId) {
                console.log('[ingestao/evolution] Desativando polling (WebSocket assumiu).');
                clearInterval(pollingId);
                pollingId = null;
            }
            tentativa = 1; consecutiveFailures = 0; // reset backoff
            cicloCatchup(url, key, inst, opcoes); // cobre o intervalo em que o WebSocket ficou fora
        } else if (msg.startsWith('42/' + inst + ',')) {
            try {
                const parts = JSON.parse(msg.slice(4 + inst.length));
                const eventName = parts[0];
                const eventData = parts[1];
                if (eventName === 'messages.upsert' || eventName === 'MESSAGES_UPSERT') {
                    await processarMensagemPayload(eventData, opcoes);
                }
            } catch (e) {
                console.error('[ingestao/evolution] Erro ao parsear ws event', e);
            }
        }
    };
    
    wsObj.onclose = () => {
        consecutiveFailures++;
        if (closed) return;
        closed = true;
        clearTimeout(connectionTimeout);
        if (consecutiveFailures < 3) console.log('[ingestao/evolution] WebSocket fechado.');
        if (pingIntervalId) clearInterval(pingIntervalId);
        
        if (!connected && !pollingId) {
             fallbackPolling(url, key, inst, opcoes);
        }
        
        const backoff = Math.min(10000 * tentativa, 60000);
        if (consecutiveFailures < 3) console.log(`[ingestao/evolution] Reconectando WS em ${backoff/1000}s...`);
        setTimeout(() => conectarWebSocket(url, key, inst, opcoes, tentativa + 1), backoff);
    };
    
    wsObj.onerror = (e) => {
        if (consecutiveFailures < 3) console.error('[ingestao/evolution] WebSocket erro:', e.message);
        if (!connected && !pollingId) {
            fallbackPolling(url, key, inst, opcoes);
        }
        // Force onclose logic if it hasn't fired
        setTimeout(() => {
            if (!closed && wsObj.readyState === WebSocket.CLOSED) {
                if (typeof wsObj.onclose === 'function') wsObj.onclose();
            }
        }, 1000);
    };
}

let pollingId = null;
let varreduraId = null;
let consecutiveFailures = 0;
let stopRequested = false;

const VARREDURA_MS = 5 * 60 * 1000; // catch-up periódico mesmo com WebSocket ativo
const PENDENTE_MS = 15000;          // ciclo seguinte quando o teto deixou mensagens para trás

export function pararEvolution() {
    stopRequested = true;
    if (wsObj) wsObj.close();
    if (pollingId) clearInterval(pollingId);
    if (varreduraId) clearTimeout(varreduraId);
    if (pingIntervalId) clearInterval(pingIntervalId);
}

/** Roda um ciclo de catch-up e agenda o próximo (logo, se ficou pendência; senão, varredura). */
async function cicloCatchup(url, key, inst, opcoes) {
    if (stopRequested) return;
    if (varreduraId) { clearTimeout(varreduraId); varreduraId = null; }
    let pendentes = [];
    try {
        ({ pendentes } = await sincronizarEvolution({ url, key, inst, opcoes }));
    } catch (e) {
        console.error('[ingestao/evolution] Catch-up erro:', e.message);
    }
    if (stopRequested) return;
    varreduraId = setTimeout(() => cicloCatchup(url, key, inst, opcoes), pendentes.length ? PENDENTE_MS : VARREDURA_MS);
}

async function fallbackPolling(url, key, inst, opcoes) {
    if (pollingId) return;
    if (consecutiveFailures <= 3) console.log('[ingestao/evolution] Iniciando fallback polling.');
    console.log('[ingestao/evolution] polling ativo.');
    
    pollingId = setInterval(async () => {
        try {
            await sincronizarEvolution({ url, key, inst, opcoes });
        } catch (e) {
            console.error('[ingestao/evolution] Polling erro:', e.message);
        }
    }, 15000);
}

export async function iniciarEvolution(opcoes = {}) {
    
    const url = process.env.BALDE_EVOLUTION_URL;
    const key = process.env.BALDE_EVOLUTION_KEY;
    const inst = process.env.BALDE_EVOLUTION_INSTANCIA;
    
    if (!url || !key || !inst) {
        console.log('[ingestao/evolution] Variáveis de ambiente Evolution ausentes, pulando.');
        return;
    }
    
    // Ler ids já vistos para não duplicar
    const mensagensPath = opcoes.mensagensPath || path.join(getBaseDados(), 'mensagens.jsonl');
    if (existsSync(mensagensPath)) {
        try {
            const lines = (await fs.readFile(mensagensPath, 'utf8')).split('\n');
            for (const l of lines) {
                if (l.trim()) {
                    try {
                        const j = JSON.parse(l);
                        if (j.id) seenIds.add(j.id);
                    } catch {}
                }
            }
        } catch {}
    }

    // Recupera o que chegou com o Mac desligado (e segue varrendo a cada 5 min)
    cicloCatchup(url, key, inst, opcoes);

    try {
        await garantirWebSocketConfigurado(url, key, inst);
        
        // Verifica suporte a WebSocket (Node 21+ ou import ws)
        if (typeof WebSocket !== 'undefined') {
            conectarWebSocket(url, key, inst, opcoes);
        } else {
            console.warn('[ingestao/evolution] WebSocket global não encontrado (use Node >= 21). Usando polling.');
            fallbackPolling(url, key, inst, opcoes);
        }
    } catch (e) {
        console.error('[ingestao/evolution] Erro inicial:', e);
        fallbackPolling(url, key, inst, opcoes);
    }
}
