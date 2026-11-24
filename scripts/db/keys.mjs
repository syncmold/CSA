// npm run db:keys — print the anon key that matches CSA_JWT_SECRET.
// The "anon key" is just a long-lived JWT with role=anon; the browser sends it
// when nobody is signed in. Regenerate it whenever the secret changes.
import { SignJWT } from 'jose'
import { required } from './env.mjs'

const secret = required('CSA_JWT_SECRET')
const tenYears = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600

const anon = await new SignJWT({ role: 'anon' })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuer('csa')
  .setIssuedAt()
  .setExpirationTime(tenYears)
  .sign(new TextEncoder().encode(secret))

console.log(`VITE_SUPABASE_ANON_KEY=${anon}`)
