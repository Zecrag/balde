#!/usr/bin/env node
/**
 * @file simular.mjs — Roteiro de simulação de mensagens WhatsApp para o Balde.
 *
 * Roteiro de 5 passos:
 *   1. Pedido incompleto (Alfa Tech - Site)
 *   2. Complemento do pedido (Alfa Tech - Site)
 *   3. Mensagem de áudio (Alfa Tech - App)
 *   4. Documento PDF (Varejo Brasil - TI)
 *   5. Encaminhamento pessoal de razão social / boleto (Pessoal desenvolvedor / Padaria Modelo)
 *
 * Execução: node bin/simular.mjs
 */

const HOST = process.env.BALDE_HOST || '127.0.0.1';
const PORT = process.env.BALDE_PORT || 7391;
const BASE_URL = process.env.BALDE_URL || `http://${HOST}:${PORT}`;
const TOKEN = process.env.BALDE_WEBHOOK_TOKEN || 'balde-dev-token';

async function postarWebhook(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-token': TOKEN,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Falha no POST ${url}: status ${resp.status} - ${txt}`);
  }
  return await resp.json();
}

/**
 * Executa a simulação completa contra o servidor Balde.
 * @param {Object} [opcoes]
 * @param {string} [opcoes.baseUrl]
 * @returns {Promise<Array>} Lista de tarefas retornadas pela API após a simulação
 */
