/* ============================================================
   Maestro — DATA (Postgres → estimadores reais → Motor de PO)
   ------------------------------------------------------------
   Lê do Postgres (paginado), cacheia em memória e calcula os
   estimadores REAIS por canal/horário/SKU que alimentam o Motor.
   Filtra por origem (campo|piloto) para o observado-vs-fornecido.
   ============================================================ */
(function (global) {
  'use strict';
  const sb = () => global.sb;
  const M = () => global.Motor;
  const HORAS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
  const CANAIS = ['balcao', 'totem', 'drive-thru'];

  const cache = { filas: null, estoque: null, consumo: null, pert: null, jpay: null, jcen: null, precos: null, projetos: null, funcionarios: null };

  // busca paginada (Supabase limita ~1000 por request)
  async function fetchAll(table, cols, onProgress) {
    cols = cols || '*'; const page = 1000; let from = 0, out = [];
    for (; ;) {
      const { data, error } = await sb().from(table).select(cols).range(from, from + page - 1);
      if (error) throw new Error(table + ': ' + error.message);
      out = out.concat(data);
      if (onProgress) onProgress(out.length);
      if (data.length < page) break;
      from += page;
    }
    return out;
  }

  async function loadAll(onProgress) {
    onProgress = onProgress || (() => {});
    onProgress('Carregando filas…');
    cache.filas = await fetchAll('filas_atendimentos',
      'canal,hora,dia_semana,tempo_servico_min,intervalo_chegada_min,timestamp_chegada,perfil_totem,atendentes_efetivos,origem',
      n => onProgress(`filas: ${n}`));
    onProgress('Carregando estoque/consumo…');
    cache.estoque = await fetchAll('estoque');
    cache.consumo = await fetchAll('consumo', 'sku,semana,consumo_unidades,origem');
    onProgress('Carregando PERT/jogos…');
    cache.pert = await fetchAll('pert_atividades');
    cache.jpay = await fetchAll('jogos_payoffs');
    cache.jcen = await fetchAll('jogos_cenarios');
    cache.precos = await fetchAll('jogos_precos');
    cache.projetos = await fetchAll('projetos');
    cache.funcionarios = await fetchAll('funcionarios');
    onProgress('Dados prontos.');
    return cache;
  }

  const has = () => cache.filas !== null;

  /* ----------------------- FILAS: estimadores reais ----------------------- */
  function filasFiltradas(origem, canal, hora) {
    return cache.filas.filter(r =>
      (!origem || r.origem === origem) &&
      (!canal || r.canal === canal) &&
      (hora == null || r.hora === hora) &&
      r.tempo_servico_min != null);
  }

  // μ por canal/HORÁRIO = 1/média(tempo_servico_min). (SPEC: estimar "por canal/horário"; pooled distorce.)
  function muPorCanal(origem, hora) {
    const out = {};
    CANAIS.forEach(c => {
      const t = filasFiltradas(origem, c, hora).map(r => r.tempo_servico_min);
      out[c] = t.length ? M().estimMu(t) : null;
    });
    return out;
  }

  // Cs² (regularidade do serviço) por canal — base da correção Allen-Cunneen
  function cs2PorCanal(origem) {
    const out = {};
    CANAIS.forEach(c => {
      const t = filasFiltradas(origem, c).map(r => r.tempo_servico_min);
      out[c] = t.length > 1 ? M().cv2(t) : null;
    });
    return out;
  }

  function diasDistintos(rows) {
    const s = new Set(rows.map(r => (r.timestamp_chegada || '').slice(0, 10)).filter(Boolean));
    return Math.max(1, s.size);
  }

  // λ(h) por canal = chegadas na hora / (dias distintos × 60)  [clientes/min]
  function lambdaPorHora(canal, origem) {
    return HORAS.map(h => {
      const rows = cache.filas.filter(r => r.canal === canal && (!origem || r.origem === origem) && r.hora === h);
      const dias = diasDistintos(rows);
      return +(rows.length / (dias * 60)).toFixed(3);
    });
  }
  function lambdaCanalHora(canal, hora, origem) {
    const rows = cache.filas.filter(r => r.canal === canal && (!origem || r.origem === origem) && r.hora === hora);
    return rows.length / (diasDistintos(rows) * 60);
  }

  // perfil do totem (idoso × jovem) — explica o hiperexponencial
  function perfilTotem(origem) {
    const rows = filasFiltradas(origem, 'totem').filter(r => r.perfil_totem);
    const g = { idoso: [], jovem: [] };
    rows.forEach(r => { if (g[r.perfil_totem]) g[r.perfil_totem].push(r.tempo_servico_min); });
    return {
      idoso: g.idoso.length ? { n: g.idoso.length, media: M().mean(g.idoso) } : null,
      jovem: g.jovem.length ? { n: g.jovem.length, media: M().mean(g.jovem) } : null,
    };
  }

  // Simulação trace-driven do canal numa hora: chegadas+serviços REAIS por s servidores
  function traceSim(canal, hora, s, origem) {
    const rows = filasFiltradas(origem, canal, hora)
      .filter(r => r.timestamp_chegada)
      .sort((a, b) => new Date(a.timestamp_chegada) - new Date(b.timestamp_chegada));
    if (rows.length < 5) return null;
    const t0 = new Date(rows[0].timestamp_chegada).getTime();
    const arrivals = rows.map(r => (new Date(r.timestamp_chegada).getTime() - t0) / 60000);
    const services = rows.map(r => r.tempo_servico_min);
    return M().simulateMMs(arrivals, services, s);
  }

  /* ----------------------- EOQ: σ_d, classificação, políticas ----------------------- */
  function sigmaDPorSku(sku, origem) {
    const v = (cache.consumo || []).filter(r => r.sku === sku && (!origem || r.origem === origem) && r.consumo_unidades != null)
      .map(r => r.consumo_unidades);
    if (v.length < 2) return 0;
    // consumo é semanal → σ diária ≈ σ_semanal / √7  (aprox. p/ ROP diário)
    return M().std(v) / Math.sqrt(7);
  }

  function estoqueComputado(origem) {
    return (cache.estoque || []).filter(r => !origem || r.origem === origem).map(r => {
      const D = r.demanda_anual, S = r.custo_pedido, H = r.custo_manutencao;
      const d = D / 365, L = r.lead_time_dias;
      const sigmaD = sigmaDPorSku(r.sku, origem);
      const Q = M().eoq(D, S, H);
      const ropc = M().rop(d, L, sigmaD, 0.95);
      const classe = M().classifyEOQ(r.abordagem_recomendada);
      const periodicS = M().periodicS(d, L, 1, sigmaD, 0.95);
      const smellValidade = r.viola_validade && classe === 'classico'; // SKU-015
      return {
        ...r, d, Qstar: +Q.toFixed(1), rop_com_ss: +ropc.rop.toFixed(1), ss: +ropc.ss.toFixed(1),
        sigmaD: +sigmaD.toFixed(2), classe, periodicS: +periodicS.toFixed(1),
        tc: +M().tcEOQ(Q, D, S, H, r.preco_unitario).toFixed(2), smellValidade,
      };
    });
  }
  function classificacaoEOQ(origem) {
    const e = estoqueComputado(origem);
    return {
      classico: e.filter(x => x.classe === 'classico').map(x => x.sku),
      adaptar: e.filter(x => x.classe === 'adaptar').map(x => x.sku),
      periodo_fixo: e.filter(x => x.classe === 'periodo_fixo').map(x => x.sku),
    };
  }

  /* ----------------------- PERT / projetos / cadastro ----------------------- */
  function pertActs(projetoId) {
    const acts = {};
    (cache.pert || []).filter(r => projetoId == null || r.projeto_id === projetoId).forEach(r => {
      acts[r.atividade] = {
        dur: r.tempo_esperado_te_dias, varc: r.variancia,
        dep: r.predecessoras ? r.predecessoras.split(',').map(s => s.trim()).filter(Boolean) : [],
        maxCrash: r.max_dias_crashing, costDay: r.custo_crash_por_dia, descricao: r.descricao,
      };
    });
    return acts;
  }
  function projetos() { return cache.projetos || []; }
  function funcionarios(canal) { return (cache.funcionarios || []).filter(f => f.ativo !== false && (!canal || f.canal === canal)); }
  function produtos() { return (cache.estoque || []).map(e => ({ sku: e.sku, descricao: e.descricao })).sort((a, b) => a.sku.localeCompare(b.sku)); }

  /* ----------------------- JOGOS ----------------------- */
  function jogosResolvido() {
    const letras = [...new Set((cache.jpay || []).map(r => r.cenario))].sort();
    return letras.map(letra => {
      const rows = cache.jpay.filter(r => r.cenario === letra);
      const cen = (cache.jcen || []).find(c => c.cenario === letra) || {};
      const { m, estL, estC } = M().payoffMatrix(rows);
      const nash = M().nashPure(m);
      const dom = M().dominance(m);
      const mixed = M().nashMixed2x2(m);
      // rótulo do professor (cen.tipo / rows[0].tipo) × o que a matriz diz
      const rotulo = cen.tipo || (rows[0] && rows[0].tipo) || '';
      const rotuloDizSemNash = /sem nash|coordena|m[uú]ltipl/i.test(rotulo);
      const matrizTemNashUnico = nash.length === 1;
      const jogadorCol = cen.jogador_coluna || (rows[0] && rows[0].jogador_coluna) || '';
      const triplo = jogadorCol.includes('/');   // 3 jogadores (cenário D, bônus) — solver 2×2 não se aplica
      const divergente = !triplo && (rotuloDizSemNash && matrizTemNashUnico);
      return {
        cenario: letra, nome: cen.nome || (rows[0] && rows[0].nome_cenario), rotulo,
        jogador_linha: cen.jogador_linha || (rows[0] && rows[0].jogador_linha),
        jogador_coluna: jogadorCol,
        estL, estC, m, nash, dom, mixed, divergente, triplo,
        comentario: cen.comentario_professor || '',
      };
    });
  }

  function precosConcorrencia(origem) {
    return (cache.precos || []).filter(r => !origem || r.origem === origem);
  }

  global.Data = {
    HORAS, CANAIS, loadAll, has, cache,
    muPorCanal, cs2PorCanal, lambdaPorHora, lambdaCanalHora, perfilTotem, traceSim, filasFiltradas, diasDistintos,
    estoqueComputado, classificacaoEOQ, sigmaDPorSku,
    pertActs, jogosResolvido, precosConcorrencia, projetos, funcionarios, produtos,
  };
})(typeof window !== 'undefined' ? window : globalThis);
