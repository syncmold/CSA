// The only module allowed to import supabase-js (技術選型 §4). It is used purely
// as a PostgREST client (Q76): requests go to <origin>/rest/v1 and carry the CSA
// session token minted by the exchange, so RLS sees app_metadata.emp_id.
import { createClient } from '@supabase/supabase-js'
import { env } from '../env'
import { freshCsaToken } from '../auth/freshToken'

// Empty VITE_SUPABASE_URL means "same origin": the dev server or the reverse
// proxy forwards /rest/v1 to PostgREST.
const apiOrigin = env.supabaseUrl || window.location.origin

export const supabase = createClient(apiOrigin, env.supabaseAnonKey, {
  accessToken: freshCsaToken,
})
