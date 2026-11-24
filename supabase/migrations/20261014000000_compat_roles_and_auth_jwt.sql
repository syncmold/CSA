-- Compatibility prelude (Q76): CSA runs on plain Postgres + PostgREST in
-- development and on the company Windows VM, and must still apply cleanly on a
-- Supabase stack (CI). Everything here is skipped when Supabase already
-- provides it.
--
-- Roles PostgREST switches to, chosen by the JWT `role` claim:
--   anon           no session (we revoke almost everything from it)
--   authenticated  an CSA session minted by the exchange (app_metadata.emp_id)
--   service_role   the exchange itself writing employee_ref; bypasses RLS
-- The login role PostgREST connects as (`authenticator`) is created outside
-- migrations by `npm run db:init`, because it needs a password.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    begin
      grant anon, authenticated, service_role to authenticator;
    exception when insufficient_privilege then
      raise notice 'authenticator membership left as is (managed by the platform)';
    end;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Tables created by later migrations: service_role gets everything (it bypasses
-- RLS anyway); anon/authenticated get nothing until a migration grants it.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- auth.jwt(): Supabase's helper that returns the request's JWT claims, defined
-- exactly as Supabase defines it (PostgREST sets `request.jwt.claims`; the
-- singular name is kept only to stay byte-identical with Supabase). Created
-- only when Supabase has not already defined it.
create schema if not exists auth;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'jwt'
  ) then
    create function auth.jwt() returns jsonb
    language sql stable
    as $f$
      select coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb
    $f$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.jwt() to anon, authenticated, service_role;
  end if;
end
$$;
