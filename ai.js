/* ============================================================
   Maestro — IA EM RUNTIME (Entrega 2)
   ------------------------------------------------------------
   Toda chamada passa pela Edge Function `ai-proxy` (a chave vive só
   lá). A IA NÃO calcula: recebe os números prontos do Motor de PO e
   apenas interpreta, CITA a fórmula/teorema e PROPÕE ações (que o
   gerente confirma). Fallback determinístico (keyword-routing) quando
   a API falha. O system prompt é documentado na tela "Sobre a IA".
   ============================================================ */
(function (global) {
  'use strict';
  const sb = () => global.sb;
  const cfg = () => global.MAESTRO_CONFIG;

  const SYSTEM_PROMPT =
    'Você é o copiloto de Pesquisa Operacional do sistema Maestro, para uma loja McDonald\'s. ' +
    'Responda em português, curto e objetivo (máx ~4 frases). SEMPRE cite a fórmula ou teorema ' +
    'pertinente (Erlang-C / M/M/s, EOQ Q*=√(2DS/H), caminho crítico do CPM, equilíbrio de Nash). ' +
    'Use APENAS os números fornecidos no contexto — você NÃO calcula nada; o cálculo é 100% ' +
    'determinístico no Motor de PO. Você pode PROPOR uma ação para o gerente confirmar, mas nunca ' +
    'a executa sozinho. Quando o contexto indicar uma fórmula CUSTOM ativa, cite a fórmula CANÔNICA ' +
    'e sinalize que há um desvio em uso. Não invente dados.';

  // fontes teóricas por função (munição da tela "Sobre a IA")
  const FONTES = {
    filas: { titulo: 'Filas — dimensionamento de atendentes', formula: 'Erlang-C: C(s,a); Wq=C/(sμ−λ)', fonte: 'M/M/s (Erlang-C); correção Allen-Cunneen p/ M/G/s; Lei de Little (L=λW)' },
    pert: { titulo: 'PERT — onde acelerar', formula: 'te=(o+4m+p)/6; caminho crítico (folga 0); P(T≤D)=Φ((D−Te)/σ)', fonte: 'PERT/CPM; crashing por custo marginal' },
    eoq: { titulo: 'EOQ — quanto e quando pedir', formula: 'Q*=√(2DS/H); ROP=d·L+z·σ_d·√L', fonte: 'Harris-Wilson (EOQ); estoque de segurança por nível de serviço; revisão periódica (Nahmias)' },
    jogos: { titulo: 'Jogos — preço/promoção', formula: 'Equilíbrio de Nash (best response mútua)', fonte: 'Nash (1950); dominância estrita; estratégia mista por indiferença' },
  };

  // monta o texto de contexto (números determinísticos) que a IA vai INTERPRETAR
  function ctxToText(tema, ctx) {
    try { return tema.toUpperCase() + ' — números do Motor de PO:\n' + JSON.stringify(ctx, null, 0); }
    catch (e) { return String(ctx); }
  }

  async function ask(tema, pergunta, ctx, customFormulaAtiva) {
    const contexto = ctxToText(tema, ctx) + (customFormulaAtiva ? '\n[ATENÇÃO] Fórmula CUSTOM ativa neste tema — cite a canônica e sinalize o desvio.' : '');
    const messages = [{ role: 'user', content: `Contexto:\n${contexto}\n\nPergunta do gerente: ${pergunta}` }];
    try {
      const { data, error } = await sb().functions.invoke(cfg().AI_FUNCTION, {
        body: { system: SYSTEM_PROMPT, messages, max_tokens: cfg().AI_MAX_TOKENS },
      });
      if (error) throw error;
      if (data && data.error) throw new Error(data.error);
      const text = (data && data.text) || '';
      if (!text) throw new Error('resposta vazia');
      return { text, fonte: FONTES[tema], fallback: false };
    } catch (e) {
      return { ...fallback(tema, pergunta, ctx), erro: String(e && e.message || e) };
    }
  }

  // FALLBACK determinístico (keyword-routing), citando a fórmula — portado do maestro.html
  function fallback(tema, pergunta, ctx) {
    const q = (tema + ' ' + (pergunta || '')).toLowerCase();
    let t = tema;
    if (!FONTES[t]) {
      if (/atend|escala|fila|espera|m\/m|wq|caixa|balc|totem|drive/.test(q)) t = 'filas';
      else if (/estoq|pedir|repor|lote|eoq|q\*|insumo|sku|rop/.test(q)) t = 'eoq';
      else if (/preparo|pert|cr[ií]t|cozinha|montagem|gargalo|crash|lan[çc]amento/.test(q)) t = 'pert';
      else if (/promo|pre[çc]o|nash|concorr|jogo|estrat[ée]g/.test(q)) t = 'jogos';
      else t = 'filas';
    }
    const f = FONTES[t];
    let msg = '';
    if (t === 'filas') msg = `Pela Erlang-C (M/M/s), com os números do Motor, o nº de atendentes recomendado mantém Wq ≤ alvo. ${ctx && ctx.rec ? 'Recomendado: ' + ctx.rec + ' atendente(s).' : ''} ${ctx && ctx.gap != null ? 'Gap observado×teórico: ' + (ctx.gap * 100).toFixed(0) + '%.' : ''}`;
    else if (t === 'eoq') msg = `Pela EOQ Q*=√(2DS/H) e ROP=d·L+z·σ_d·√L. ${ctx && ctx.Qstar ? 'Q*≈' + ctx.Qstar + ' un; ROP≈' + ctx.rop + '.' : ''}`;
    else if (t === 'pert') msg = `O caminho crítico (folga 0) define a duração; acelere primeiro a atividade crítica de menor custo/dia (crashing). ${ctx && ctx.proj ? 'Duração: ' + ctx.proj + ' dias.' : ''}`;
    else msg = `Pelo equilíbrio de Nash (best response mútua). ${ctx && ctx.nash ? 'Equilíbrio: ' + ctx.nash + '.' : ''}`;
    return { text: msg + ' (resposta determinística local — API indisponível)', fonte: f, fallback: true };
  }

  global.AI = { ask, fallback, SYSTEM_PROMPT, FONTES };
})(typeof window !== 'undefined' ? window : globalThis);
