-- 權限規則裡「是不是稽核管理者」每個查詢只判斷一次（2026-10-30 部署後範本管理逾時）。
--
-- 原因：policy 寫成 using (is_audit_admin())，is_audit_admin() 是 security definer，Postgres 不會把它展開，
-- 所以每讀一列就呼叫一次（每次都查 employee_ref）。範本管理清單的「題數」「內容指紋」（#84）每份範本都要讀
-- 全部章節、控制要點、自評單位，293 份範本約 2.5 萬列：在 demo 測試環境以稽核管理者讀要 8 秒以上，超過
-- Supabase 給 authenticated 的 statement_timeout（8 秒），整個清單查詢被中斷；不套 RLS 讀只要 0.15 秒。
--
-- 改法：把這類不看列內容的判斷包成子查詢 (select is_audit_admin())，Postgres 把它當 InitPlan，每個查詢只算
-- 一次（Supabase 的 RLS 效能建議）。結果和原本相同：同一個查詢裡登入身分不會變。can_view_assessment(id)、
-- can_edit_unit(…) 這類以列內容為參數的判斷本來就要每列算，不動。
--
-- 用迴圈改寫現有的 policy，不逐條重寫：名稱、指令、對象角色都不變（alter policy 只換條件）。之後新增的 policy
-- 要自己寫成 (select public.is_audit_admin())；DB 測試 rls_initplan.rls.test.ts 會擋下沒包起來的。

do $$
declare
  p record;
  -- pg_policies 印出來的條件依 search_path 決定帶不帶 public.；已經包成子查詢的印成「SELECT is_audit_admin() AS …」，
  -- 前面有 SELECT 就不再包。名稱前面不能是字元或「.」：不從 public.xxx 的中間、也不把別的 schema 的同名函式當成它。
  -- tests/db/rls_initplan.rls.test.ts 用同一個 pattern，改的時候兩邊一起改。
  pattern constant text := '(?<!SELECT )(?<![\w.])(public\.)?(is_audit_admin|current_audit_role|current_emp_id)\(\)';
  wrapped constant text := '(select public.\2())';
  new_qual text;
  new_check text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (qual ~ pattern or with_check ~ pattern)
  loop
    new_qual := regexp_replace(p.qual, pattern, wrapped, 'g');
    new_check := regexp_replace(p.with_check, pattern, wrapped, 'g');
    -- format() 把 null 印成空字串，所以沒有的條件要自己略過。
    execute format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename)
      || case when new_qual is null then '' else format(' using (%s)', new_qual) end
      || case when new_check is null then '' else format(' with check (%s)', new_check) end;
  end loop;
end
$$;
