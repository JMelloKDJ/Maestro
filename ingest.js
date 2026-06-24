/* ============================================================
   Maestro — INGESTÃO
   ------------------------------------------------------------
   Carrega os datasets do professor como origem='piloto' (baseline)
   e oferece o caminho de import de campo (CSV exportado das abas da
   Coleta_Campo.xlsx) como origem='campo'. Postgres = ponto único de
   verdade. Parser CSV próprio (sem dependência nova).
   Requer: usuário logado como GERENTE (RLS) e schema.sql aplicado.
   ============================================================ */
(function (global) {
  'use strict';
  const sb = () => global.sb;

  /* --------- parser CSV (trata aspas e vírgulas internas) --------- */
  function parseCSV(text) {
    const rows = []; let row = [], field = '', inQ = false;
    text = text.replace(/\r\n?/g, '\n');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift().map(h => h.trim());
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
      .map(r => { const o = {}; header.forEach((h, j) => o[h] = (r[j] !== undefined ? r[j].trim() : '')); return o; });
  }

  const num = v => (v === '' || v == null) ? null : +String(v).replace(',', '.');
  const intOr = v => (v === '' || v == null) ? null : parseInt(v, 10);
  const boolBR = v => /^true$/i.test(String(v).trim());
  const canalNorm = c => (c === 'drive' ? 'drive-thru' : (c || null)); // grafia do dataset → rótulo do app/constraint

  async function fetchText(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error('falha ao buscar ' + path + ' (' + r.status + ')');
    return r.text();
  }

  // insere em lotes; respeita RLS (gerente)
  async function insertBatched(table, rows, batch, onProgress) {
    batch = batch || 500; let done = 0;
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      const { error } = await sb().from(table).insert(chunk);
      if (error) throw new Error(table + ': ' + error.message);
      done += chunk.length;
      if (onProgress) onProgress(done, rows.length);
    }
    return done;
  }

  // já semeado? (evita duplicar; idempotente sem precisar de DELETE)
  async function jaSemeado(table) {
    const { count } = await sb().from(table).select('id', { count: 'exact', head: true }).eq('origem', 'piloto');
    return (count || 0) > 0;
  }

  /* ============================ SEEDS PILOTO ============================ */

  async function seedFilas(log) {
    if (await jaSemeado('filas_atendimentos')) { log && log('filas: já semeado, pulando'); return 0; }
    const data = parseCSV(await fetchText('./dataset_filas_loja_piloto.csv'));
    const rows = data.map(r => ({
      id_cliente: intOr(r.id_cliente),
      timestamp_chegada: r.timestamp_chegada || null,
      dia_semana: r.dia_semana || null,
      hora: intOr(r.hora),
      canal: canalNorm(r.canal),
      tempo_servico_min: num(r.tempo_servico_min),
      tam_pedido_itens: intOr(r.tam_pedido_itens),
      ticket: num(r['ticket_R$']),
      perfil_totem: r.perfil_totem || null,
      atendentes_efetivos: intOr(r.atendentes_efetivos),
      intervalo_chegada_min: num(r.intervalo_chegada_min),
      origem: 'piloto',
    }));
    return insertBatched('filas_atendimentos', rows, 500, (d, t) => log && log(`filas: ${d}/${t}`));
  }

  async function seedPert(log) {
    if (await jaSemeado('pert_atividades')) { log && log('pert: já semeado'); return 0; }
    const data = parseCSV(await fetchText('./dataset_pert_mclanche_acaraje.csv'));
    const rows = data.filter(r => r.atividade).map(r => ({
      atividade: r.atividade, descricao: r.descricao, predecessoras: r.predecessoras || null,
      tempo_otimista_dias: num(r.tempo_otimista_dias), tempo_provavel_dias: num(r.tempo_provavel_dias),
      tempo_pessimista_dias: num(r.tempo_pessimista_dias), tempo_esperado_te_dias: num(r.tempo_esperado_te_dias),
      variancia: num(r.variancia), desvio_padrao: num(r.desvio_padrao),
      custo_normal: num(r['custo_normal_R$']), custo_crash_total: num(r['custo_crash_total_R$']),
      max_dias_crashing: intOr(r.max_dias_crashing), custo_crash_por_dia: num(r['custo_crash_por_dia_R$']),
      origem: 'piloto',
    }));
    return insertBatched('pert_atividades', rows, 100, (d, t) => log && log(`pert: ${d}/${t}`));
  }

  async function seedEstoque(log) {
    if (await jaSemeado('estoque')) { log && log('estoque: já semeado'); return 0; }
    const data = parseCSV(await fetchText('./dataset_eoq_insumos_pereciveis.csv'));
    const rows = data.filter(r => r.sku).map(r => ({
      sku: r.sku, descricao: r.descricao, demanda_anual: num(r.demanda_anual_D),
      custo_pedido: num(r['custo_pedido_S_R$']), custo_manutencao: num(r['custo_manutencao_h_R$_unid_ano']),
      preco_unitario: num(r['preco_unitario_R$']), lead_time_dias: intOr(r.lead_time_dias),
      validade_dias: intOr(r.validade_dias), cv_demanda: num(r.CV_demanda),
      eoq_calculado: num(r['EOQ_calculado_Q*']), rop_calculado: num(r.ROP_calculado),
      pedidos_por_ano: num(r.pedidos_por_ano), freq_pedido_dias: num(r.freq_pedido_dias),
      viola_validade: boolBR(r.viola_validade), abordagem_recomendada: r.abordagem_recomendada,
      custo_total_anual: num(r['custo_total_anual_R$']), origem: 'piloto',
    }));
    return insertBatched('estoque', rows, 100, (d, t) => log && log(`estoque: ${d}/${t}`));
  }

  async function seedConsumo(log) {
    if (await jaSemeado('consumo')) { log && log('consumo: já semeado'); return 0; }
    const data = parseCSV(await fetchText('./dataset_eoq_historico_consumo.csv'));
    const rows = data.filter(r => r.sku).map(r => ({
      sku: r.sku, semana: intOr(r.semana), data_inicio_semana: r.data_inicio_semana || null,
      consumo_unidades: num(r.consumo_unidades), preco_unit: num(r['preco_unit_R$']), origem: 'piloto',
    }));
    return insertBatched('consumo', rows, 500, (d, t) => log && log(`consumo: ${d}/${t}`));
  }

  async function seedJogos(log) {
    // payoffs (CSV longo)
    if (!(await jaSemeado('jogos_payoffs'))) {
      const data = parseCSV(await fetchText('./dataset_jogos_payoffs.csv'));
      const rows = data.filter(r => r.cenario).map(r => ({
        cenario: r.cenario, nome_cenario: r.nome_cenario, tipo: r.tipo,
        jogador_linha: r.jogador_linha, estrategia_linha: r.estrategia_linha,
        jogador_coluna: r.jogador_coluna, estrategia_coluna: r.estrategia_coluna,
        payoff_linha: num(r['payoff_linha_R$mil']), payoff_coluna: num(r['payoff_coluna_R$mil']),
        origem: 'piloto',
      }));
      await insertBatched('jogos_payoffs', rows, 100, (d, t) => log && log(`jogos_payoffs: ${d}/${t}`));
    }
    // cenários (JSON) — A/B/C por índice + D (avançado 3 jogadores)
    if (!(await jaSemeado('jogos_cenarios'))) {
      const j = JSON.parse(await fetchText('./dataset_jogos_cenarios.json'));
      const letras = ['A', 'B', 'C', 'D'];
      const cen = (j.cenarios || []).map((c, i) => ({
        cenario: letras[i], nome: c.nome, tipo: c.tipo,
        jogador_linha: c.jogador_linha, jogador_coluna: c.jogador_coluna,
        estrategias_linha: c.estrategias_linha, estrategias_coluna: c.estrategias_coluna,
        comentario_professor: c.comentario_professor, origem: 'piloto',
      }));
      if (j.cenario_avancado_3D) {
        const d = j.cenario_avancado_3D;
        cen.push({
          cenario: 'D', nome: d.nome, tipo: d.tipo,
          jogador_linha: d.jogador_linha, jogador_coluna: d.jogador_coluna + ' / ' + (d.jogador_terceiro || ''),
          estrategias_linha: d.estrategias_linha, estrategias_coluna: d.estrategias_linha,
          comentario_professor: d.comentario_professor, origem: 'piloto',
        });
      }
      await insertBatched('jogos_cenarios', cen, 50, (d, t) => log && log(`jogos_cenarios: ${d}/${t}`));
    }
    return true;
  }

  // semeia tudo
  async function seedPiloto(log) {
    log = log || (() => {});
    log('Iniciando seed piloto…');
    const f = await seedFilas(log);
    const p = await seedPert(log);
    const e = await seedEstoque(log);
    const c = await seedConsumo(log);
    await seedJogos(log);
    log('Seed piloto concluído.');
    return { filas: f, pert: p, estoque: e, consumo: c };
  }

  /* ============================ IMPORT CAMPO ============================ */
  // recebe um File (CSV exportado de uma aba da Coleta_Campo.xlsx) e grava origem='campo'
  async function importCampoCSV(file, tipo, log) {
    log = log || (() => {});
    const text = await file.text();
    const data = parseCSV(text);
    const uid = (await sb().auth.getUser()).data.user?.id || null;
    let table, rows;
    if (tipo === 'chegadas') {
      table = 'filas_atendimentos';
      rows = data.map(r => ({
        timestamp_chegada: r.timestamp_chegada || r['Hora chegada'] || null,
        canal: canalNorm(r.canal), tempo_servico_min: num(r.tempo_servico_min),
        hora: intOr(r.hora), dia_semana: r.dia_semana || null,
        intervalo_chegada_min: num(r.intervalo_chegada_min), origem: 'campo',
      }));
    } else if (tipo === 'snapshots') {
      table = 'filas_snapshots';
      rows = data.map(r => ({
        sessao: r.sessao || r['Sessão'] || null, hora: r.hora || r['Hora (HH:MM)'] || null,
        fila_balcao: intOr(r.fila_balcao), fila_totem: intOr(r.fila_totem),
        fila_drive_menu: intOr(r.fila_drive_menu), fila_drive_janela: intOr(r.fila_drive_janela),
        clientes_salao: intOr(r.clientes_salao), observacoes: r.observacoes || null,
        origem: 'campo', coletado_por: uid,
      }));
    } else if (tipo === 'drive') {
      table = 'drive_tempos';
      rows = data.map(r => ({
        sessao: r.sessao || null, carro_num: intOr(r.carro_num || r['#']),
        hora_chegada: r.hora_chegada || null, t_chegada_menu_s: num(r.t_chegada_menu_s),
        t_menu_janela1_s: num(r.t_menu_janela1_s), t_janela1_janela2_s: num(r.t_janela1_janela2_s),
        t_total_s: num(r.t_total_s), origem: 'campo', coletado_por: uid,
      }));
    } else if (tipo === 'precos') {
      table = 'jogos_precos';
      rows = data.map(r => ({
        categoria: r.categoria || r['Categoria'] || null, produto: r.produto || r['Produto comparável'] || null,
        preco_mcd: num(r.preco_mcd), preco_bk: num(r.preco_bk), preco_subway: num(r.preco_subway),
        preco_madero_habibs: num(r.preco_madero_habibs), observacoes: r.observacoes || null,
        origem: 'campo', coletado_por: uid,
      }));
    } else {
      throw new Error('tipo de import desconhecido: ' + tipo);
    }
    const n = await insertBatched(table, rows, 500, (d, t) => log(`${tipo}: ${d}/${t}`));
    return n;
  }

  global.Ingest = { parseCSV, seedPiloto, seedFilas, seedPert, seedEstoque, seedConsumo, seedJogos, importCampoCSV };
})(typeof window !== 'undefined' ? window : globalThis);
