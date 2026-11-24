-- 員工參照 (employee reference): the only thing CSA stores about a person.
-- Q61: OMS is the single source of accounts; name and 廠區 are copied for display
-- only and refreshed on every 換證. 稽核角色 lives here because OMS has no CSA
-- roles yet (OPEN-4 decides the final home).
--
-- Identity in every request comes from the CSA session JWT minted by the
-- exchange: auth.jwt() -> 'app_metadata' ->> 'emp_id'.

create type public.audit_role as enum ('signer', 'audit_admin', 'viewer');

create table public.employee_ref (
  emp_id        text primary key,
  name          text,
  factory_code  text,
  audit_role    public.audit_role not null default 'signer',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.employee_ref is
  '員工參照：CSA 看過的 OMS 員工（工號、稽核角色）。姓名與廠區只是顯示用的快照。';

-- Who am I? Read emp_id from the CSA session JWT. Returns null for anon.
create or replace function public.current_emp_id()
returns text
language sql
stable
as $$
  select nullif(coalesce(auth.jwt() -> 'app_metadata' ->> 'emp_id', ''), '')
$$;

create or replace function public.current_audit_role()
returns public.audit_role
language sql
stable
security definer
set search_path = public
as $$
  select audit_role from public.employee_ref where emp_id = public.current_emp_id()
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create trigger employee_ref_touch_updated_at
  before update on public.employee_ref
  for each row execute function public.touch_updated_at();

alter table public.employee_ref enable row level security;

-- An employee sees their own row; 稽核管理者 sees everyone.
create policy employee_ref_select_self_or_admin
  on public.employee_ref
  for select
  to authenticated
  using (
    emp_id = public.current_emp_id()
    or public.current_audit_role() = 'audit_admin'
  );

-- Only the exchange (service role) writes rows; no policy for authenticated writes.
grant select on public.employee_ref to authenticated;
revoke insert, update, delete on public.employee_ref from authenticated, anon;
revoke all on public.employee_ref from anon;
