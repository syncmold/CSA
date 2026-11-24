-- 範本版本改成生效年月 (工單 #64)：版本＝稽核管理者填的生效年月，格式 v2026.10（v＋西元年＋兩位數月份）。
-- 實作決定見需求決策紀錄 Q102。
--
--   規則      所有寫入（範本管理畫面、草稿途徑、種子）一律由觸發器檢查格式，訊息說清楚要什麼；
--             check constraint 再兜底。格式只寫在 is_month_version 一處。同編號同一個月只能有一版，
--             沿用既有的 unique (code, version)
--   既有資料  紙本沒有版號，原本的 1.0 是轉檔時填的暫用值，所以全部改成範本建立的年月（台北時間）；
--             同編號在同一個月建了不只一版時，依建立先後往後找下一個沒用過的月份。
--             已發出自評表的快照 (ADR-0004 的例外，使用者選定：測試資料不是正式紀錄；題目不動) 也跟著改版本文字：
--             快照版本和範本當時的版本相同的，改成範本的新版本；發出後範本版本又被改過的，改成自評表發出的年月。
--             只是換標籤，所以不更新兩張表的 updated_at。

create or replace function public.is_month_version(p_version text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_version ~ '^v[0-9]{4}\.(0[1-9]|1[0-2])$'
$$;
comment on function public.is_month_version(text) is '版本是否為生效年月 vYYYY.MM（Q102）；觸發器、check constraint 與資料轉換共用。';

create or replace function public.check_template_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_month_version(new.version) then
    raise exception '範本 % 的版本「%」不是生效年月，請寫成 v2026.10 的格式', new.code, new.version
      using errcode = '22007', hint = 'version_format';
  end if;
  return new;
end
$$;
comment on function public.check_template_version() is '內部用：範本版本必須是生效年月 vYYYY.MM。';

-- 既有範本：1.0 之類的暫用值 → 建立年月。
alter table public.questionnaire_template disable trigger questionnaire_template_touch_updated_at;
alter table public.assessment disable trigger assessment_touch_updated_at;

do $$
declare
  t record;
  v_month date;
  v_new text;
begin
  for t in
    select id, code, version, created_at
    from public.questionnaire_template
    where not public.is_month_version(version)
    order by created_at, code, version
  loop
    v_month := date_trunc('month', t.created_at at time zone 'Asia/Taipei')::date;
    loop
      v_new := 'v' || to_char(v_month, 'YYYY.MM');
      exit when not exists (select 1 from public.questionnaire_template where code = t.code and version = v_new);
      v_month := (v_month + interval '1 month')::date;
    end loop;
    update public.questionnaire_template set version = v_new where id = t.id;
    update public.assessment set template_version = v_new where template_id = t.id and template_version = t.version;
  end loop;
end
$$;

-- 發出後範本版本又被改過的自評表，快照版本對不上範本：改成自評表發出的年月。
update public.assessment
set template_version = 'v' || to_char(created_at at time zone 'Asia/Taipei', 'YYYY.MM')
where not public.is_month_version(template_version);

alter table public.questionnaire_template enable trigger questionnaire_template_touch_updated_at;
alter table public.assessment enable trigger assessment_touch_updated_at;

create trigger questionnaire_template_version_month
  before insert or update of version on public.questionnaire_template
  for each row execute function public.check_template_version();

alter table public.questionnaire_template
  add constraint questionnaire_template_version_month check (public.is_month_version(version));
comment on column public.questionnaire_template.version is '版本＝生效年月，格式 v2026.10；同編號同一個月只能有一版。';
