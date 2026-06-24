/* ============================================================
   Maestro — configuração do cliente Supabase
   ------------------------------------------------------------
   ATENÇÃO (regra dura #2 do SPEC): este arquivo só pode conter
   credenciais PÚBLICAS (URL + publishable/anon key), que são
   protegidas por RLS no Postgres. A chave da Anthropic e a
   service-role NUNCA entram aqui — vivem só na Edge Function.
   ============================================================ */
const MAESTRO_CONFIG = {
  SUPABASE_URL: 'https://mzgzltqrmdswblkxxkls.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_E3ySuMd2sH0SkZbFLvNN4Q_larnIfm0',
  AI_FUNCTION: 'ai-proxy',   // nome da Edge Function (proxy Anthropic)
  AI_MODEL: 'claude-sonnet-4-6',
  AI_MAX_TOKENS: 1000,
};

// supabase-js é carregado via CDN no index.html (window.supabase)
const sb = window.supabase.createClient(
  MAESTRO_CONFIG.SUPABASE_URL,
  MAESTRO_CONFIG.SUPABASE_PUBLISHABLE_KEY
);
window.sb = sb;
window.MAESTRO_CONFIG = MAESTRO_CONFIG;
