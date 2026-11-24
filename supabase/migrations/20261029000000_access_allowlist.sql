-- 放行名單 (Q97, #56): who may enter CSA once 放行全開 (Q62) is off. OMS only verifies the password and says
-- who the person is; whether they get a CSA session is CSA's own decision, kept here instead of an OMS system
-- code or the CSA_ALLOWED_EMP_IDS setting. Only the exchange asks (as service_role, through is_admitted); 稽核管理者
-- can read the list. There is no API write grant yet: the list is maintained with `npm run deploy -- <env> allow`
-- until a 維護畫面 exists.

create table public.access_allowlist (
  emp_id      text primary key check (emp_id = upper(btrim(emp_id)) and emp_id <> ''),
  note        text,
  added_at    timestamptz not null default now()
);
comment on table public.access_allowlist is
  '放行名單 (Q97)：全開關閉時，只有名單內的工號換得到 CSA session。工號一律存大寫、去頭尾空白。';

alter table public.access_allowlist enable row level security;

-- Supabase grants every new public table to anon and authenticated by default; take back all but reading.
revoke all on public.access_allowlist from anon;
revoke insert, update, delete, truncate on public.access_allowlist from authenticated;
grant select on public.access_allowlist to authenticated;
create policy access_allowlist_audit_admin_read on public.access_allowlist
  for select to authenticated using (public.is_audit_admin());

-- The exchange's question. 工號 from OMS may differ in case or spacing from the list.
create or replace function public.is_admitted(p_emp_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.access_allowlist where emp_id = upper(btrim(p_emp_id)))
$$;
comment on function public.is_admitted(text) is '放行名單裡有這個工號嗎（Q97）？只給換證服務（service_role）呼叫。';

revoke execute on function public.is_admitted(text) from public, anon, authenticated;
grant execute on function public.is_admitted(text) to service_role;
