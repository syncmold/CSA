-- 刪除從未使用過的問卷範本 (工單 #31)：開錯的範本可以整份刪掉，用過的照樣只能停用。
-- 實作決定見需求決策紀錄 Q87；#10 (Q83) 的「範本不開放刪除」在這裡放寬成「只有從未使用過的能刪」。
--
--   從未使用過  沒有任何自評表、也沒有任何簽核流程（不分草稿、啟用、停用）參照它。自評表要能回溯當年的範本
--              (ADR-0004)，簽核流程綁在「範本 × 廠區」上，所以兩者有一筆就不能刪，畫面提示改用停用。
--              規則只寫在 in_use 一處：刪除函式用它把關，範本頁讀同一個計算欄位，事先把刪除鈕停用。
--   最後防線    參照範本的外鍵都沒有 on delete cascade：日後新增的參照（如流程編輯的資料）沒列進 in_use，
--              外鍵照樣擋下，一樣回成「已被使用」。
--   連同內容    章節、控制要點、適用廠區由既有的 on delete cascade 一起刪掉，同一個交易。
--   確認編號    呼叫者要給這份範本的編號，對不上就拒絕，避免畫面點錯一份或 API 誤呼叫。
--
-- 範本表仍沒有直接刪除的授權；這支 security definer 函式自己檢查稽核管理者（稽核角色仍是 OPEN-4 的暫行做法）。
-- 錯誤：不是稽核管理者 42501；範本不存在 P0002；編號不符 22023；已被使用 23503。

-- 已被使用？ 也是 PostgREST 的計算欄位：select=…,in_use。security definer 是為了不依賴呼叫者
-- 讀不讀得到自評表與簽核流程；範本本身只有稽核管理者讀得到 (RLS)，所以只有他們拿得到這個旗標。
create or replace function public.in_use(t public.questionnaire_template)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.assessment where template_id = t.id)
      or exists (select 1 from public.approval_route where template_id = t.id)
$$;
comment on function public.in_use(public.questionnaire_template) is
  '問卷範本是否已被使用（有自評表或任何簽核流程）；已使用的不能刪除，只能停用。';

create or replace function public.delete_template(p_template_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template public.questionnaire_template;
begin
  if not public.is_audit_admin() then
    raise exception 'only a 稽核管理者 can delete templates' using errcode = '42501';
  end if;

  -- 鎖住範本列：同時進行的年度發起或新增流程要等這裡結束，不會在檢查之後才參照它。
  select * into v_template from public.questionnaire_template where id = p_template_id for update;
  if not found then
    raise exception 'template % not found', p_template_id using errcode = 'P0002';
  end if;
  if btrim(coalesce(p_code, '')) <> v_template.code then
    raise exception '確認的編號與問卷範本的編號（%）不符', v_template.code using errcode = '22023';
  end if;

  if public.in_use(v_template) then
    raise exception '問卷範本 % 已被自評表或簽核流程使用，不能刪除，請改用停用', v_template.code using errcode = '23503';
  end if;

  begin
    delete from public.questionnaire_template where id = p_template_id;
  exception when foreign_key_violation then
    raise exception '問卷範本 % 已被其他資料使用，不能刪除，請改用停用', v_template.code using errcode = '23503';
  end;
end
$$;
comment on function public.delete_template(uuid, text) is
  '稽核管理者刪除從未使用過（沒有自評表、沒有簽核流程）的問卷範本，連同章節、控制要點與適用廠區；p_code 為確認用的範本編號。';

revoke execute on function public.in_use(public.questionnaire_template) from public, anon;
revoke execute on function public.delete_template(uuid, text) from public, anon;
grant execute on function public.in_use(public.questionnaire_template) to authenticated;
grant execute on function public.delete_template(uuid, text) to authenticated;
