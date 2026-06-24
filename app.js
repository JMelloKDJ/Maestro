/* ============================================================
   Maestro — APP (UI / orquestração)
   Navegação por finalidade: Dashboard (visão) + guias funcionais
   interativas (Atendimento, Estoque, Projetos, Concorrência) +
   Operação + Config. Cálculo 100% no Motor; a IA interpreta/cita/propõe.
   ============================================================ */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const D = () => window.Data, M = () => window.Motor, AI = () => window.AI, ING = () => window.Ingest;
  const n0 = x => (x == null || !isFinite(x)) ? '—' : (+x).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const n1 = x => (x == null || !isFinite(x)) ? '—' : (+x).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const n2 = x => (x == null || !isFinite(x)) ? '—' : (+x).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  const brl = x => 'R$ ' + (+x).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cb = (id, h) => `<div style="position:relative;height:${h || 220}px"><canvas id="${id}"></canvas></div>`; // container de altura fixa (fix gráficos)
  const canalLabel = { balcao: 'Balcão', totem: 'Totem', 'drive-thru': 'Drive-thru' };

  const S = {
    session: null, profile: null, role: null,
    view: 'dashboard',
    filtros: { origem: 'piloto', canal: 'balcao', periodo: 'almoco', hora: 12 },
    atend: { alvoWq: 2 },
    estoqueSel: 'SKU-011', estoqueOv: {},        // overrides what-if por SKU
    pertOv: {}, pertBudget: 50000, projetoSel: null,   // edição de o/m/p, orçamento de crashing, projeto selecionado
    jogosSel: 'A', jogosOv: {},                  // matriz editável por cenário
    custom: {}, charts: {}, iaTema: 'filas', iaMsgs: [], pendentes: [],
    kdsSeg: 'preparo', cadSeg: 'produtos',
  };
  const PERIODOS = { almoco: { nome: 'Almoço (11–14h)', hora: 12 }, tarde: { nome: 'Tarde (15–17h)', hora: 16 }, jantar: { nome: 'Jantar (18–21h)', hora: 19 } };

  /* ============================ AUTH ============================ */
  let signupRole = 'gerente';
  function gate(msg, err) { const m = $('#gateMsg'); if (m) { m.textContent = msg || ''; m.style.color = err ? 'var(--red)' : 'var(--green)'; } }
  function initGate() {
    $('#roleSel').addEventListener('click', e => {
      const b = e.target.closest('button[data-r]'); if (!b) return;
      signupRole = b.dataset.r;
      document.querySelectorAll('#roleSel button').forEach(x => x.classList.toggle('on', x === b));
    });
    document.querySelector('#roleSel button[data-r="gerente"]').classList.add('on');
    $('#btnLogin').onclick = doLogin; $('#btnSignup').onclick = doSignup;
    $('#iaClose').onclick = () => $('#iaPanel').classList.remove('open');
    $('#iaSend').onclick = iaSend;
    $('#iaInput').addEventListener('keydown', e => { if (e.key === 'Enter') iaSend(); });
  }
  async function doLogin() {
    gate('Entrando…');
    const { error } = await window.sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#senha').value });
    if (error) return gate(error.message, true);
    boot();
  }
  async function garantirProfile(user, papel) {
    const nome = (user.user_metadata && user.user_metadata.nome) || (user.email || '').split('@')[0];
    const ins = await window.sb.from('profiles').insert({ id: user.id, papel: papel || 'gerente', nome }).select().single();
    if (!ins.error) return ins.data;
    return (await window.sb.from('profiles').select('*').eq('id', user.id).maybeSingle()).data;
  }
  async function doSignup() {
    gate('Cadastrando…');
    const email = $('#email').value.trim(), password = $('#senha').value;
    const { data, error } = await window.sb.auth.signUp({ email, password, options: { data: { papel: signupRole, nome: email.split('@')[0] } } });
    if (error) return gate(error.message, true);
    if (data.session) { await garantirProfile(data.session.user, signupRole); boot(); }
    else gate('Cadastro criado. Confirme o e-mail (se exigido) e clique em Entrar.', false);
  }
  async function boot() {
    const { data } = await window.sb.auth.getSession();
    S.session = data.session;
    if (!S.session) { $('#gate').classList.remove('hidden'); $('#app').classList.add('hidden'); return; }
    let prof = (await window.sb.from('profiles').select('*').eq('id', S.session.user.id).maybeSingle()).data;
    if (!prof) prof = await garantirProfile(S.session.user, (S.session.user.user_metadata && S.session.user.user_metadata.papel) || signupRole);
    if (!prof) { gate('Não foi possível carregar/criar o perfil.', true); return; }
    S.profile = prof; S.role = prof.papel;
    $('#gate').classList.add('hidden'); $('#app').classList.remove('hidden');
    if (S.role === 'gerente') await mountCockpit();
    else if (S.role === 'funcionario') await mountKDS();
    else await mountColeta();
  }
  async function logout() { await window.sb.auth.signOut(); location.reload(); }

  /* ============================ LAYOUT GERENTE ============================ */
  const TABS = [
    { id: 'dashboard', nome: 'Dashboard' }, { id: 'atendimento', nome: 'Atendimento' },
    { id: 'estoque', nome: 'Estoque' }, { id: 'projetos', nome: 'Projetos' },
    { id: 'concorrencia', nome: 'Concorrência' }, { id: 'cadastro', nome: 'Cadastro' },
    { id: 'operacao', nome: 'Operação' }, { id: 'config', nome: 'Config & IA' },
  ];
  // filtros relevantes por guia
  const SHOW_CANAL = { dashboard: 1, atendimento: 1 };
  function topbar() {
    return `<div class="topbar">
      <div class="wrap row between center" style="padding:0">
        <div class="row center" style="gap:14px"><span class="brand">Mae<b>stro</b></span><span class="muted small">${esc(S.profile.nome)} · gerente</span></div>
        <div class="row center">${filtrosBar()}
          <button class="btn sm sec" id="btnIA">Copiloto</button>
          <button class="btn sm sec" id="btnPDF">PDF</button>
          <button class="btn sm" id="btnOut">sair</button>
        </div>
      </div>
      <div class="wrap nav" style="padding:8px 0 0">${TABS.map(t => `<button data-v="${t.id}" class="${S.view === t.id ? 'active' : ''}">${t.nome}</button>`).join('')}</div>
    </div>`;
  }
  function filtrosBar() {
    const f = S.filtros, showCanal = SHOW_CANAL[S.view];
    return `<label class="fld" style="flex-direction:row;align-items:center;gap:6px">origem
      <select id="fOrigem"><option value="piloto"${f.origem === 'piloto' ? ' selected' : ''}>piloto</option><option value="campo"${f.origem === 'campo' ? ' selected' : ''}>campo</option><option value=""${f.origem === '' ? ' selected' : ''}>ambos</option></select></label>
    ${showCanal ? `<label class="fld" style="flex-direction:row;align-items:center;gap:6px">canal
      <select id="fCanal">${D().CANAIS.map(c => `<option value="${c}"${f.canal === c ? ' selected' : ''}>${canalLabel[c] || c}</option>`).join('')}</select></label>
    <label class="fld" style="flex-direction:row;align-items:center;gap:6px">período
      <select id="fPer">${Object.keys(PERIODOS).map(p => `<option value="${p}"${f.periodo === p ? ' selected' : ''}>${PERIODOS[p].nome}</option>`).join('')}</select></label>` : ''}`;
  }
  async function mountCockpit() {
    const app = $('#app');
    app.innerHTML = topbar() + `<div class="wrap" id="content"><div class="card">Carregando dados…<div class="small muted" id="ld"></div></div></div>`;
    bindTop();
    try { if (!D().has()) await D().loadAll(m => { const l = $('#ld'); if (l) l.textContent = m; }); }
    catch (e) {
      $('#content').innerHTML = `<div class="card"><h3>Não consegui carregar os dados</h3><div class="smell">${esc(e.message)}</div>
      <p class="muted small">Verifique a conexão e se os dados foram carregados (Config & IA → Carregar base).</p>
      <button class="btn" id="goCfg">Ir para Config & IA</button></div>`;
      $('#goCfg').onclick = () => { S.view = 'config'; mountCockpit(); }; return;
    }
    renderView();
  }
  function bindTop() {
    $('#btnOut').onclick = logout;
    $('#btnIA').onclick = () => $('#iaPanel').classList.toggle('open');
    $('#btnPDF').onclick = () => window.print();
    document.querySelectorAll('.nav button').forEach(b => b.onclick = () => { S.view = b.dataset.v; mountCockpit(); });
    const bind = (id, key) => { const e = $('#' + id); if (e) e.onchange = () => { S.filtros[key] = e.value; if (key === 'periodo') S.filtros.hora = PERIODOS[e.value].hora; renderView(); }; };
    bind('fOrigem', 'origem'); bind('fCanal', 'canal'); bind('fPer', 'periodo');
  }
  function renderView() {
    const c = $('#content'); if (!c) return;
    const map = { dashboard: renderDashboard, atendimento: renderAtendimento, estoque: renderEstoque, projetos: renderProjetos, concorrencia: renderConcorrencia, cadastro: renderCadastro, operacao: renderOper, config: renderConfig };
    Object.values(S.charts).forEach(ch => { try { ch.destroy(); } catch (e) {} }); S.charts = {};
    c.innerHTML = (map[S.view] || renderDashboard)();
    if (postRender[S.view]) postRender[S.view]();
  }
  const postRender = {};

  /* ============================ cálculos de apoio ============================ */
  function filasMetrics(canal, hora, origem, alvo) {
    const mu = D().muPorCanal(origem, hora)[canal];
    const cs2 = D().cs2PorCanal(origem)[canal];
    const lam = D().lambdaCanalHora(canal, hora, origem);
    if (!mu || !lam) return null;
    const rec = M().recommendS(lam, mu, alvo);
    const recRow = rec.rows.find(r => r.s === rec.rec) || rec.rows[rec.rows.length - 1];
    const sim = D().traceSim(canal, hora, rec.rec, origem);
    const gap = sim ? M().gap(sim.Wq, recRow.Wq) : null;
    return { mu, cs2, lam, rec, recRow, sim, gap };
  }
  function skuCalc(row, ov) {
    ov = ov || {};
    const Dv = +(ov.D != null ? ov.D : row.demanda_anual), Sv = +(ov.S != null ? ov.S : row.custo_pedido), Hv = +(ov.H != null ? ov.H : row.custo_manutencao);
    const Lv = +(ov.L != null ? ov.L : row.lead_time_dias), est = +(ov.estoque != null ? ov.estoque : (row.estoque_atual || 0));
    const d = Dv / 365, sigmaD = D().sigmaDPorSku(row.sku, S.filtros.origem);
    const Q = M().eoq(Dv, Sv, Hv), ropc = M().rop(d, Lv, sigmaD, 0.95);
    const classe = M().classifyEOQ(row.abordagem_recomendada);
    return {
      sku: row.sku, descricao: row.descricao, D: Dv, S: Sv, H: Hv, L: Lv, estoque: est, preco: row.preco_unitario,
      d, sigmaD: +sigmaD.toFixed(2), Qstar: +Q.toFixed(1), rop: +ropc.rop.toFixed(1), ss: +ropc.ss.toFixed(1),
      tc: +M().tcEOQ(Q, Dv, Sv, Hv, row.preco_unitario).toFixed(2), classe, periodicS: +M().periodicS(d, Lv, 1, sigmaD, 0.95).toFixed(1),
      validade: row.validade_dias, freq: row.freq_pedido_dias, viola: row.viola_validade,
      smellValidade: row.viola_validade && classe === 'classico', precisaRepor: est <= ropc.rop, raw: row, ov,
    };
  }
  function projetoAtualId() { if (S.projetoSel != null) return S.projetoSel; const p = D().projetos()[0]; return p ? p.id : null; }
  function pertBuild() {
    const acts = {}; const pid = projetoAtualId();
    (D().cache.pert || []).filter(r => pid == null || r.projeto_id === pid).forEach(r => {
      const ov = S.pertOv[r.atividade] || {};
      const o = +(ov.o != null ? ov.o : r.tempo_otimista_dias), m = +(ov.m != null ? ov.m : r.tempo_provavel_dias), p = +(ov.p != null ? ov.p : r.tempo_pessimista_dias);
      const t = M().pertTimes(o, m, p);
      acts[r.atividade] = { dur: t.te, varc: t.variancia, o, m, p, dep: r.predecessoras ? r.predecessoras.split(',').map(s => s.trim()).filter(Boolean) : [], maxCrash: r.max_dias_crashing, costDay: r.custo_crash_por_dia, descricao: r.descricao };
    });
    return acts;
  }
  function jogoAtual() {
    const j = D().jogosResolvido().find(x => x.cenario === S.jogosSel) || D().jogosResolvido()[0];
    if (!j || j.triplo) return j;
    const ov = S.jogosOv[j.cenario];
    if (ov) { const m = ov; const nash = M().nashPure(m), dom = M().dominance(m), mixed = M().nashMixed2x2(m); return { ...j, m, nash, dom, mixed, editado: true }; }
    return j;
  }

  /* ============================ DASHBOARD (só visão) ============================ */
  function renderDashboard() {
    const f = S.filtros;
    const fm = filasMetrics(f.canal, f.hora, f.origem, S.atend.alvoWq);
    const est = D().estoqueComputado(f.origem).map(r => skuCalc(r.raw || r, S.estoqueOv[r.sku]));
    const alerta = est.filter(s => s.precisaRepor);
    const cls = D().classificacaoEOQ(f.origem);
    const jogos = D().jogosResolvido();
    const { cpm } = (function () { const acts = pertBuild(); return { cpm: M().cpm(acts) }; })();
    S.iaTema = 'filas';

    setTimeout(() => {
      if (fm) {
        mkChart('dArr', 'bar', { labels: D().HORAS.map(h => h + 'h'), datasets: [{ label: 'λ (clientes/min)', data: D().lambdaPorHora(f.canal, f.origem), backgroundColor: '#ffbc0d' }] });
        if (fm.sim) mkChart('dTri', 'bar', { labels: ['Wq (min)', 'Lq'], datasets: [{ label: 'Teórico M/M/s', data: [fm.recRow.Wq, fm.recRow.Lq], backgroundColor: '#4c9be8' }, { label: 'Observado', data: [fm.sim.Wq, fm.sim.Lq], backgroundColor: '#da291c' }] });
      }
      const sku = est.find(s => s.sku === 'SKU-011') || est[0];
      if (sku) { const cv = M().eoqCurve(sku.D, sku.S, sku.H, sku.preco, 36); mkChart('dEoq', 'line', { labels: cv.pts.map(p => p.Q), datasets: [{ label: 'Custo total (R$)', data: cv.pts.map(p => p.TC), borderColor: '#ffbc0d', tension: .3, pointRadius: 0 }] }); }
      drawAON(pertBuild(), cpm, 'dAon');
    }, 0);

    return `<div class="col">
      <div class="row">
        <div class="kpi"><div class="l">Clientes/h · ${esc(canalLabel[f.canal])}</div><div class="v">${fm ? n0(fm.lam * 60) : '—'}</div></div>
        <div class="kpi"><div class="l">Atendentes recom.</div><div class="v">${fm ? fm.rec.rec : '—'}</div></div>
        <div class="kpi"><div class="l">Espera Wq (min)</div><div class="v">${fm ? n2(fm.recRow.Wq) : '—'}</div></div>
        <div class="kpi"><div class="l">SKUs em alerta</div><div class="v" style="color:${alerta.length ? 'var(--red)' : 'var(--green)'}">${alerta.length}</div></div>
        <div class="kpi"><div class="l">Lançamento</div><div class="v">${n0(cpm.proj)} d</div></div>
      </div>
      <div class="row">
        <div class="card grow"><h3>Demanda por hora · ${esc(canalLabel[f.canal])}</h3><div class="sub">Chegadas por minuto ao longo do dia.</div>${cb('dArr', 190)}</div>
        <div class="card grow"><h3>Espera observada × modelo</h3><div class="sub">Tempo de fila medido (simulação do dado real) vs. modelo M/M/s.</div>${cb('dTri', 190)}</div>
      </div>
      <div class="row">
        <div class="card grow"><h3>Custo de estoque (SKU-011)</h3><div class="sub">Curva de custo total por tamanho de lote — mínimo no Q*.</div>${cb('dEoq', 190)}</div>
        <div class="card grow"><h3>Concorrência — equilíbrios</h3><div class="sub">Estratégia de equilíbrio por cenário.</div>
          <table><thead><tr><th>cenário</th><th>vs</th><th>equilíbrio</th></tr></thead><tbody>
          ${jogos.map(j => `<tr><td>${j.cenario}</td><td style="text-align:left">${esc(j.jogador_coluna)}</td><td>${j.triplo ? 'Entrar/Entrar/Entrar' : ((j.nash || [])[0] ? esc(j.estL[j.nash[0].i]) + ' × ' + esc(j.estC[j.nash[0].j]) : 'mista')}${j.divergente ? ' ⚠' : ''}</td></tr>`).join('')}
          </tbody></table></div>
      </div>
      <div class="card"><h3>Rede do projeto de lançamento</h3><div class="sub">Caminho crítico destacado.</div><div id="dAon" style="overflow:auto"></div></div>
      <div class="card"><h3>Precisa de atenção</h3>
        ${painelAtencao(alerta, fm, est, jogos, f)}
      </div>
    </div>`;
  }
  function painelAtencao(alerta, fm, est, jogos, f) {
    const itens = [];
    if (alerta.length) itens.push(`<b>${alerta.length}</b> insumo(s) no ponto de reposição: ${alerta.slice(0, 6).map(s => s.sku).join(', ')}${alerta.length > 6 ? '…' : ''}.`);
    if (fm && fm.gap && fm.gap.exigeHipotese) itens.push(`Espera medida no ${canalLabel[f.canal]} ${fm.gap.gap > 0 ? 'acima' : 'abaixo'} do previsto pelo modelo (${(fm.gap.gap * 100).toFixed(0)}%) — ${f.canal === 'totem' ? 'tempos de serviço muito variáveis (perfis distintos)' : f.canal === 'drive-thru' ? 'fluxo em série entre as janelas' : 'variação dentro da hora'}.`);
    const vs = est.find(s => s.smellValidade); if (vs) itens.push(`${vs.sku} (${esc(vs.descricao)}): validade de ${vs.validade}d incompatível com pedir a cada ~${n0(vs.freq)}d.`);
    jogos.filter(j => j.divergente).forEach(j => itens.push(`Cenário ${j.cenario}: a classificação informada (“${esc(j.rotulo)}”) diverge do equilíbrio calculado.`));
    if (!itens.length) return '<div class="muted small">Tudo dentro do esperado.</div>';
    return itens.map(t => `<div class="smell">${t}</div>`).join('');
  }

  /* ============================ ATENDIMENTO (Filas, interativo) ============================ */
  function renderAtendimento() {
    const f = S.filtros, canal = f.canal, hora = f.hora, origem = f.origem;
    const fm = filasMetrics(canal, hora, origem, S.atend.alvoWq);
    S.iaTema = 'filas';
    if (!fm) return `<div class="card"><h3>Atendimento</h3><div class="smell">Sem dados de ${esc(canalLabel[canal])} para a origem selecionada. Carregue a base em Config & IA ou troque o filtro.</div></div>`;
    const { mu, cs2, lam, rec, recRow, sim, gap } = fm;

    setTimeout(() => {
      mkChart('aArr', 'bar', { labels: D().HORAS.map(h => h + 'h'), datasets: [{ label: 'λ (clientes/min)', data: D().lambdaPorHora(canal, origem), backgroundColor: '#ffbc0d' }] });
      if (sim) mkChart('aTri', 'bar', { labels: ['Wq (min)', 'Lq'], datasets: [{ label: 'Teórico', data: [recRow.Wq, recRow.Lq], backgroundColor: '#4c9be8' }, { label: 'Observado', data: [sim.Wq, sim.Lq], backgroundColor: '#da291c' }] });
    }, 0);

    let canalBox = '';
    if (canal === 'drive-thru') { const a = lam / mu; canalBox = `<div class="card"><h3>Drive-thru: fluxo em série</h3><div class="sub">Com um único servidor a carga seria ρ=${n1(a)} (impossível). Tratado como estações em série (menu → pagamento → entrega): cerca de <b>${Math.ceil(a)} posições</b> ocupadas ao mesmo tempo (L=λ·W).</div></div>`; }
    if (canal === 'totem') { const pf = D().perfilTotem(origem); const wqAC = M().allenCunneen(recRow.Wq, 1, cs2); canalBox = `<div class="card"><h3>Totem: tempos de serviço muito variáveis</h3><div class="sub">Mistura de perfis ${pf.idoso ? '(mais lento ~' + n2(pf.idoso.media) + ' min' : ''}${pf.jovem ? ' · mais rápido ~' + n2(pf.jovem.media) + ' min)' : ')'} eleva a espera real para ≈ ${n2(wqAC)} min (acima do modelo simples).</div></div>`; }

    return `<div class="col">
      <div class="card"><h3>Dimensionar atendimento · ${esc(canalLabel[canal])} · ${esc(PERIODOS[f.periodo].nome)}</h3>
        <div class="sub">Ajuste a meta de espera e veja a equipe recomendada na hora.</div>
        <div class="row center">
          <label class="fld">Meta de espera Wq (min)<input id="aAlvo" type="number" min="0.5" max="10" step="0.5" value="${S.atend.alvoWq}" style="width:110px"></label>
          <div class="kpi"><div class="l">Chegadas λ</div><div class="v">${n2(lam)}<span class="small muted"> /min</span></div></div>
          <div class="kpi"><div class="l">Atendimento μ</div><div class="v">${n2(mu)}<span class="small muted"> /min</span></div></div>
          <div class="kpi"><div class="l">Equipe recomendada</div><div class="v" style="color:var(--amber)">${rec.rec}</div></div>
          <div class="kpi"><div class="l">ρ (utilização)</div><div class="v">${n2(recRow.rho)}</div></div>
          <div class="kpi"><div class="l">Wq prevista</div><div class="v">${n2(recRow.Wq)}<span class="small muted"> min</span></div></div>
        </div>
      </div>
      <div class="row">
        <div class="card grow"><h3>Demanda por hora</h3>${cb('aArr', 180)}</div>
        <div class="card grow"><h3>Espera observada × modelo${gap ? ' · diferença ' + (gap.gap * 100).toFixed(0) + '%' : ''}</h3>${cb('aTri', 180)}</div>
      </div>
      ${canalBox}
      <div class="card"><h3>Cenários de equipe</h3>
        <table><thead><tr><th>atendentes</th><th>ρ</th><th>prob. espera</th><th>Wq (min)</th><th>fila Lq</th><th>no sistema L</th></tr></thead><tbody>
        ${rec.rows.map(r => `<tr class="${r.s === rec.rec ? 'crit' : ''}"><td>${r.s}${r.s === rec.rec ? ' ◀ recomendado' : ''}</td><td>${n2(r.rho)}</td><td>${n2(r.C)}</td><td>${n2(r.Wq)}</td><td>${n1(r.Lq)}</td><td>${n1(r.L)}</td></tr>`).join('')}
        </tbody></table>
        <div class="row between center" style="margin-top:12px">
          <div class="formula">Erlang-C · Wq = C/(s·μ − λ)</div>
          <button class="btn" id="pubEscala">Publicar escala no KDS</button>
        </div>
      </div>
    </div>`;
  }
  postRender.atendimento = () => {
    const a = $('#aAlvo'); if (a) a.onchange = () => { S.atend.alvoWq = Math.max(0.5, +a.value || 2); renderView(); };
    const b = $('#pubEscala'); if (b) b.onclick = () => {
      const fm = filasMetrics(S.filtros.canal, S.filtros.hora, S.filtros.origem, S.atend.alvoWq); if (!fm) return;
      proporAcao({ tipo: 'escala', titulo: `Escala ${canalLabel[S.filtros.canal]} · ${PERIODOS[S.filtros.periodo].nome}`, descricao: `${fm.rec.rec} atendentes (espera prevista ${n2(fm.recRow.Wq)} min)`, payload: { canal: S.filtros.canal, s: fm.rec.rec, wq: fm.recRow.Wq, periodo: S.filtros.periodo } });
    };
  };

  /* ============================ ESTOQUE (EOQ, interativo) ============================ */
  function renderEstoque() {
    const rows = D().estoqueComputado(S.filtros.origem);
    if (!rows.length) return `<div class="card"><h3>Estoque</h3><div class="smell">Sem insumos cadastrados. Carregue a base em Config & IA.</div></div>`;
    const cls = D().classificacaoEOQ(S.filtros.origem);
    const sel = S.estoqueSel || rows[0].sku;
    const row = (rows.find(x => x.sku === sel) || rows[0]).raw || rows.find(x => x.sku === sel) || rows[0];
    const baseRow = D().cache.estoque.find(x => x.sku === sel) || D().cache.estoque[0];
    const s = skuCalc(baseRow, S.estoqueOv[sel]);
    const todas = (D().cache.estoque || []).filter(r => !S.filtros.origem || r.origem === S.filtros.origem).map(r => skuCalc(r, S.estoqueOv[r.sku])).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    S.iaTema = 'eoq';
    setTimeout(() => {
      mkChart('eCompare', 'bar', { labels: todas.map(x => x.sku), datasets: [{ label: 'Custo total anual (R$)', data: todas.map(x => x.tc), backgroundColor: todas.map(x => x.precisaRepor ? '#da291c' : '#ffbc0d') }] });
      mkChart('eQbar', 'bar', { labels: todas.map(x => x.sku), datasets: [{ label: 'Q* (lote)', data: todas.map(x => x.Qstar), backgroundColor: '#4c9be8' }, { label: 'Ponto de pedido', data: todas.map(x => x.rop), backgroundColor: '#27ae60' }] });
      const cv = M().eoqCurve(s.D, s.S, s.H, s.preco, 40);
      mkChart('eCurve', 'line', { labels: cv.pts.map(p => p.Q), datasets: [{ label: 'Custo total anual (R$)', data: cv.pts.map(p => p.TC), borderColor: '#ffbc0d', tension: .3, pointRadius: 0 }] });
      const sens = M().eoqSensitivity(s.D, s.S, s.H);
      mkChart('eSens', 'line', { labels: sens.D.map(p => '×' + p.f), datasets: [{ label: 'Q* vs D', data: sens.D.map(p => p.Q), borderColor: '#4c9be8' }, { label: 'Q* vs S', data: sens.S.map(p => p.Q), borderColor: '#27ae60' }, { label: 'Q* vs H', data: sens.H.map(p => p.Q), borderColor: '#da291c' }] });
    }, 0);
    const fld = (k, lab, val, step) => `<label class="fld" style="width:120px">${lab}<input data-ek="${k}" type="number" step="${step || 1}" value="${val}"></label>`;
    return `<div class="col">
      <div class="row">
        <div class="kpi"><div class="l">Lote econômico (EOQ)</div><div class="v">${cls.classico.length}</div><div class="small muted">${cls.classico.join(', ')}</div></div>
        <div class="kpi"><div class="l">EOQ adaptado</div><div class="v">${cls.adaptar.length}</div><div class="small muted">${cls.adaptar.join(', ')}</div></div>
        <div class="kpi"><div class="l">Revisão periódica</div><div class="v">${cls.periodo_fixo.length}</div></div>
      </div>
      <div class="card"><h3>Visão geral dos insumos</h3>
        <div class="sub">Todos os SKUs de uma vez — clique numa linha para abrir o detalhe. Barras vermelhas = no ponto de reposição.</div>
        <div class="row">
          <div class="grow"><div class="sub">Custo total anual por SKU</div>${cb('eCompare', 200)}</div>
          <div class="grow"><div class="sub">Q* × ponto de pedido por SKU</div>${cb('eQbar', 200)}</div>
        </div>
        <table style="margin-top:8px"><thead><tr><th>SKU</th><th>descrição</th><th>Q*</th><th>ponto pedido</th><th>custo/ano</th><th>classe</th><th>status</th></tr></thead><tbody>
        ${todas.map(x => `<tr class="${x.sku === sel ? 'crit' : ''}" data-esku="${esc(x.sku)}" style="cursor:pointer"><td>${esc(x.sku)}</td><td style="text-align:left">${esc(x.descricao)}</td><td>${n1(x.Qstar)}</td><td>${n1(x.rop)}</td><td>${brl(x.tc)}</td><td>${x.classe}</td><td style="color:${x.precisaRepor ? 'var(--red)' : 'var(--green)'}">${x.precisaRepor ? 'repor' : 'ok'}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card"><h3>Insumo
        <select id="eSku" style="margin-left:8px">${rows.map(r => `<option${r.sku === sel ? ' selected' : ''}>${r.sku}</option>`).join('')}</select>
        <span class="muted small">${esc(s.descricao)}</span></h3>
        <div class="sub">Edite os parâmetros e recalcule. Salvar grava no sistema; registrar consumo alimenta a demanda.</div>
        <div class="row">
          ${fld('D', 'Demanda anual', s.D)} ${fld('S', 'Custo do pedido (R$)', s.S)} ${fld('H', 'Custo de manter (R$/un·ano)', s.H, 0.5)}
          ${fld('L', 'Lead time (dias)', s.L)} ${fld('estoque', 'Estoque atual', s.estoque)}
        </div>
        <div class="row center" style="margin-top:6px">
          <button class="btn sm" id="eRecalc">Recalcular</button>
          <button class="btn sm sec" id="eSalvar">Salvar parâmetros</button>
          <button class="btn sm sec" id="eReset">Reverter</button>
          <span class="small muted" id="eMsg"></span>
        </div>
        <div class="row" style="margin-top:10px">
          <div class="kpi"><div class="l">Q* (lote)</div><div class="v">${n1(s.Qstar)}</div></div>
          <div class="kpi"><div class="l">Ponto de pedido</div><div class="v">${n1(s.rop)}</div><div class="small muted">segurança ${n1(s.ss)}</div></div>
          <div class="kpi"><div class="l">σ demanda/dia</div><div class="v">${n2(s.sigmaD)}</div></div>
          <div class="kpi"><div class="l">Custo total/ano</div><div class="v" style="font-size:18px">${brl(s.tc)}</div></div>
          <div class="kpi"><div class="l">Status</div><div class="v" style="font-size:16px;color:${s.precisaRepor ? 'var(--red)' : 'var(--green)'}">${s.precisaRepor ? 'repor' : 'ok'}</div></div>
        </div>
        ${s.smellValidade ? `<div class="smell">Marcado como lote econômico, mas a validade (${s.validade}d) é menor que o intervalo entre pedidos (~${n0(s.freq)}d) — risco de perda.</div>` : ''}
        ${s.classe !== 'classico' ? `<div class="small muted">Política sugerida: revisão periódica (diária) com nível-alvo ≈ ${n1(s.periodicS)} un.</div>` : ''}
        <div class="row" style="margin-top:12px">
          <div class="grow"><div class="sub">Curva de custo total por lote</div>${cb('eCurve', 180)}</div>
          <div class="grow"><div class="sub">Sensibilidade do Q*</div>${cb('eSens', 180)}</div>
        </div>
        <div class="row center" style="margin-top:10px;border-top:1px solid var(--line);padding-top:12px">
          <label class="fld" style="width:120px">Registrar consumo<input id="eCons" type="number" step="1" placeholder="qtd"></label>
          <button class="btn sm" id="eRegCons">Dar baixa</button>
          <button class="btn sm" id="ePedir">Publicar reposição (Q*)</button>
          <span class="small muted" id="eOpMsg"></span>
        </div>
      </div>
    </div>`;
  }
  postRender.estoque = () => {
    const seln = $('#eSku'); if (seln) seln.onchange = () => { S.estoqueSel = seln.value; renderView(); };
    document.querySelectorAll('[data-esku]').forEach(tr => tr.onclick = () => { S.estoqueSel = tr.dataset.esku; renderView(); });
    const readEdits = () => { const ov = {}; document.querySelectorAll('[data-ek]').forEach(i => { if (i.value !== '') ov[i.dataset.ek] = +i.value; }); return ov; };
    const sel = S.estoqueSel;
    const rc = $('#eRecalc'); if (rc) rc.onclick = () => { S.estoqueOv[sel] = readEdits(); renderView(); };
    const rs = $('#eReset'); if (rs) rs.onclick = () => { delete S.estoqueOv[sel]; renderView(); };
    const sv = $('#eSalvar'); if (sv) sv.onclick = async () => {
      const ov = readEdits();
      const { error } = await window.sb.from('estoque').update({ demanda_anual: ov.D, custo_pedido: ov.S, custo_manutencao: ov.H, lead_time_dias: ov.L, estoque_atual: ov.estoque }).eq('sku', sel);
      const m = $('#eMsg'); if (error) { m.textContent = 'erro: ' + error.message; m.style.color = 'var(--red)'; }
      else { m.textContent = 'salvo ✔'; m.style.color = 'var(--green)'; const r = D().cache.estoque.find(x => x.sku === sel); if (r) Object.assign(r, { demanda_anual: ov.D, custo_pedido: ov.S, custo_manutencao: ov.H, lead_time_dias: ov.L, estoque_atual: ov.estoque }); delete S.estoqueOv[sel]; }
    };
    const rg = $('#eRegCons'); if (rg) rg.onclick = async () => {
      const q = +$('#eCons').value; if (!q) return;
      const { error } = await window.sb.from('consumo').insert({ sku: sel, consumo_unidades: q, data_inicio_semana: new Date().toISOString().slice(0, 10), origem: 'campo', registrado_por: S.session.user.id });
      const m = $('#eOpMsg'); m.textContent = error ? 'erro: ' + error.message : 'baixa registrada ✔';
      if (!error) D().cache.consumo = (await window.sb.from('consumo').select('sku,semana,consumo_unidades,origem')).data || [];
    };
    const pd = $('#ePedir'); if (pd) pd.onclick = () => {
      const baseRow = D().cache.estoque.find(x => x.sku === sel); const s = skuCalc(baseRow, S.estoqueOv[sel]);
      proporAcao({ tipo: 'reposicao', titulo: `Repor ${s.sku}`, descricao: `Pedir ${n1(s.Qstar)} un (ponto de pedido ${n1(s.rop)})`, payload: { sku: s.sku, q: s.Qstar, rop: s.rop } });
    };
  };

  /* ============================ PROJETOS (PERT — múltiplos, editável) ============================ */
  function renderProjetos() {
    const projs = D().projetos();
    if (S.projetoSel == null && projs.length) S.projetoSel = projs[0].id;
    const proj = projs.find(p => p.id === S.projetoSel) || projs[0];
    const pid = proj && proj.id;
    const linhas = (D().cache.pert || []).filter(r => r.projeto_id === pid).sort((a, b) => String(a.atividade).localeCompare(String(b.atividade)));
    const acts = pertBuild();
    const hasActs = Object.keys(acts).length > 0;
    const cpm = hasActs ? M().cpm(acts) : null;
    const prob = hasActs ? M().pertProb(cpm.critPath, acts, 80) : null;
    const crash = hasActs ? M().crashAuto(acts, S.pertBudget) : null;
    const stepOf = id => cpm && cpm.steps.find(s => s.id === id);
    S.iaTema = 'pert';
    if (hasActs) setTimeout(() => drawAON(acts, cpm, 'pAon'), 0);
    return `<div class="col">
      <div class="card"><h3>Projetos</h3>
        <div class="sub">Crie projetos e edite suas atividades; o caminho crítico e o prazo recalculam sozinhos.</div>
        <div class="row center">
          <label class="fld" style="flex-direction:row;align-items:center;gap:6px">projeto
            <select id="pjSel">${projs.map(p => `<option value="${p.id}"${p.id === pid ? ' selected' : ''}>${esc(p.nome)}</option>`).join('')}</select></label>
          <button class="btn sm" id="pjNovo">+ novo projeto</button>
          ${projs.length > 1 ? `<button class="btn sm sec" id="pjDel">excluir projeto</button>` : ''}
        </div>
      </div>
      ${hasActs ? `<div class="card"><h3>${esc(proj.nome)}</h3>
        <div class="row">
          <div class="kpi"><div class="l">Duração</div><div class="v">${n2(cpm.proj)} d</div></div>
          <div class="kpi"><div class="l">Variabilidade σ</div><div class="v">${n2(prob.sigma)}</div></div>
          <div class="kpi"><div class="l">Chance ≤ 80 dias</div><div class="v">${prob.P != null ? (prob.P * 100).toFixed(0) + '%' : '—'}</div></div>
          <div class="kpi"><div class="l">Prazo seguro (95%)</div><div class="v">${n1(prob.prazo95)} d</div></div>
        </div>
        <div class="small muted">Caminho crítico: ${cpm.critPath.join(' → ')}</div>
      </div>
      <div class="card"><h3>Compressão de prazo (crashing)</h3>
        <div class="row center">
          <label class="fld grow">Orçamento: <b>${brl(S.pertBudget)}</b><input id="pCr" type="range" min="0" max="114000" step="1000" value="${S.pertBudget}"></label>
          <div class="kpi"><div class="l">Duração comprimida</div><div class="v" style="color:var(--amber)">${n2(crash.finalDur)} d</div></div>
          <div class="kpi"><div class="l">Dias ganhos</div><div class="v">${n1(crash.normal - crash.finalDur)}</div></div>
          <div class="kpi"><div class="l">Gasto</div><div class="v" style="font-size:18px">${brl(crash.spent)}</div></div>
        </div>
        <div class="small muted">Plano: ${Object.entries(crash.plan).map(([k, v]) => k + ': ' + v + 'd').join(' · ') || '—'}</div>
      </div>
      <div class="card"><h3>Rede do projeto</h3><div id="pAon" style="overflow:auto"></div></div>` : `<div class="card"><div class="muted small">Projeto sem atividades. Adicione abaixo.</div></div>`}
      <div class="card"><h3>Atividades</h3>
        <div class="sub">Edite nome, predecessoras (ex.: "A,B") e as estimativas. Salva automaticamente.</div>
        <table><thead><tr><th>id</th><th>descrição</th><th>predec.</th><th>otim.</th><th>prov.</th><th>pess.</th><th>esp.</th><th>folga</th><th></th></tr></thead><tbody>
        ${linhas.map(r => { const st = stepOf(r.atividade); return `<tr class="${st && st.critical ? 'crit' : ''}">
          <td><input data-aid="${r.id}" data-af="atividade" value="${esc(r.atividade)}" style="width:44px"></td>
          <td style="text-align:left"><input data-aid="${r.id}" data-af="descricao" value="${esc(r.descricao || '')}" style="width:210px"></td>
          <td><input data-aid="${r.id}" data-af="predecessoras" value="${esc(r.predecessoras || '')}" style="width:64px"></td>
          <td><input data-aid="${r.id}" data-af="o" type="number" step="0.5" value="${r.tempo_otimista_dias}" style="width:52px"></td>
          <td><input data-aid="${r.id}" data-af="m" type="number" step="0.5" value="${r.tempo_provavel_dias}" style="width:52px"></td>
          <td><input data-aid="${r.id}" data-af="p" type="number" step="0.5" value="${r.tempo_pessimista_dias}" style="width:52px"></td>
          <td>${n2(r.tempo_esperado_te_dias)}</td><td>${st ? n1(st.slack) : '—'}</td>
          <td><button class="btn sm sec" data-adel="${r.id}">×</button></td></tr>`; }).join('')}
        </tbody></table>
        <button class="btn sm" id="pAdd" style="margin-top:8px">+ adicionar atividade</button>
      </div>
    </div>`;
  }
  postRender.projetos = () => {
    const reloadPert = async () => { D().cache.pert = (await window.sb.from('pert_atividades').select('*')).data || []; };
    const reloadProj = async () => { D().cache.projetos = (await window.sb.from('projetos').select('*')).data || []; };
    const pid = projetoAtualId();
    const sel = $('#pjSel'); if (sel) sel.onchange = () => { S.projetoSel = +sel.value; renderView(); };
    const nv = $('#pjNovo'); if (nv) nv.onclick = async () => {
      const nome = prompt('Nome do novo projeto:'); if (!nome) return;
      const ins = await window.sb.from('projetos').insert({ nome }).select().single();
      if (ins.error) return alert('Erro: ' + ins.error.message);
      await reloadProj(); S.projetoSel = ins.data.id; renderView();
    };
    const dl = $('#pjDel'); if (dl) dl.onclick = async () => {
      if (!confirm('Excluir este projeto e suas atividades?')) return;
      await window.sb.from('projetos').delete().eq('id', pid);
      await reloadProj(); await reloadPert(); S.projetoSel = (D().projetos()[0] || {}).id || null; renderView();
    };
    const cr = $('#pCr'); if (cr) cr.onchange = () => { S.pertBudget = +cr.value; renderView(); };
    const add = $('#pAdd'); if (add) add.onclick = async () => {
      const used = new Set((D().cache.pert || []).filter(r => r.projeto_id === pid).map(r => r.atividade));
      let lab = 'A'; for (let i = 65; i < 91; i++) { if (!used.has(String.fromCharCode(i))) { lab = String.fromCharCode(i); break; } }
      const t = M().pertTimes(1, 2, 3);
      const ins = await window.sb.from('pert_atividades').insert({ projeto_id: pid, atividade: lab, descricao: 'Nova atividade', tempo_otimista_dias: 1, tempo_provavel_dias: 2, tempo_pessimista_dias: 3, tempo_esperado_te_dias: t.te, variancia: t.variancia, desvio_padrao: t.desvio, max_dias_crashing: 0, custo_crash_por_dia: 0, origem: 'piloto' });
      if (ins.error) return alert('Erro: ' + ins.error.message);
      await reloadPert(); renderView();
    };
    document.querySelectorAll('[data-adel]').forEach(b => b.onclick = async () => { await window.sb.from('pert_atividades').delete().eq('id', b.dataset.adel); await reloadPert(); renderView(); });
    document.querySelectorAll('[data-aid]').forEach(inp => inp.onchange = async () => {
      const id = inp.dataset.aid, af = inp.dataset.af, row = (D().cache.pert || []).find(r => r.id == id); if (!row) return;
      let patch = {};
      if (af === 'o' || af === 'm' || af === 'p') {
        const o = af === 'o' ? +inp.value : row.tempo_otimista_dias, m = af === 'm' ? +inp.value : row.tempo_provavel_dias, p = af === 'p' ? +inp.value : row.tempo_pessimista_dias;
        const t = M().pertTimes(o, m, p); patch = { tempo_otimista_dias: o, tempo_provavel_dias: m, tempo_pessimista_dias: p, tempo_esperado_te_dias: t.te, variancia: t.variancia, desvio_padrao: t.desvio };
      } else if (af === 'atividade') patch = { atividade: inp.value.trim() };
      else if (af === 'descricao') patch = { descricao: inp.value };
      else patch = { predecessoras: inp.value.trim() || null };
      Object.assign(row, patch);
      const { error } = await window.sb.from('pert_atividades').update(patch).eq('id', id);
      if (error) alert('Erro ao salvar: ' + error.message);
      renderView();
    });
  };

  /* ============================ CONCORRÊNCIA (Jogos, interativo) ============================ */
  function renderConcorrencia() {
    const todos = D().jogosResolvido();
    if (!todos.length) return `<div class="card"><h3>Concorrência</h3><div class="smell">Sem cenários cadastrados. Carregue a base em Config & IA.</div></div>`;
    const j = jogoAtual();
    const precos = D().precosConcorrencia('');
    S.iaTema = 'jogos';
    return `<div class="col">
      <div class="card"><h3>Concorrência & promoções</h3>
        <div class="sub">Escolha um cenário, ajuste os ganhos de cada combinação e recalcule a melhor resposta.</div>
        <div class="row center"><label class="fld" style="flex-direction:row;align-items:center;gap:6px">cenário
          <select id="jSel">${todos.map(x => `<option value="${x.cenario}"${x.cenario === S.jogosSel ? ' selected' : ''}>${x.cenario} — ${esc(x.nome || '')}</option>`).join('')}</select></label></div>
      </div>
      ${j.triplo ? jogoTriploCard(j) : jogoEditCard(j)}
      <div class="card"><h3>Preços da concorrência</h3>
        ${precos.length ? `<table><thead><tr><th>categoria</th><th>produto</th><th>McD</th><th>BK</th><th>Subway</th><th>Madero/Habib's</th></tr></thead><tbody>
          ${precos.map(p => `<tr><td>${esc(p.categoria)}</td><td style="text-align:left">${esc(p.produto)}</td><td>${p.preco_mcd != null ? brl(p.preco_mcd) : '—'}</td><td>${p.preco_bk != null ? brl(p.preco_bk) : '—'}</td><td>${p.preco_subway != null ? brl(p.preco_subway) : '—'}</td><td>${p.preco_madero_habibs != null ? brl(p.preco_madero_habibs) : '—'}</td></tr>`).join('')}
          </tbody></table>` : '<div class="muted small">Preços ainda não coletados. O coletador pode enviar a planilha de campo.</div>'}
      </div>
    </div>`;
  }
  function jogoEditCard(j) {
    const nash = j.nash || [];
    const isNash = (i, jx) => nash.some(n => n.i === i && n.j === jx);
    const cellInput = (i, jx, k) => `<input data-ji="${i}" data-jj="${jx}" data-jk="${k}" type="number" value="${j.m[i][jx][k]}" style="width:56px">`;
    const tbl = `<table><thead><tr><th>${esc(j.jogador_linha)} ↓ / ${esc(j.jogador_coluna)} →</th>${j.estC.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${j.estL.map((rl, i) => `<tr><td>${esc(rl)}</td>${j.estC.map((cl, jx) => `<td class="${isNash(i, jx) ? 'crit' : ''}">${cellInput(i, jx, 0)} , ${cellInput(i, jx, 1)}${isNash(i, jx) ? ' ◀' : ''}</td>`).join('')}</tr>`).join('')}
      </tbody></table>`;
    const dom = j.dom || {};
    const domTxt = (dom.linha != null ? `${esc(j.jogador_linha)} prefere sempre "${esc(j.estL[dom.linha])}". ` : '') + (dom.coluna != null ? `${esc(j.jogador_coluna)} prefere sempre "${esc(j.estC[dom.coluna])}".` : '');
    const mixed = j.mixed ? `Em estratégia mista: ${esc(j.estL[0])} ${n2(j.mixed.p * 100)}% · ${esc(j.estC[0])} ${n2(j.mixed.q * 100)}%.` : '';
    return `<div class="card"><h3>Cenário ${j.cenario} — ${esc(j.nome || '')}${j.editado ? ' (editado)' : ''}</h3>
      <div class="sub">Valores em R$ mil por semana. Equilíbrio = ninguém melhora mudando sozinho.</div>
      ${tbl}
      <div class="row center" style="margin-top:8px"><button class="btn sm" id="jRecalc">Recalcular equilíbrio</button><button class="btn sm sec" id="jReset">Reverter</button>
        <span class="small">Equilíbrio: ${nash.length ? nash.map(n => `<b>${esc(j.estL[n.i])} × ${esc(j.estC[n.j])}</b> (${n0(n.payoff[0])}, ${n0(n.payoff[1])})`).join('; ') : 'nenhum puro — ver mista'}.</span></div>
      <div class="small muted" style="margin-top:6px">${domTxt} ${mixed}</div>
      ${j.divergente ? `<div class="smell">A classificação informada para este cenário (“${esc(j.rotulo)}”) diverge do equilíbrio calculado acima.</div>` : ''}
      <div class="row between center" style="margin-top:8px"><div class="small muted">${esc(j.comentario || '')}</div>
        <button class="btn" id="jPromo">Ativar promoção do equilíbrio</button></div>
    </div>`;
  }
  function jogoTriploCard(j) {
    return `<div class="card"><h3>Cenário ${j.cenario} — ${esc(j.nome || '')}</h3>
      <div class="sub">Disputa de 3 redes (${esc(j.jogador_linha)}, ${esc(j.jogador_coluna)}).</div>
      <div class="smell">Equilíbrio: <b>todas entram</b> (28, 22, 35) — entrada mesmo com o mercado dividido; Habib's, com vantagem local, fica com o maior ganho. A classificação informada (“${esc(j.rotulo)}”) sugere vários equilíbrios — divergência sinalizada.</div>
      <div class="small muted">${esc(j.comentario || '')}</div></div>`;
  }
  postRender.concorrencia = () => {
    const sel = $('#jSel'); if (sel) sel.onclick = sel.onchange = () => { if (sel.value !== S.jogosSel) { S.jogosSel = sel.value; renderView(); } };
    const readMatrix = () => { const base = jogoAtual(); const m = base.m.map(r => r.map(c => c.slice())); document.querySelectorAll('[data-ji]').forEach(i => { m[+i.dataset.ji][+i.dataset.jj][+i.dataset.jk] = +i.value; }); return m; };
    const rc = $('#jRecalc'); if (rc) rc.onclick = () => { S.jogosOv[S.jogosSel] = readMatrix(); renderView(); };
    const rs = $('#jReset'); if (rs) rs.onclick = () => { delete S.jogosOv[S.jogosSel]; renderView(); };
    const pr = $('#jPromo'); if (pr) pr.onclick = () => {
      const j = jogoAtual(); const ne = (j.nash || [])[0];
      proporAcao({ tipo: 'promocao', titulo: `Promoção — cenário ${j.cenario}`, descricao: ne ? `Estratégia "${j.estL[ne.i]}" (equilíbrio vs ${j.jogador_coluna})` : 'definir estratégia', payload: { cenario: j.cenario, estrategia: ne ? j.estL[ne.i] : null } });
    };
  };

  /* ============================ CADASTRO (produtos + funcionários) ============================ */
  function renderCadastro() {
    const segs = [{ id: 'produtos', nome: 'Produtos' }, { id: 'funcionarios', nome: 'Funcionários' }];
    const head = `<div class="card"><div class="row center">${segs.map(s => `<button class="btn sm ${S.cadSeg === s.id ? '' : 'sec'}" data-cad="${s.id}">${s.nome}</button>`).join('')}</div></div>`;
    return `<div class="col">${head}${S.cadSeg === 'funcionarios' ? cadFuncionarios() : cadProdutos()}</div>`;
  }
  function cadProdutos() {
    const rows = (D().cache.estoque || []).slice().sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    return `<div class="card"><h3>Produtos</h3>
      <div class="sub">Cadastre os produtos/insumos. Entram no Estoque (EOQ) e na lista do PDV.</div>
      <div class="row" style="align-items:flex-end">
        <label class="fld" style="width:110px">SKU<input id="np_sku" placeholder="SKU-016"></label>
        <label class="fld grow">Descrição<input id="np_desc" placeholder="nome do produto"></label>
        <label class="fld" style="width:100px">Demanda/ano<input id="np_D" type="number" value="500"></label>
        <label class="fld" style="width:100px">Custo pedido<input id="np_S" type="number" value="20"></label>
        <label class="fld" style="width:110px">Custo manter<input id="np_H" type="number" value="10"></label>
        <label class="fld" style="width:90px">Preço<input id="np_preco" type="number" value="0"></label>
        <label class="fld" style="width:80px">Lead (d)<input id="np_L" type="number" value="3"></label>
        <label class="fld" style="width:80px">Validade<input id="np_val" type="number" value="30"></label>
        <button class="btn" id="npAdd">adicionar</button>
      </div>
      <span class="small muted" id="npMsg"></span>
      <table style="margin-top:10px"><thead><tr><th>SKU</th><th>descrição</th><th>preço</th><th>demanda</th><th>lead</th><th>validade</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r.sku)}</td>
        <td style="text-align:left"><input data-pid="${esc(r.sku)}" data-pf="descricao" value="${esc(r.descricao || '')}" style="width:200px"></td>
        <td><input data-pid="${esc(r.sku)}" data-pf="preco_unitario" type="number" value="${r.preco_unitario != null ? r.preco_unitario : ''}" style="width:80px"></td>
        <td>${n0(r.demanda_anual)}</td><td>${r.lead_time_dias}</td><td>${r.validade_dias}</td>
        <td><button class="btn sm sec" data-pdel="${esc(r.sku)}">excluir</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function cadFuncionarios() {
    const rows = D().funcionarios();
    return `<div class="card"><h3>Funcionários</h3>
      <div class="sub">Equipe da loja (sem login). Aparece na escala e no turno do KDS.</div>
      <div class="row" style="align-items:flex-end">
        <label class="fld grow">Nome<input id="nf_nome" placeholder="nome"></label>
        <label class="fld" style="width:170px">Função<input id="nf_func" placeholder="atendente / cozinha"></label>
        <label class="fld" style="width:150px">Canal<select id="nf_canal"><option value="">—</option>${D().CANAIS.map(c => `<option value="${c}">${canalLabel[c]}</option>`).join('')}</select></label>
        <button class="btn" id="nfAdd">adicionar</button>
      </div>
      <span class="small muted" id="nfMsg"></span>
      <table style="margin-top:10px"><thead><tr><th>nome</th><th>função</th><th>canal</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map(r => `<tr><td style="text-align:left">${esc(r.nome)}</td><td>${esc(r.funcao || '—')}</td><td>${esc(canalLabel[r.canal] || r.canal || '—')}</td><td><button class="btn sm sec" data-fdel="${r.id}">excluir</button></td></tr>`).join('') : '<tr><td colspan="4" class="muted small">Nenhum funcionário cadastrado.</td></tr>'}
      </tbody></table></div>`;
  }
  postRender.cadastro = () => {
    document.querySelectorAll('[data-cad]').forEach(b => b.onclick = () => { S.cadSeg = b.dataset.cad; renderView(); });
    const reloadEstoque = async () => { D().cache.estoque = (await window.sb.from('estoque').select('*')).data || []; };
    const reloadFunc = async () => { D().cache.funcionarios = (await window.sb.from('funcionarios').select('*')).data || []; };
    if (S.cadSeg === 'produtos') {
      const add = $('#npAdd'); if (add) add.onclick = async () => {
        const sku = $('#np_sku').value.trim(), desc = $('#np_desc').value.trim();
        if (!sku || !desc) { $('#npMsg').textContent = 'informe SKU e descrição'; return; }
        const rec = { sku, descricao: desc, demanda_anual: +$('#np_D').value || 0, custo_pedido: +$('#np_S').value || 0, custo_manutencao: +$('#np_H').value || 0, preco_unitario: +$('#np_preco').value || 0, lead_time_dias: +$('#np_L').value || 0, validade_dias: +$('#np_val').value || 0, viola_validade: false, origem: 'piloto' };
        const { error } = await window.sb.from('estoque').insert(rec);
        $('#npMsg').textContent = error ? 'erro: ' + error.message : 'produto adicionado ✔'; if (!error) { await reloadEstoque(); renderView(); }
      };
      document.querySelectorAll('[data-pdel]').forEach(b => b.onclick = async () => { if (!confirm('Excluir ' + b.dataset.pdel + '?')) return; await window.sb.from('estoque').delete().eq('sku', b.dataset.pdel); await reloadEstoque(); renderView(); });
      document.querySelectorAll('[data-pid]').forEach(i => i.onchange = async () => { const patch = {}; patch[i.dataset.pf] = i.dataset.pf === 'preco_unitario' ? (+i.value || 0) : i.value; await window.sb.from('estoque').update(patch).eq('sku', i.dataset.pid); const r = D().cache.estoque.find(x => x.sku === i.dataset.pid); if (r) Object.assign(r, patch); });
    } else {
      const add = $('#nfAdd'); if (add) add.onclick = async () => {
        const nome = $('#nf_nome').value.trim(); if (!nome) { $('#nfMsg').textContent = 'informe o nome'; return; }
        const { error } = await window.sb.from('funcionarios').insert({ nome, funcao: $('#nf_func').value.trim() || null, canal: $('#nf_canal').value || null });
        $('#nfMsg').textContent = error ? 'erro: ' + error.message : 'funcionário adicionado ✔'; if (!error) { await reloadFunc(); renderView(); }
      };
      document.querySelectorAll('[data-fdel]').forEach(b => b.onclick = async () => { await window.sb.from('funcionarios').delete().eq('id', b.dataset.fdel); await reloadFunc(); renderView(); });
    }
  };

  /* ============================ OPERAÇÃO (espinha decisão→operação) ============================ */
  function proporAcao(a) { S.pendentes.push({ ...a, id: 'p' + (S.pendentes.length + 1) }); S.view = 'operacao'; mountCockpit(); }
  function renderOper() {
    return `<div class="col">
      <div class="card"><h3>Ações a publicar</h3>
        <div class="sub">Revise e confirme. Ao publicar, a tarefa aparece para a equipe (KDS).</div>
        ${S.pendentes.length ? S.pendentes.map(p => `<div class="row between center" style="border-bottom:1px solid var(--line);padding:10px 0">
          <div><span class="tag campo">${p.tipo}</span> <b>${esc(p.titulo)}</b><div class="small muted">${esc(p.descricao)}</div></div>
          <div class="row"><button class="btn sm" data-pub="${p.id}">Confirmar e publicar</button><button class="btn sm sec" data-desc="${p.id}">descartar</button></div></div>`).join('')
        : '<div class="muted small">Nada pendente. Gere ações em Atendimento, Estoque ou Concorrência.</div>'}
      </div>
      <div class="card"><h3>Publicado recentemente</h3><div id="pubList" class="small muted">carregando…</div></div>
    </div>`;
  }
  postRender.operacao = () => {
    document.querySelectorAll('[data-pub]').forEach(b => b.onclick = () => publicar(b.dataset.pub));
    document.querySelectorAll('[data-desc]').forEach(b => b.onclick = () => { S.pendentes = S.pendentes.filter(p => p.id !== b.dataset.desc); renderView(); });
    listarPublicados();
  };
  async function publicar(pid) {
    const p = S.pendentes.find(x => x.id === pid); if (!p) return;
    if (!confirm(`Publicar "${p.titulo}" para a equipe?`)) return;
    const { error } = await window.sb.from('tarefas').insert({ tipo: p.tipo, titulo: p.titulo, descricao: p.descricao, payload: p.payload });
    if (!error && p.tipo === 'promocao') await window.sb.from('promo').insert({ descricao: p.titulo + ' — ' + p.descricao, cenario: p.payload.cenario, estrategia: p.payload.estrategia });
    if (error) return alert('Erro ao publicar: ' + error.message);
    S.pendentes = S.pendentes.filter(x => x.id !== pid); renderView();
  }
  async function listarPublicados() {
    const { data } = await window.sb.from('tarefas').select('*').order('publicado_em', { ascending: false }).limit(8);
    const el = $('#pubList'); if (!el) return;
    el.innerHTML = (data && data.length) ? data.map(t => `<div>• <span class="tag ${t.status === 'feito' ? 'ok' : 'warn'}">${t.status}</span> ${esc(t.titulo)} — ${esc(t.descricao || '')}</div>`).join('') : 'nada publicado ainda.';
  }

  /* ============================ CONFIG & IA ============================ */
  function renderConfig() {
    return `<div class="col">
      <div class="card"><h3>Base de dados</h3>
        <div class="row center"><button class="btn" id="btnSeed">Carregar base</button><span class="small muted" id="seedLog">não recarrega o que já existe</span></div>
        <div class="sub" style="margin-top:14px">Importar coleta de campo (CSV)</div>
        <div class="row center">
          <select id="impTipo"><option value="snapshots">Filas — snapshots</option><option value="drive">Drive-thru</option><option value="precos">Preços</option><option value="chegadas">Chegadas</option></select>
          <input type="file" id="impFile" accept=".csv" />
          <button class="btn sec" id="btnImp">Importar</button>
        </div>
      </div>
      ${formulaEditor()}
      <div class="card"><h3>Sobre o copiloto</h3>
        <div class="sub">Como o assistente funciona: ele interpreta os números do sistema e cita a fórmula usada; não faz as contas; só age após você confirmar.</div>
        <div class="formula" style="white-space:pre-wrap">${esc(AI().SYSTEM_PROMPT)}</div>
        <table style="margin-top:10px"><thead><tr><th>tema</th><th>fórmula citada</th><th>base</th></tr></thead><tbody>
        ${Object.entries(AI().FONTES).map(([k, f]) => `<tr><td>${k}</td><td style="text-align:left">${esc(f.formula)}</td><td style="text-align:left">${esc(f.fonte)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card"><h3>Exportar</h3>
        <div class="row"><button class="btn" onclick="window.print()">Relatório (PDF)</button><button class="btn sec" id="btnMem2">Memória de cálculo</button></div>
      </div>
    </div>`;
  }
  postRender.config = () => {
    $('#btnSeed').onclick = async () => {
      const log = m => { $('#seedLog').textContent = m; };
      try { $('#btnSeed').disabled = true; const r = await ING().seedPiloto(log); log('OK: ' + JSON.stringify(r)); Object.keys(D().cache).forEach(k => D().cache[k] = null); }
      catch (e) { log('Erro: ' + e.message); } finally { $('#btnSeed').disabled = false; }
    };
    $('#btnImp').onclick = async () => {
      const file = $('#impFile').files[0]; if (!file) return alert('escolha um CSV');
      try { const n = await ING().importCampoCSV(file, $('#impTipo').value, m => $('#seedLog').textContent = m); alert(n + ' linhas importadas.'); Object.keys(D().cache).forEach(k => D().cache[k] = null); }
      catch (e) { alert('Erro: ' + e.message); }
    };
    $('#btnMem2').onclick = exportMemoria;
    bindFormulaEditor();
  };

  /* ---------- editor de fórmula (math.js, sem eval) ---------- */
  const CANONICAS = {
    'Lote econômico (EOQ)': { expr: 'sqrt(2*D*S/H)', vars: { D: 2200, S: 220, H: 15 }, canon: '√(2DS/H)' },
    'Ponto de pedido': { expr: 'd*L + z*sigma*sqrt(L)', vars: { d: 6, L: 5, z: 1.645, sigma: 2 }, canon: 'd·L + z·σ·√L' },
    'Espera na fila': { expr: 'C/(s*mu - lam)', vars: { C: 0.4, s: 4, mu: 0.46, lam: 1.26 }, canon: 'C/(s·μ−λ)' },
    'Tempo esperado (PERT)': { expr: '(o + 4*m + p)/6', vars: { o: 5, m: 7, p: 12 }, canon: '(o+4m+p)/6' },
  };
  function formulaEditor() {
    return `<div class="card"><h3>Editor de fórmula</h3>
      <div class="sub">A fórmula padrão fica sempre à vista; o sistema avisa quando a equação em uso difere dela.</div>
      <div class="row center"><label class="fld" style="flex-direction:row;align-items:center;gap:6px">fórmula
        <select id="feSel">${Object.keys(CANONICAS).map(k => `<option>${k}</option>`).join('')}</select></label></div>
      <div id="feBox"></div></div>`;
  }
  function bindFormulaEditor() {
    const sel = $('#feSel'); if (!sel) return;
    const render = () => {
      const c = CANONICAS[sel.value], cur = S.custom[sel.value] || c.expr;
      $('#feBox').innerHTML = `
        <div class="small muted" style="margin:8px 0">Padrão: <span class="formula" style="display:inline-block">${esc(c.canon)} → <b>${esc(c.expr)}</b></span></div>
        <label class="fld">equação em uso (editável)<input id="feExpr" value="${esc(cur)}" /></label>
        <div class="row" style="margin:8px 0">${Object.keys(c.vars).map(v => `<label class="fld" style="width:90px">${v}<input id="fv_${v}" value="${c.vars[v]}" /></label>`).join('')}</div>
        <button class="btn sm" id="feCalc">avaliar</button><div id="feOut" class="small" style="margin-top:8px"></div>`;
      $('#feCalc').onclick = () => {
        const c2 = CANONICAS[sel.value], scope = {};
        Object.keys(c2.vars).forEach(v => scope[v] = parseFloat($('#fv_' + v).value));
        const expr = $('#feExpr').value; let canonVal, customVal, err = '';
        try { canonVal = window.math.evaluate(c2.expr, scope); customVal = window.math.evaluate(expr, scope); } catch (e) { err = e.message; }
        const desvio = !err && Math.abs(canonVal - customVal) > 1e-9;
        S.custom[sel.value] = (expr !== c2.expr) ? expr : undefined;
        $('#feOut').innerHTML = err ? `<span class="tag bad">erro: ${esc(err)}</span>`
          : `Padrão = <b>${n2(canonVal)}</b> · Em uso = <b>${n2(customVal)}</b> ${desvio ? '<span class="tag warn">difere do padrão</span>' : '<span class="tag ok">igual ao padrão</span>'}`;
      };
    };
    sel.onchange = render; render();
  }

  /* ============================ AON ============================ */
  function drawAON(acts, cpm, hostId) {
    const host = document.getElementById(hostId); if (!host) return;
    const ids = Object.keys(acts);
    const lanes = {}, laneOf = {};
    ids.sort((a, b) => cpm.steps.find(s => s.id === a).ES - cpm.steps.find(s => s.id === b).ES);
    ids.forEach(id => { const es = cpm.steps.find(s => s.id === id).ES; let lane = 0; while ((lanes[lane] || -1) > es - 1) lane++; lanes[lane] = es + acts[id].dur; laneOf[id] = lane; });
    const maxES = Math.max(...cpm.steps.map(s => s.EF));
    const W = Math.max(900, maxES * 11), laneH = 54, H = (Math.max(...Object.values(laneOf)) + 1) * laneH + 20;
    const X = es => 30 + es * (W - 80) / maxES, Y = l => 10 + l * laneH;
    const crit = new Set(cpm.critPath);
    let svg = `<svg width="${W}" height="${H}">`;
    ids.forEach(id => (acts[id].dep || []).forEach(p => {
      const s1 = cpm.steps.find(s => s.id === p), s2 = cpm.steps.find(s => s.id === id);
      const on = crit.has(p) && crit.has(id);
      svg += `<line x1="${X(s1.EF)}" y1="${Y(laneOf[p]) + 18}" x2="${X(s2.ES)}" y2="${Y(laneOf[id]) + 18}" stroke="${on ? '#ffbc0d' : '#2a3340'}" stroke-width="${on ? 2.5 : 1.5}"/>`;
    }));
    ids.forEach(id => { const st = cpm.steps.find(x => x.id === id); const x = X(st.ES), y = Y(laneOf[id]); const c = crit.has(id);
      svg += `<g><rect x="${x}" y="${y}" width="64" height="36" rx="7" fill="${c ? 'rgba(255,188,13,.18)' : '#1b212b'}" stroke="${c ? '#ffbc0d' : '#2a3340'}"/><text x="${x + 8}" y="${y + 16}" fill="${c ? '#ffbc0d' : '#e8edf4'}" font-size="13" font-weight="700">${id}</text><text x="${x + 8}" y="${y + 29}" fill="#9aa7b8" font-size="10">${n1(acts[id].dur)}d</text></g>`; });
    host.innerHTML = svg + `</svg>`;
  }

  /* ============================ EXPORT memória ============================ */
  function exportMemoria() {
    const f = S.filtros; let txt = `MAESTRO — MEMÓRIA DE CÁLCULO\nGerado: ${new Date().toLocaleString('pt-BR')}\nFiltro: origem=${f.origem || 'ambos'} · canal=${f.canal} · ${PERIODOS[f.periodo].nome}\n\n`;
    const fm = filasMetrics(f.canal, f.hora, f.origem, S.atend.alvoWq);
    if (fm) txt += `=== ATENDIMENTO (Erlang-C / M/M/s) ===\nFórmula: Wq = C/(s·μ − λ)\nλ=${n2(fm.lam)}/min; μ=${n2(fm.mu)}/min; a=λ/μ=${n2(fm.lam / fm.mu)}\nEquipe recomendada=${fm.rec.rec}; Wq=${n2(fm.recRow.Wq)} min; ρ=${n2(fm.recRow.rho)}\n\n`;
    const acts = pertBuild(); if (Object.keys(acts).length) { const cpm = M().cpm(acts), prob = M().pertProb(cpm.critPath, acts, 80), cr = M().crashAuto(acts, S.pertBudget);
      txt += `=== PROJETO (PERT/CPM) ===\nDuração=${n2(cpm.proj)}d; caminho crítico=${cpm.critPath.join('→')}\nσ=${n2(prob.sigma)}; P(≤80)=${(prob.P * 100).toFixed(0)}%; prazo 95%=${n1(prob.prazo95)}d\nCom ${brl(S.pertBudget)} → ${n2(cr.finalDur)}d\n\n`; }
    const baseRow = D().cache.estoque ? (D().cache.estoque.find(x => x.sku === S.estoqueSel) || D().cache.estoque[0]) : null;
    if (baseRow) { const s = skuCalc(baseRow, S.estoqueOv[S.estoqueSel]); txt += `=== ESTOQUE (EOQ) ===\n${s.sku} ${s.descricao}\nQ*=√(2·${n0(s.D)}·${n0(s.S)}/${n1(s.H)})=${n1(s.Qstar)}; ponto de pedido=${n1(s.rop)} (segurança ${n1(s.ss)})\n\n`; }
    txt += `=== CONCORRÊNCIA (Nash) ===\n` + D().jogosResolvido().map(j => `Cenário ${j.cenario}: ${j.triplo ? 'todas entram (28,22,35)' : 'equilíbrio=' + ((j.nash || []).map(n => '(' + j.estL[n.i] + ',' + j.estC[n.j] + ')').join(';') || 'mista')}${j.divergente ? ' [classificação informada diverge]' : ''}`).join('\n') + '\n';
    const cust = Object.entries(S.custom).filter(([, v]) => v);
    if (cust.length) txt += `\n=== FÓRMULAS EM USO (diferentes do padrão) ===\n` + cust.map(([k, v]) => `${k}: padrão="${CANONICAS[k].expr}" → em uso="${v}"`).join('\n') + '\n';
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'maestro_memoria_calculo.txt'; a.click();
  }

  /* ============================ IA panel ============================ */
  function iaCtx() {
    if (S.iaTema === 'filas') { const fm = filasMetrics(S.filtros.canal, S.filtros.hora, S.filtros.origem, S.atend.alvoWq); return fm ? { rec: fm.rec.rec, wq: fm.recRow.Wq, mu: fm.mu, lam: fm.lam, canal: S.filtros.canal } : {}; }
    if (S.iaTema === 'pert') { const acts = pertBuild(), cpm = M().cpm(acts), prob = M().pertProb(cpm.critPath, acts, 80); return { proj: cpm.proj, cp: cpm.critPath.join('→'), P80: prob.P }; }
    if (S.iaTema === 'eoq') { const baseRow = D().cache.estoque.find(x => x.sku === S.estoqueSel) || D().cache.estoque[0]; const s = skuCalc(baseRow, S.estoqueOv[S.estoqueSel]); return { sku: s.sku, Qstar: s.Qstar, rop: s.rop, classe: s.classe }; }
    const j = jogoAtual(); return { cenario: j && j.cenario, nash: j && !j.triplo && (j.nash[0] ? `(${j.estL[j.nash[0].i]},${j.estC[j.nash[0].j]})` : 'mista') };
  }
  function iaPush(who, text, cite) {
    S.iaMsgs.push({ who, text, cite });
    $('#iaMsgs').innerHTML = S.iaMsgs.map(m => `<div class="ia-msg ${m.who}">${esc(m.text)}${m.cite ? `<div class="ia-cite">📐 ${esc(m.cite)}</div>` : ''}</div>`).join('');
    $('#iaMsgs').scrollTop = 1e9;
  }
  async function iaSend() {
    const inp = $('#iaInput'); const q = inp.value.trim(); if (!q) return; inp.value = '';
    iaPush('eu', q); iaPush('ia', '…pensando');
    const res = await AI().ask(S.iaTema, q, iaCtx(), Object.values(S.custom).some(Boolean));
    S.iaMsgs.pop();
    iaPush('ia', res.text, res.fonte ? (res.fonte.formula + ' — ' + res.fonte.fonte) + (res.fallback ? ' [offline]' : '') : '');
  }

  /* ============================ KDS (funcionário) — tela única, um foco por vez ============================ */
  const KDS_SEGS = [{ id: 'preparo', nome: 'Preparo' }, { id: 'reposicao', nome: 'Reposição' }, { id: 'pdv', nome: 'PDV' }, { id: 'turno', nome: 'Meu turno' }];
  let kdsCache = { tarefas: [], promo: null, produtos: [], funcionarios: [] };
  async function mountKDS() {
    const app = $('#app');
    app.innerHTML = `<div class="topbar"><div class="wrap row between center" style="padding:0"><span class="brand">Mae<b>stro</b> · KDS</span>
      <div class="row center"><span class="muted small">${esc(S.profile.nome)}</span><button class="btn sm" id="btnOut">sair</button></div></div>
      <div class="wrap nav" style="padding:8px 0 0" id="kdsNav">${KDS_SEGS.map(s => `<button data-k="${s.id}" class="${S.kdsSeg === s.id ? 'active' : ''}">${s.nome}</button>`).join('')}</div></div>
      <div class="wrap" id="content"></div>`;
    $('#btnOut').onclick = logout;
    document.querySelectorAll('#kdsNav button').forEach(b => b.onclick = () => { S.kdsSeg = b.dataset.k; document.querySelectorAll('#kdsNav button').forEach(x => x.classList.toggle('active', x === b)); renderKDS(); });
    const t = await window.sb.from('tarefas').select('*').order('publicado_em', { ascending: false });
    const pr = await window.sb.from('promo').select('*').eq('ativo', true).order('publicado_em', { ascending: false }).limit(1);
    const pd = await window.sb.from('estoque').select('sku,descricao').order('sku');
    const fu = await window.sb.from('funcionarios').select('*').eq('ativo', true);
    kdsCache.tarefas = t.data || []; kdsCache.promo = (pr.data && pr.data[0]) || null;
    kdsCache.produtos = pd.data || []; kdsCache.funcionarios = fu.data || [];
    renderKDS();
  }
  function renderKDS() {
    const c = $('#content'); if (!c) return;
    if (S.kdsSeg === 'preparo') c.innerHTML = kdsPreparo();
    else if (S.kdsSeg === 'reposicao') c.innerHTML = kdsReposicao();
    else if (S.kdsSeg === 'pdv') c.innerHTML = kdsPDV();
    else c.innerHTML = kdsTurno();
    bindKDS();
  }
  const SAND = { A: { dur: 50, dep: [], nome: 'Grelhar 2 carnes' }, B: { dur: 40, dep: [], nome: 'Tostar o pão' }, C: { dur: 15, dep: ['B'], nome: 'Molho no pão' }, D2: { dur: 10, dep: ['A', 'C'], nome: 'Montar base' }, E: { dur: 15, dep: ['D2'], nome: 'Queijo + picles' }, F: { dur: 15, dep: ['E'], nome: 'Alface + 2ª camada' }, G: { dur: 10, dep: ['F'], nome: 'Fechar + embalar' } };
  function kdsPreparo() {
    const cpm = M().cpm(SAND);
    const ord = cpm.steps.slice().sort((a, b) => a.ES - b.ES);
    return `<div class="col"><div class="card"><h3>Ordem de preparo do sanduíche</h3>
      <div class="sub">Siga a sequência; os passos do caminho crítico definem o tempo total (${n0(cpm.proj)}s).</div>
      <div class="row center" style="margin:6px 0"><button class="btn" id="prepStart">▶ iniciar</button><button class="btn sec" id="prepReset">zerar</button><span id="prepTimer" class="mono" style="font-size:20px">0s / ${cpm.proj}s</span></div>
      <div class="col" style="gap:6px">
      ${ord.map(s => `<label class="row center" style="gap:10px;border-bottom:1px solid var(--line);padding:8px 0">
        <input type="checkbox" data-step="${s.id}" style="width:18px;height:18px">
        <span class="tag ${s.critical ? 'campo' : 'piloto'}">${n0(s.dur)}s</span>
        <b style="flex:1">${esc(SAND[s.id].nome)}</b>
        <span class="small muted">${s.critical ? 'crítico' : 'folga ' + n0(s.slack) + 's'}</span></label>`).join('')}
      </div></div></div>`;
  }
  function kdsReposicao() {
    const ts = kdsCache.tarefas.filter(t => t.tipo === 'reposicao');
    return `<div class="col"><div class="card"><h3>Reposição de insumos</h3>
      <div class="sub">Tarefas vindas do controle de estoque. Concluir dá entrada no estoque.</div>
      ${ts.length ? ts.map(t => `<div class="row between center" style="border-bottom:1px solid var(--line);padding:10px 0">
        <div><span class="tag ${t.status === 'feito' ? 'ok' : 'warn'}">${t.status}</span> <b>${esc(t.titulo)}</b><div class="small muted">${esc(t.descricao || '')}</div></div>
        ${t.status !== 'feito' ? `<button class="btn sm" data-rep="${t.id}">recebi / repor</button>` : '✔'}</div>`).join('') : '<div class="muted small">Sem reposições pendentes.</div>'}
    </div></div>`;
  }
  function kdsPDV() {
    const opts = (kdsCache.produtos || []).map(p => `<option value="${esc(p.sku)}">${esc(p.sku)} — ${esc(p.descricao || '')}</option>`).join('');
    return `<div class="col"><div class="card"><h3>Registrar venda / consumo</h3>
      <div class="sub">Escolha o produto e a quantidade; a baixa alimenta o controle de estoque.</div>
      <div class="row center"><select id="pdvSku" style="min-width:240px">${opts || '<option value="">(sem produtos cadastrados)</option>'}</select><input id="pdvQ" type="number" placeholder="qtd" style="width:90px"><button class="btn" id="pdvReg">registrar baixa</button><span id="pdvMsg" class="small muted"></span></div>
    </div></div>`;
  }
  function kdsTurno() {
    const escTar = kdsCache.tarefas.filter(t => t.tipo === 'escala')[0];
    const canal = escTar && escTar.payload && escTar.payload.canal;
    const roster = (kdsCache.funcionarios || []).filter(f => !canal || !f.canal || f.canal === canal);
    const outras = kdsCache.tarefas.filter(t => t.tipo !== 'reposicao' && t.tipo !== 'escala');
    return `<div class="col">
      <div class="card"><h3>Minha escala agora</h3>${escTar ? `<div style="font-size:22px;font-weight:800;color:var(--amber)">${esc(escTar.titulo)}</div><div class="muted">${esc(escTar.descricao || '')}</div>` : '<div class="muted small">Sem escala publicada ainda.</div>'}</div>
      <div class="card"><h3>Equipe${canal ? ' · ' + esc(canalLabel[canal] || canal) : ''}</h3>${roster.length ? roster.map(f => `<div class="row center" style="gap:8px;padding:4px 0"><b>${esc(f.nome)}</b><span class="small muted">${esc(f.funcao || '')}${f.canal ? ' · ' + esc(canalLabel[f.canal] || f.canal) : ''}</span></div>`).join('') : '<span class="muted small">Nenhum funcionário cadastrado (o gerente cadastra em Cadastro → Funcionários).</span>'}</div>
      <div class="card"><h3>Promoção ativa</h3>${kdsCache.promo ? `<div style="font-size:18px;font-weight:700">${esc(kdsCache.promo.descricao)}</div>` : '<span class="muted small">Nenhuma promoção ativa.</span>'}</div>
      <div class="card"><h3>Avisos do turno</h3>
        ${outras.length ? outras.map(t => `<div class="row between center" style="border-bottom:1px solid var(--line);padding:8px 0"><div><span class="tag ${t.status === 'feito' ? 'ok' : 'warn'}">${t.tipo}</span> ${esc(t.titulo)}</div>${t.status !== 'feito' ? `<button class="btn sm sec" data-done="${t.id}">ok</button>` : '✔'}</div>`).join('') : '<div class="muted small">Nada por aqui.</div>'}
      </div></div>`;
  }
  function bindKDS() {
    if (S.kdsSeg === 'preparo') {
      const cpm = M().cpm(SAND); let t0 = null, raf;
      const tick = () => { if (t0 == null) return; const s = (Date.now() - t0) / 1000; const el = $('#prepTimer'); if (el) el.textContent = s.toFixed(0) + 's / ' + cpm.proj + 's'; if (s < cpm.proj + 3) raf = requestAnimationFrame(tick); };
      const sb = $('#prepStart'); if (sb) sb.onclick = () => { t0 = Date.now(); tick(); };
      const rb = $('#prepReset'); if (rb) rb.onclick = () => { t0 = null; cancelAnimationFrame(raf); $('#prepTimer').textContent = '0s / ' + cpm.proj + 's'; document.querySelectorAll('[data-step]').forEach(c => c.checked = false); };
    }
    if (S.kdsSeg === 'reposicao') document.querySelectorAll('[data-rep]').forEach(b => b.onclick = async () => {
      const t = kdsCache.tarefas.find(x => x.id == b.dataset.rep);
      await window.sb.from('tarefas').update({ status: 'feito', concluido_em: new Date().toISOString(), concluido_por: S.session.user.id }).eq('id', b.dataset.rep);
      if (t && t.payload && t.payload.sku && t.payload.q != null) {
        const cur = (await window.sb.from('estoque').select('estoque_atual').eq('sku', t.payload.sku).maybeSingle()).data;
        if (cur) { const up = await window.sb.from('estoque').update({ estoque_atual: (+cur.estoque_atual || 0) + (+t.payload.q || 0) }).eq('sku', t.payload.sku); if (up.error) alert('Tarefa concluída, mas a entrada no estoque falhou: ' + up.error.message); }
      }
      mountKDS();
    });
    if (S.kdsSeg === 'pdv') { const b = $('#pdvReg'); if (b) b.onclick = async () => {
      const sku = $('#pdvSku').value.trim(), q = parseFloat($('#pdvQ').value); if (!sku || !q) return;
      const { error } = await window.sb.from('consumo').insert({ sku, consumo_unidades: q, data_inicio_semana: new Date().toISOString().slice(0, 10), origem: 'campo', registrado_por: S.session.user.id });
      $('#pdvMsg').textContent = error ? 'erro: ' + error.message : 'baixa registrada ✔';
    }; }
    if (S.kdsSeg === 'turno') document.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
      await window.sb.from('tarefas').update({ status: 'feito', concluido_em: new Date().toISOString(), concluido_por: S.session.user.id }).eq('id', b.dataset.done); mountKDS();
    });
  }

  /* ============================ COLETA (coletador) ============================ */
  async function mountColeta() {
    const app = $('#app');
    app.innerHTML = `<div class="topbar"><div class="wrap row between center" style="padding:0"><span class="brand">Mae<b>stro</b> · Coleta</span><div class="row center"><span class="muted small">${esc(S.profile.nome)}</span><button class="btn sm" id="btnOut">sair</button></div></div></div><div class="wrap" id="content"></div>`;
    $('#btnOut').onclick = logout;
    $('#content').innerHTML = `<div class="col">
      <div class="card"><h3>Cronometragem ao vivo</h3>
        <div class="sub">Toque "marcar" na chegada e de novo no fim do atendimento. As estatísticas atualizam sozinhas.</div>
        <div class="row center">
          <select id="cCanal">${D().CANAIS.map(c => `<option value="${c}">${canalLabel[c] || c}</option>`).join('')}</select>
          <button class="btn" id="cEvt">marcar</button><button class="btn sec" id="cUndo">desfazer</button><span id="cStat" class="small muted"></span>
        </div>
        <div class="row" style="margin-top:10px">
          <div class="kpi"><div class="l">Atendimentos</div><div class="v" id="cN">0</div></div>
          <div class="kpi"><div class="l">Serviço médio</div><div class="v" id="cMed">—</div><div class="small muted">min</div></div>
          <div class="kpi"><div class="l">μ (atend./min)</div><div class="v" id="cMu">—</div></div>
          <div class="kpi"><div class="l">λ (cheg./min)</div><div class="v" id="cLam">—</div></div>
        </div>
        <table style="margin-top:10px"><thead><tr><th>#</th><th>canal</th><th>chegada</th><th>serviço (s)</th></tr></thead><tbody id="cBody"></tbody></table>
        <button class="btn sm" id="cSave" style="margin-top:10px">enviar ao sistema</button>
      </div>
      <div class="card"><h3>Sessões enviadas</h3><div id="cHist" class="small muted">carregando…</div></div>
      <div class="card"><h3>Upload da planilha de campo (CSV)</h3>
        <div class="row center"><select id="upTipo"><option value="snapshots">Snapshots</option><option value="drive">Drive-thru</option><option value="precos">Preços</option></select>
        <input type="file" id="upFile" accept=".csv"/><button class="btn sec" id="upBtn">enviar</button><span id="upMsg" class="small muted"></span></div></div>
    </div>`;
    const eventos = []; let pend = null;
    const stats = () => {
      const done = eventos.filter(e => e.servico != null);
      $('#cN').textContent = done.length;
      const med = done.length ? done.reduce((s, e) => s + e.servico, 0) / done.length / 60 : null; // min
      $('#cMed').textContent = med ? n2(med) : '—';
      $('#cMu').textContent = med ? n2(1 / med) : '—';
      if (eventos.length >= 2) { const tmin = (eventos[eventos.length - 1].chegada - eventos[0].chegada) / 60000; $('#cLam').textContent = tmin > 0 ? n2((eventos.length - 1) / tmin) : '—'; }
      $('#cStat').textContent = pend ? 'cronometrando…' : eventos.length + ' marcação(ões)';
    };
    const draw = () => { $('#cBody').innerHTML = eventos.map((e, i) => `<tr><td>${i + 1}</td><td>${canalLabel[e.canal] || e.canal}</td><td>${e.chegada.toLocaleTimeString('pt-BR')}</td><td>${e.servico != null ? n1(e.servico) : '—'}</td></tr>`).join(''); stats(); };
    $('#cEvt').onclick = () => { if (!pend) pend = { canal: $('#cCanal').value, chegada: new Date() }; else { pend.servico = (Date.now() - pend.chegada.getTime()) / 1000; eventos.push(pend); pend = null; } draw(); };
    $('#cUndo').onclick = () => { if (pend) pend = null; else eventos.pop(); draw(); };
    $('#cSave').onclick = async () => {
      const rows = eventos.filter(e => e.servico != null).map(e => ({ timestamp_chegada: e.chegada.toISOString(), canal: e.canal, tempo_servico_min: e.servico / 60, hora: e.chegada.getHours(), origem: 'campo' }));
      if (!rows.length) return; const { error } = await window.sb.from('filas_atendimentos').insert(rows);
      $('#cStat').textContent = error ? 'erro: ' + error.message : 'enviado ✔'; if (!error) { eventos.length = 0; draw(); histo(); }
    };
    $('#upBtn').onclick = async () => { const f = $('#upFile').files[0]; if (!f) return; try { const n = await ING().importCampoCSV(f, $('#upTipo').value, m => $('#upMsg').textContent = m); $('#upMsg').textContent = n + ' linhas enviadas.'; } catch (e) { $('#upMsg').textContent = 'erro: ' + e.message; } };
    const histo = async () => {
      const { data } = await window.sb.from('filas_atendimentos').select('canal,tempo_servico_min,criado_em').eq('origem', 'campo').order('criado_em', { ascending: false }).limit(200);
      const el = $('#cHist'); if (!el) return;
      if (!data || !data.length) { el.textContent = 'nenhuma coleta de campo ainda.'; return; }
      const byDay = {}; data.forEach(r => { const d = (r.criado_em || '').slice(0, 10); (byDay[d] = byDay[d] || []).push(r.tempo_servico_min); });
      el.innerHTML = Object.entries(byDay).map(([d, v]) => `<div>• ${d}: ${v.length} atendimentos · serviço médio ${n2(v.reduce((a, b) => a + b, 0) / v.length)} min</div>`).join('');
    };
    draw(); histo();
  }

  /* ============================ util charts ============================ */
  function mkChart(id, type, data, opts) {
    const cv = document.getElementById(id); if (!cv) return;
    if (S.charts[id]) { try { S.charts[id].destroy(); } catch (e) {} }
    S.charts[id] = new Chart(cv, { type, data, options: Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { labels: { color: '#9aa7b8', boxWidth: 12 } } }, scales: { x: { ticks: { color: '#9aa7b8' }, grid: { color: '#222a35' } }, y: { ticks: { color: '#9aa7b8' }, grid: { color: '#222a35' } } } }, opts || {}) });
  }

  initGate(); boot();
})();
