/* ============================================================
   Maestro — MOTOR DE PO (determinístico)
   Portado de maestro.html (matemática base correta) e RELIGADO a
   estimadores reais. A IA NUNCA calcula: tudo acontece aqui.
   Cada família expõe sua fórmula canônica em Motor.FORMULAS (para a
   memória de cálculo, o editor de fórmula e a citação da IA).
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- utilitários estatísticos ---------------- */
  const fact = n => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const variance = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length; };
  const std = a => Math.sqrt(variance(a));
  const cv2 = a => variance(a) / (mean(a) ** 2);   // coeficiente de variação ao quadrado (Cs²/Ca²)

  // CDF normal padrão (Abramowitz & Stegun 26.2.17) — para PERT probabilístico
  function normalCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  const Z = { 0.90: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 };
  const zFor = nivel => Z[nivel] || 1.6449;

  /* ======================= FILAS (M/M/s, Erlang-C) ======================= */

  // Erlang-C: prob. de espera C(s,a); a=λ/μ, ρ=a/s
  function erlangC(s, a) {
    const rho = a / s;
    if (rho >= 1) return { C: 1, rho };
    let sum = 0;
    for (let k = 0; k < s; k++) sum += Math.pow(a, k) / fact(k);
    const top = Math.pow(a, s) / (fact(s) * (1 - rho));
    return { C: top / (sum + top), rho };
  }

  // Métricas M/M/s: Wq=C/(sμ−λ); Lq=λWq; W=Wq+1/μ; L=λW
  function mms(lam, mu, s) {
    const a = lam / mu, { C, rho } = erlangC(s, a);
    if (rho >= 1) return { a, rho, C: 1, Wq: Infinity, Lq: Infinity, W: Infinity, L: Infinity, stable: false, s, lam, mu };
    const Wq = C / (s * mu - lam), Lq = lam * Wq, W = Wq + 1 / mu, L = lam * W;
    return { a, rho, C, Wq, Lq, W, L, stable: true, s, lam, mu };
  }

  // Recomenda o menor s com Wq ≤ alvo (alvo padrão 2 min). Devolve a tabela de candidatos.
  function recommendS(lam, mu, target) {
    target = target == null ? 2.0 : target;
    const a = lam / mu, sMin = Math.floor(a) + 1, rows = [];
    let rec = null;
    for (let s = sMin; s <= sMin + 5; s++) {
      const m = mms(lam, mu, s); rows.push(m);
      if (rec === null && m.stable && m.Wq <= target) rec = s;
    }
    if (rec === null) rec = rows[rows.length - 1].s;
    return { a, rows, rec, target, lam, mu };
  }

  // Correção Allen-Cunneen p/ M/G/s: Wq(M/G/s) ≈ Wq(M/M/s)·(Ca²+Cs²)/2
  function allenCunneen(WqMMs, Ca2, Cs2) { return WqMMs * (Ca2 + Cs2) / 2; }

  // Estimadores a partir do dado REAL (substituem o MU=0.5 sintético do protótipo)
  function estimMu(serviceTimesMin) { return 1 / mean(serviceTimesMin); }                  // μ por canal
  function estimLambda(intervalsMin) { const v = intervalsMin.filter(x => x > 0); return 1 / mean(v); }

  // Simulação trace-driven: alimenta chegadas e serviços REAIS por s servidores FCFS → Wq observado
  // (substitui a triangulação FAKE WqObs = WqTh*1.18 do protótipo)
  function simulateMMs(arrivalsMin, servicesMin, s) {
    const n = arrivalsMin.length;
    const free = new Array(s).fill(arrivalsMin[0] || 0);
    let sumWq = 0, maxWq = 0;
    for (let i = 0; i < n; i++) {
      let idx = 0; for (let k = 1; k < s; k++) if (free[k] < free[idx]) idx = k;
      const start = Math.max(arrivalsMin[i], free[idx]);
      const wq = start - arrivalsMin[i];
      sumWq += wq; if (wq > maxWq) maxWq = wq;
      free[idx] = start + servicesMin[i];
    }
    const Wq = sumWq / n;
    const T = (arrivalsMin[n - 1] - arrivalsMin[0]) || 1;
    const lamObs = (n - 1) / T;
    return { Wq, Lq: lamObs * Wq, n, lamObs, maxWq };
  }

  // gap observado-vs-teórico (com hipótese quando |gap| > 30%)
  function gap(wqObs, wqTh) {
    const g = wqTh > 0 ? (wqObs / wqTh - 1) : 0;
    return { gap: g, exigeHipotese: Math.abs(g) > 0.30 };
  }

  // Drive como fila EM SÉRIE (tandem): cada estágio M/M/1; Little L=λW por estágio
  function tandem(stages) { // stages: [{nome,lam,mu}]
    const est = stages.map(st => {
      const rho = st.lam / st.mu;
      const Wq = rho < 1 ? rho / (st.mu - st.lam) : Infinity;
      const W = Wq + 1 / st.mu, L = st.lam * W;
      return { ...st, rho, Wq, W, L, stable: rho < 1 };
    });
    const Ltot = est.reduce((s, e) => s + (isFinite(e.L) ? e.L : 0), 0);
    const Wtot = est.reduce((s, e) => s + (isFinite(e.W) ? e.W : 0), 0);
    return { estagios: est, Ltotal: Ltot, Wtotal: Wtot };
  }

  /* ======================= PERT / CPM ======================= */

  // te=(o+4m+p)/6 ; σ²=((p−o)/6)²
  function pertTimes(o, m, p) { const te = (o + 4 * m + p) / 6, sig = (p - o) / 6; return { te, variancia: sig * sig, desvio: sig }; }

  // CPM: forward (ES/EF) + backward (LS/LF) + folga + caminho crítico.
  // acts: { id: { dur, varc?, dep:[ids] } }
  function cpm(acts) {
    const ids = Object.keys(acts), ES = {}, EF = {};
    const es = n => {
      if (n in ES) return ES[n];
      ES[n] = acts[n].dep && acts[n].dep.length ? Math.max(...acts[n].dep.map(p => { es(p); return EF[p]; })) : 0;
      EF[n] = ES[n] + acts[n].dur; return ES[n];
    };
    ids.forEach(es);
    const proj = Math.max(...Object.values(EF));
    const LF = {}, LS = {};
    [...ids].sort((a, b) => EF[b] - EF[a]).forEach(n => {           // backward em ordem de EF decrescente
      const succ = ids.filter(m => acts[m].dep && acts[m].dep.includes(n));
      LF[n] = succ.length ? Math.min(...succ.map(s => LS[s])) : proj;
      LS[n] = LF[n] - acts[n].dur;
    });
    const steps = ids.map(n => ({
      id: n, dur: acts[n].dur, ES: ES[n], EF: EF[n], LS: LS[n], LF: LF[n],
      slack: +(LS[n] - ES[n]).toFixed(4), critical: Math.abs(LS[n] - ES[n]) < 1e-6
    })).sort((a, b) => a.ES - b.ES || (a.critical === b.critical ? 0 : a.critical ? -1 : 1));
    const critPath = steps.filter(s => s.critical).map(s => s.id);
    return { steps, proj: +proj.toFixed(4), critPath };
  }

  // PERT probabilístico (TLC): Te(CP)=Σte ; σ(CP)=√Σσ² ; P(T≤D)=Φ((D−Te)/σ)
  function pertProb(critPath, acts, D) {
    const Te = critPath.reduce((s, n) => s + acts[n].dur, 0);
    const varCP = critPath.reduce((s, n) => s + (acts[n].varc || 0), 0);
    const sigma = Math.sqrt(varCP);
    return { Te: +Te.toFixed(2), sigma: +sigma.toFixed(2), varCP: +varCP.toFixed(2), P: D != null && sigma > 0 ? normalCdf((D - Te) / sigma) : null, prazo95: +(Te + 1.6449 * sigma).toFixed(2) };
  }

  // CRASHING — heurística de custo marginal contínuo ao longo da CP (LP nas precedências, sem solver externo).
  // Crasha o menor-custo da CP por passos pequenos; aceita só se a duração do projeto cair (trata caminhos paralelos).
  // actsInput: { id:{dur, dep, maxCrash, costDay} }. budget em R$.
  function crashAuto(actsInput, budget) {
    const acts = {};
    for (const k in actsInput) acts[k] = { dur: actsInput[k].dur, dep: actsInput[k].dep || [], crashed: 0, maxCrash: actsInput[k].maxCrash || 0, costDay: (actsInput[k].costDay == null ? Infinity : actsInput[k].costDay) };
    const dm = () => { const d = {}; for (const k in acts) d[k] = { dur: acts[k].dur - acts[k].crashed, dep: acts[k].dep }; return d; };
    const normal = cpm(dm()).proj;
    let proj = normal, spent = 0; const step = 0.05; let guard = 0;
    while (spent < budget - 1e-9 && guard++ < 200000) {
      const cp = cpm(dm()).critPath;
      const cands = cp.filter(id => acts[id].crashed < acts[id].maxCrash - 1e-9 && acts[id].costDay < Infinity)
        .sort((a, b) => acts[a].costDay - acts[b].costDay);
      let progressed = false;
      for (const pick of cands) {
        const room = Math.min(step, acts[pick].maxCrash - acts[pick].crashed, (budget - spent) / acts[pick].costDay);
        if (room <= 1e-9) continue;
        acts[pick].crashed += room;
        const newProj = cpm(dm()).proj;
        if (newProj < proj - 1e-9) { spent += room * acts[pick].costDay; proj = newProj; progressed = true; break; }
        acts[pick].crashed -= room;   // não ajudou (caminho paralelo passou a ditar) → reverte, tenta o próximo
      }
      if (!progressed) break;
    }
    const plan = {};
    for (const k in acts) if (acts[k].crashed > 1e-6) plan[k] = +acts[k].crashed.toFixed(2);
    return { normal: +normal.toFixed(2), finalDur: +proj.toFixed(2), spent: +spent.toFixed(2), plan };
  }

  // Crash manual (interativo): aplica `dias` de aceleração na atividade e devolve nova duração/custo do passo.
  function crashStep(actsInput, crashedMap, actId, dias) {
    const acts = {}; for (const k in actsInput) acts[k] = { dur: actsInput[k].dur - ((crashedMap && crashedMap[k]) || 0), dep: actsInput[k].dep || [] };
    const a = actsInput[actId];
    const jaCrashed = (crashedMap && crashedMap[actId]) || 0;
    const room = Math.max(0, Math.min(dias, (a.maxCrash || 0) - jaCrashed));
    acts[actId].dur -= room;
    return { aplicado: room, custo: room * (a.costDay || 0), proj: cpm(acts).proj };
  }

  /* ======================= EOQ / Estoque ======================= */
  function eoq(D, S, H) { return Math.sqrt(2 * D * S / H); }                       // Q*=√(2DS/H)
  function tcEOQ(Q, D, S, H, price) { return (price ? D * price : 0) + (D / Q) * S + (Q / 2) * H; }
  // ROP com estoque de segurança: ROP = d·L + z·σ_d·√L
  function rop(d, L, sigmaD, nivel) {
    sigmaD = sigmaD || 0; const z = zFor(nivel);
    const ss = z * sigmaD * Math.sqrt(L);
    return { rop: d * L + ss, ss, z, nivel: nivel || 0.95 };
  }
  // Revisão periódica (order-up-to): S = d·(L+T) + z·σ_d·√(L+T)
  function periodicS(d, L, T, sigmaD, nivel) { const z = zFor(nivel); return d * (L + T) + z * (sigmaD || 0) * Math.sqrt(L + T); }
  // Classificação "contar do dado" a partir de abordagem_recomendada
  function classifyEOQ(abordagem) {
    const a = (abordagem || '').toLowerCase();
    if (a.includes('clássico') || a.includes('classico')) return 'classico';
    if (a.includes('adaptar') || a.includes('revisão periódica') || a.includes('revisao periodica')) return 'adaptar';
    return 'periodo_fixo';
  }
  // Curva TC(Q) e sensibilidade (Q* ∝ √D, √S, 1/√H)
  function eoqCurve(D, S, H, price, n) {
    n = n || 40; const Qs = eoq(D, S, H); const lo = Math.max(1, Qs * 0.2), hi = Qs * 2.2, step = (hi - lo) / n;
    const pts = []; for (let q = lo; q <= hi; q += step) pts.push({ Q: +q.toFixed(1), TC: +tcEOQ(q, D, S, H, price).toFixed(2) });
    return { Qstar: +Qs.toFixed(1), TCstar: +tcEOQ(Qs, D, S, H, price).toFixed(2), pts };
  }
  function eoqSensitivity(D, S, H, factors) {
    factors = factors || [0.5, 0.75, 1, 1.5, 2];
    return {
      D: factors.map(f => ({ f, Q: +eoq(D * f, S, H).toFixed(1) })),
      S: factors.map(f => ({ f, Q: +eoq(D, S * f, H).toFixed(1) })),
      H: factors.map(f => ({ f, Q: +eoq(D, S, H * f).toFixed(1) })),
    };
  }

  /* ======================= JOGOS / Nash ======================= */
  // Nash puro em matriz MxN; cada célula = [payoffLinha, payoffColuna]
  function nashPure(m) {
    const R = m.length, C = m[0].length, ne = [];
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
      const pr = m[i][j][0], pc = m[i][j][1];
      const colMax = Math.max(...m.map(row => row[j][0]));   // melhor resposta da LINHA dada a coluna j
      const rowMax = Math.max(...m[i].map(c => c[1]));        // melhor resposta da COLUNA dada a linha i
      if (pr >= colMax - 1e-9 && pc >= rowMax - 1e-9) ne.push({ i, j, payoff: [pr, pc] });
    }
    return ne;
  }
  // Dominância estrita (linha/coluna sempre melhor)
  function dominance(m) {
    const R = m.length, C = m[0].length, res = { linha: null, coluna: null };
    for (let i = 0; i < R; i++) {
      let dom = true;
      for (let k = 0; k < R; k++) if (k !== i) for (let j = 0; j < C; j++) if (!(m[i][j][0] > m[k][j][0])) { dom = false; break; }
      if (dom) { res.linha = i; break; }
    }
    for (let j = 0; j < C; j++) {
      let dom = true;
      for (let k = 0; k < C; k++) if (k !== j) for (let i = 0; i < R; i++) if (!(m[i][j][1] > m[i][k][1])) { dom = false; break; }
      if (dom) { res.coluna = j; break; }
    }
    return res;
  }
  // Equilíbrio misto 2×2 (por indiferença); null se não-aplicável
  function nashMixed2x2(m) {
    if (m.length !== 2 || m[0].length !== 2) return null;
    // linha mistura p em I0; coluna fica indiferente: pc(0,0)*? — resolve p e q
    const a = m[0][0], b = m[0][1], c = m[1][0], d = m[1][1];
    // coluna indiferente: p*a[1]+(1-p)*c[1] = p*b[1]+(1-p)*d[1]  (payoffs da coluna)
    const denomP = (a[1] - b[1] - c[1] + d[1]);
    const denomQ = (a[0] - b[0] - c[0] + d[0]);
    if (Math.abs(denomP) < 1e-9 || Math.abs(denomQ) < 1e-9) return null;
    const p = (d[1] - c[1]) / denomP;       // prob. da linha jogar estratégia 0
    const q = (d[0] - b[0]) / denomQ;       // prob. da coluna jogar estratégia 0
    if (p < 0 || p > 1 || q < 0 || q > 1) return null;
    return { p, q };
  }
  // converte os payoffs longos (dataset_jogos_payoffs) numa matriz MxN
  function payoffMatrix(rows) {
    const estL = [...new Set(rows.map(r => r.estrategia_linha))];
    const estC = [...new Set(rows.map(r => r.estrategia_coluna))];
    const m = estL.map(() => estC.map(() => [0, 0]));
    rows.forEach(r => {
      const i = estL.indexOf(r.estrategia_linha), j = estC.indexOf(r.estrategia_coluna);
      m[i][j] = [+r.payoff_linha, +r.payoff_coluna];
    });
    return { m, estL, estC };
  }

  /* ======================= fórmulas canônicas (citação/memória) ======================= */
  const FORMULAS = {
    erlangC: { nome: 'Erlang-C / M/M/s', tex: 'C(s,a)=\\frac{a^s/(s!(1-\\rho))}{\\sum_{k=0}^{s-1}a^k/k!+a^s/(s!(1-\\rho))}', txt: 'C(s,a) = [aˢ/(s!(1−ρ))] / [Σ aᵏ/k! + aˢ/(s!(1−ρ))]', fonte: 'Erlang-C (M/M/s)' },
    wq: { nome: 'Espera em fila M/M/s', txt: 'Wq = C/(sμ − λ); Lq = λ·Wq; W = Wq + 1/μ; L = λ·W', fonte: 'Teoria de Filas / Lei de Little' },
    allenCunneen: { nome: 'Correção M/G/s', txt: 'Wq(M/G/s) ≈ Wq(M/M/s)·(Ca²+Cs²)/2', fonte: 'Allen-Cunneen' },
    pert: { nome: 'PERT', txt: 'te=(o+4m+p)/6; σ²=((p−o)/6)²; P(T≤D)=Φ((D−Te)/σ)', fonte: 'PERT / CPM (TLC)' },
    crashing: { nome: 'Crashing', txt: 'min duração s.a. Σ(custo_dia·dias) ≤ budget', fonte: 'CPM — compressão de prazo' },
    eoq: { nome: 'EOQ', txt: 'Q* = √(2DS/H); TC = D·preço + (D/Q)·S + (Q/2)·H', fonte: 'Harris-Wilson (EOQ)' },
    rop: { nome: 'Ponto de reposição', txt: 'ROP = d·L + z·σ_d·√L', fonte: 'ROP com estoque de segurança (nível de serviço z)' },
    periodic: { nome: 'Revisão periódica', txt: 'S = d·(L+T) + z·σ_d·√(L+T)', fonte: 'Order-up-to (Nahmias)' },
    nash: { nome: 'Equilíbrio de Nash', txt: 'Perfil em que ninguém melhora desviando (best response mútua)', fonte: 'Nash (1950)' },
  };

  const Motor = {
    // utils
    fact, mean, variance, std, cv2, normalCdf, zFor,
    // filas
    erlangC, mms, recommendS, allenCunneen, estimMu, estimLambda, simulateMMs, gap, tandem,
    // pert
    pertTimes, cpm, pertProb, crashAuto, crashStep,
    // eoq
    eoq, tcEOQ, rop, periodicS, classifyEOQ, eoqCurve, eoqSensitivity,
    // jogos
    nashPure, dominance, nashMixed2x2, payoffMatrix,
    FORMULAS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Motor;
  global.Motor = Motor;
})(typeof window !== 'undefined' ? window : globalThis);
