/** Typed view of the browser-visible environment (VITE_ prefix). */
export const env = {
  omsUrl: import.meta.env.VITE_OMS_URL as string,
  omsAnonKey: import.meta.env.VITE_OMS_ANON_KEY as string,
  synchubUrl: (import.meta.env.VITE_SYNCHUB_URL as string | undefined) ?? '#',
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  exchangeUrl: (import.meta.env.VITE_EXCHANGE_URL as string | undefined) ?? '/csa/exchange',
  devLoginUrl: (import.meta.env.VITE_DEV_LOGIN_URL as string | undefined) ?? '/csa/dev-login',
  /** Q97: which demo environment this build is (e.g. 測試環境), shown in the header; empty on a developer PC. */
  envLabel: (import.meta.env.VITE_CSA_ENV_LABEL as string | undefined) ?? '',
  /** Q123 (4): package.json's version and the commit built from, set by vite.config.ts; empty in unit tests. */
  version: (import.meta.env.VITE_CSA_VERSION as string | undefined) ?? '',
  commit: (import.meta.env.VITE_CSA_COMMIT as string | undefined) ?? '',
}
