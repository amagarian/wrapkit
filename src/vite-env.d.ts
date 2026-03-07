/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_TEMPLATE_CACHE_TTL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