export async function rodarSimulacao(opcoes = {}) {
  const base = opcoes.baseUrl || BASE_URL;
  console.log(`\n🚀 [Simulador Balde] Iniciando simulação contra ${base}...\n`);

  // ─── 1. Pedido Incompleto ──────────────────────────────────────────────────
  console.log('1️⃣  Enviando pedido incompleto (Alfa Tech - Site)...');
  const msg1 = {
    event: 'messages.upsert',
    data: {
      key: { id: `sim-ped-incompleto-${Date.now()}`, remoteJid: '120363011111111111@g.us' },
      groupInfo: { subject: 'Alfa Tech - Site' },
      pushName: 'Carlos Gestor',
      message: {
        conversation: 'Olá desenvolvedor, precisamos atualizar o banner da home para a promoção até sexta-feira, mas ainda não fechamos os textos finais nem a imagem.',
      },
    },
  };
  await postarWebhook(`${base}/webhook/evolution`, msg1);
  console.log('   ↳ Enviado com sucesso (estado esperado: aguardando_info)');
  await new Promise(r => setTimeout(r, 200));

  // ─── 2. Complemento ────────────────────────────────────────────────────────
  console.log('2️⃣  Enviando complemento de informações (Alfa Tech - Site)...');
  const msg2 = {
    event: 'messages.upsert',
    data: {
      key: { id: `sim-complemento-${Date.now()}`, remoteJid: '120363011111111111@g.us' },
      groupInfo: { subject: 'Alfa Tech - Site' },
      pushName: 'Carlos Gestor',
      message: {
        conversation: 'desenvolvedor, definimos os textos do banner: "Black Friday Antecipada - 40% OFF". O link é /black-friday. Pode publicar!',
      },
    },
  };
  await postarWebhook(`${base}/webhook/evolution`, msg2);
  console.log('   ↳ Enviado com sucesso (tarefa transita para: pronta)');
  await new Promise(r => setTimeout(r, 200));

  // ─── 3. Áudio ──────────────────────────────────────────────────────────────
  console.log('3️⃣  Enviando mensagem de áudio (Alfa Tech - App)...');
  const msg3 = {
    event: 'messages.upsert',
    data: {
      key: { id: `sim-audio-${Date.now()}`, remoteJid: '120363022222222222@g.us' },
      groupInfo: { subject: 'Alfa Tech - App' },
      pushName: 'Mariana Desenvolvedora',
      messageType: 'audioMessage',
      message: {
        conversation: 'desenvolvedor, mandei áudio: o aplicativo está com lentidão crítica no checkout de compras em iOS, precisamos ver urgente.',
        audioMessage: {
          mimetype: 'audio/ogg',
          url: 'https://example.com/audio-simulado.ogg',
        },
      },
    },
  };
  await postarWebhook(`${base}/webhook/evolution`, msg3);
  console.log('   ↳ Enviado com sucesso');
  await new Promise(r => setTimeout(r, 200));

  // ─── 4. PDF ────────────────────────────────────────────────────────────────
  console.log('4️⃣  Enviando documento PDF (Varejo Brasil - TI)...');
  const msg4 = {
    event: 'messages.upsert',
    data: {
      key: { id: `sim-pdf-${Date.now()}`, remoteJid: '120363044444444444@g.us' },
      groupInfo: { subject: 'Varejo Brasil - TI' },
      pushName: 'Roberto Coordenador',
      messageType: 'documentMessage',
      message: {
        documentMessage: {
          title: 'especificacao-catalogo-v2.pdf',
          caption: 'Segue em anexo a especificação técnica completa do novo catálogo de produtos e integração da API até dia 20.',
          mimetype: 'application/pdf',
        },
      },
    },
  };
  await postarWebhook(`${base}/webhook/evolution`, msg4);
  console.log('   ↳ Enviado com sucesso');
  await new Promise(r => setTimeout(r, 200));

  // ─── 5. Encaminhamento Pessoal de Razão Social / Boleto ─────────────────────
  console.log('5️⃣  Enviando encaminhamento pessoal (Razão Social & Boleto)...');
  const msg5 = {
    id: `sim-pessoal-${Date.now()}`,
    texto: 'desenvolvedor, te encaminho os dados de faturamento da Padaria Modelo: Razão Social Modelo Panificação Ltda, CNPJ 98.765.432/0001-10. Segue o boleto de hospedagem para pagar amanhã.',
    de: 'desenvolvedor Pessoal',
    chatNome: 'Encaminhamentos Pessoais',
    origem: 'encaminhada',
  };
  await postarWebhook(`${base}/webhook/encaminhamento-manual`, msg5);
  console.log('   ↳ Enviado com sucesso');

  // Aguarda processamento assíncrono
  console.log('\n⏳ Aguardando processamento das micro-tarefas pelo Balde...');
  await new Promise(r => setTimeout(r, 600));

  // ─── Consulta API ──────────────────────────────────────────────────────────
  const respTarefas = await fetch(`${base}/api/tarefas`);
  if (!respTarefas.ok) {
    throw new Error(`Falha ao consultar /api/tarefas: ${respTarefas.status}`);
  }

  const { tarefas } = await respTarefas.json();
  console.log(`\n📋 [Painel / API] ${tarefas.length} tarefas encontradas no Balde:\n`);

  // Agrupa tarefas por empresa -> projeto
  const agrupado = {};
  for (const t of tarefas) {
    const chave = `${t.empresa || 'Sem Empresa'} → ${t.projeto || 'Geral'}`;
    if (!agrupado[chave]) agrupado[chave] = [];
    agrupado[chave].push(t);
  }

  for (const [grupo, lista] of Object.entries(agrupado)) {
    console.log(`🏢 ${grupo} (${lista.length} tarefa${lista.length > 1 ? 's' : ''}):`);
    for (const t of lista) {
      const estadoEmoji = {
        pronta: '✅',
        aguardando_info: '⏳',
        precisa_decisao: '❓',
        em_execucao: '⚙️',
        feita: '🎉',
      }[t.estado] || '🔹';

      console.log(`   ${estadoEmoji} [${t.estado.toUpperCase()}] ${t.titulo}`);
      console.log(`      • Urgência: ${t.urgencia}/100 | Prazo: ${t.prazo || 'Sem prazo'} | Resp: ${t.responsavel || 'ia'}`);
      if (t.faltando && t.faltando.length > 0) {
        console.log(`      • Faltando: ${t.faltando.join(', ')}`);
      }
    }
    console.log('');
  }

  return tarefas;
}

// Execução direta
const isMain = process.argv[1] && process.argv[1].endsWith('simular.mjs');
if (isMain) {
  rodarSimulacao().then(() => {
    console.log('✨ Simulação finalizada com sucesso!');
    process.exit(0);
  }).catch(err => {
    console.error('\n❌ Erro durante a simulação:', err.message);
    process.exit(1);
  });
}
