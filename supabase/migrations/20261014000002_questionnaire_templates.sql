-- 問卷範本 (工單 #3): 範本 → 章節 → 控制要點，加上集團共用的自評單位清單。
-- 用語依 GLOSSARY.md。#3 只有唯讀：稽核管理者可讀全部，其他人什麼都讀不到；
-- 寫入（範本管理編輯）在 #10 加，所以這裡沒有任何 insert/update/delete 的授權或 policy。
-- 種子資料由轉檔腳本另產生（20261014000003_seed_template_02.sql）。

create type public.template_layout as enum ('element', 'control_activity');
comment on type public.template_layout is
  '版型 (ADR-0005)：element＝要素類（A–D，是／否／不適用）；control_activity＝控制活動類（01–15）。';

create type public.template_status as enum ('draft', 'active', 'inactive');
comment on type public.template_status is '草稿／啟用／停用。';

-- 稽核管理者？ 供各表的 RLS 共用。
create or replace function public.is_audit_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_audit_role() = 'audit_admin', false)
$$;

-- 自評單位：集團共用清單，與 OMS 部門無關。
create table public.assessing_unit (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);
comment on table public.assessing_unit is '自評單位（資材單位、品保單位、財務單位…）：集團共用清單。';

create table public.questionnaire_template (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  name        text not null,
  layout      public.template_layout not null,
  version     text not null,
  status      public.template_status not null default 'draft',
  -- 適用廠區：all_plants＝所有廠區；否則看 template_plant。廠區主檔來源未定案 (Q68)，
  -- 所以這裡只存 OMS 廠區代碼，不建廠區表。
  all_plants  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (code, version)
);
comment on table public.questionnaire_template is '問卷範本：編號（02、01.1）、名稱、版型、版本、狀態、適用廠區。';

create table public.template_plant (
  template_id   uuid not null references public.questionnaire_template (id) on delete cascade,
  factory_code  text not null,
  primary key (template_id, factory_code)
);
comment on table public.template_plant is '限定廠區的範本（all_plants = false）適用哪些 OMS 廠區代碼。';

create table public.template_section (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references public.questionnaire_template (id) on delete cascade,
  position     integer not null check (position > 0),
  name         text not null,
  unique (template_id, position)
);
comment on table public.template_section is '章節：範本中的一組控制要點，順序與紙本相同。';

create table public.control_point (
  id                 uuid primary key default gen_random_uuid(),
  section_id         uuid not null references public.template_section (id) on delete cascade,
  position           integer not null check (position > 0),
  text               text not null,
  -- 控制活動類必填；要素類沒有自評單位。何時強制由 #10（範本編輯）決定。
  assessing_unit_id  uuid references public.assessing_unit (id),
  unique (section_id, position)
);
create index control_point_assessing_unit_idx on public.control_point (assessing_unit_id);
comment on table public.control_point is '控制要點：問卷中要求作答的一題（沿用紙本表頭用語）；位置在章節內從 1 起算。';

create trigger questionnaire_template_touch_updated_at
  before update on public.questionnaire_template
  for each row execute function public.touch_updated_at();

-- RLS: 稽核管理者可讀全部，其他人讀不到範本管理；#3 沒有任何寫入。
do $$
declare
  t text;
begin
  foreach t in array array['assessing_unit', 'questionnaire_template', 'template_plant', 'template_section', 'control_point']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_audit_admin())',
      t || '_select_audit_admin', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;
