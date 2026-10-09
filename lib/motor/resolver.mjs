/**
 * resolver.mjs — Resolve empresa e projeto a partir de chatId/chatNome.
 *
 * Aceita dois formatos de clientes.json:
 *   A) Flat (repo):   [{ empresa, projeto, grupos: [nome|chatId|regex], receitaMensal, pesoUrgencia }]
 *   B) Nested (motor): [{ empresa, projetos: [{ nome, chatId, chatNome }], receitaMensal, pesoUrgencia }]
 *
 * Estratégia de match:
 *   1. chatId exato → match direto
 *   2. chatNome contém nome do grupo/projeto → match por nome
 *   3. Nome do grupo no padrão "Empresa - Projeto" (ou "Projeto - Empresa" se um
 *      lado for empresa conhecida) → fallback pelo nome
 *   4. Texto menciona empresa conhecida → inferência
 *   5. Sem match → empresa "?", projeto "?"
 */

/**
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @param {Array} clientes — array de ClienteConfig (flat ou nested)
 * @returns {{ empresa: string, projeto: string, receitaMensal: number, pesoUrgencia: number, tipoGrupo: string }}
 */
export function resolverEmpresaProjeto(mensagem, clientes) {
  const { chatId, chatNome, texto } = mensagem;
  const norm = clientes.map(c => normalizarCliente(c));

  // 1. Match por chatId exato
  for (const cliente of norm) {
    for (const proj of cliente.projetos) {
      if (proj.chatId === chatId) {
        return resultado(cliente, proj);
      }
    }
  }

  // 2. Match por nome de grupo (chatNome contém nome do projeto ou chatNome do projeto)
  const nomeNorm = normalizar(chatNome);
  const nomeEstruturado = partesDoNome(chatNome).length === 2;
  for (const cliente of norm) {
    for (const proj of cliente.projetos) {
      const projetoNorm  = normalizar(proj.nome);
      const chatNomeProj = normalizar(proj.chatNome || '');

      // Match nos nomes dos grupos configurados
      for (const grupoNome of proj.gruposNomes) {
        const grupoNorm = normalizar(grupoNome);
        if (nomeNorm && grupoNorm && nomeNorm.includes(grupoNorm)) {
          return resultado(cliente, proj);
        }
      }

      // Só o nome do projeto ("Site") é fraco demais para um grupo "Empresa - Projeto"
      // de outra empresa ("Alfa Tech - Site") — esse cai no fallback pelo nome.
      if (nomeNorm && projetoNorm && !nomeEstruturado && nomeNorm.includes(projetoNorm)) {
        return resultado(cliente, proj);
      }
      if (nomeNorm && chatNomeProj && nomeNorm.includes(chatNomeProj)) {
        return resultado(cliente, proj);
      }
    }
  }

  // 3. Fallback pelo nome do grupo: "Empresa - Projeto" / "Projeto - Empresa"
  const peloNome = resolverPeloNomeDoGrupo(chatNome, norm);
  if (peloNome) return peloNome;

  // 4. Inferência por texto (origem pessoal/encaminhada)
  const textoNorm = normalizar(texto);
  for (const cliente of norm) {
    const empresaNorm = normalizar(cliente.empresa);
    if (textoNorm.includes(empresaNorm)) {
      // Tenta achar o projeto específico no texto
      for (const proj of cliente.projetos) {
        const projetoNorm = normalizar(proj.nome);
        if (textoNorm.includes(projetoNorm)) {
          return resultado(cliente, proj);
        }
      }
      // Empresa sim, projeto não → retorna primeiro projeto ou "?"
      const proj = cliente.projetos[0];
      return {
        empresa:       cliente.empresa,
        projeto:       proj ? proj.nome : '?',
        receitaMensal: cliente.receitaMensal ?? 0,
        pesoUrgencia:  cliente.pesoUrgencia  ?? 1,
        tipoGrupo:     proj?.tipoGrupo || cliente.tipoGrupo,
      };
    }
  }

  // 5. Sem match
  return { empresa: '?', projeto: '?', receitaMensal: 0, pesoUrgencia: 1, tipoGrupo: 'cliente' };
}

/** Separador "Empresa - Projeto": hífen, en/em dash ou barra vertical com espaço em volta. */
const SEPARADOR_GRUPO = /\s+[-–—|]\s+/;

function partesDoNome(chatNome) {
  return (chatNome || '').split(SEPARADOR_GRUPO).map(p => p.trim()).filter(Boolean);
}

/**
 * Grupo fora da config: tenta "Empresa - Projeto". Se um dos lados for empresa
 * conhecida, ele vira a empresa (cobre "Projeto - Empresa") e herda receita/peso.
 * @returns {ReturnType<typeof resultado> | null}
 */
function resolverPeloNomeDoGrupo(chatNome, clientesNorm) {
  const partes = partesDoNome(chatNome);
  if (partes.length !== 2) return null;

  for (const [empresa, projeto] of [partes, [partes[1], partes[0]]]) {
    const cliente = clientesNorm.find(c => normalizar(c.empresa) === normalizar(empresa));
    if (cliente) {
      return {
        empresa:       cliente.empresa,
        projeto,
        receitaMensal: cliente.receitaMensal ?? 0,
        pesoUrgencia:  cliente.pesoUrgencia  ?? 1,
        tipoGrupo:     cliente.tipoGrupo,
      };
    }
  }

  return { empresa: partes[0], projeto: partes[1], receitaMensal: 0, pesoUrgencia: 1, tipoGrupo: 'cliente' };
}

// ─── Normalização de formato de config ──────────────────────────

/**
 * Converte um registro de config (flat ou nested) para formato interno normalizado.
 */
function normalizarCliente(c) {
  // Formato nested (motor): { empresa, projetos: [{nome, chatId, chatNome}] }
  if (Array.isArray(c.projetos)) {
    return {
      empresa:       c.empresa,
      receitaMensal: c.receitaMensal ?? 0,
      pesoUrgencia:  c.pesoUrgencia  ?? 1,
      tipoGrupo:     tipoGrupoDe(c),
      projetos:      c.projetos.map(p => ({
        nome:        p.nome,
        tipoGrupo:   p.tipoTicket || p.tipo || '',
        chatId:      p.chatId || '',
        chatNome:    p.chatNome || '',
        gruposNomes: [p.chatNome, p.nome].filter(Boolean),
      })),
    };
  }

  // Formato flat (repo): { empresa, projeto, grupos: [nome|chatId|regex] }
  const grupos = c.grupos || [];
  const chatIds = grupos.filter(g => g.includes('@'));
  const nomes   = grupos.filter(g => !g.includes('@'));

  return {
    empresa:       c.empresa,
    receitaMensal: c.receitaMensal ?? 0,
    pesoUrgencia:  c.pesoUrgencia  ?? 1,
    tipoGrupo:     tipoGrupoDe(c),
    projetos: [{
      nome:        c.projeto,
      chatId:      chatIds[0] || '',
      chatNome:    nomes[0] || '',
      gruposNomes: nomes,
    }],
  };
}

function resultado(cliente, proj) {
  return {
    empresa:       cliente.empresa,
    projeto:       proj.nome,
    receitaMensal: cliente.receitaMensal ?? 0,
    pesoUrgencia:  cliente.pesoUrgencia  ?? 1,
    tipoGrupo:     proj.tipoGrupo || cliente.tipoGrupo,
  };
}

/** Tipo do grupo vindo do GRUPOS.md (coluna Tipo → tipoTicket). Padrão: cliente. */
function tipoGrupoDe(c) {
  return c.tipoTicket || c.tipoGrupo || c.tipo || 'cliente';
}

function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}
