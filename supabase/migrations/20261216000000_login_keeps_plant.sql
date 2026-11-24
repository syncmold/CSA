-- 登入換證的廠區（#218 第 4 步）。
--
-- 換證改向 OMS 的 CSA 專用查詢通道取姓名與主檔廠區（employees_picker 已刪，Q133 (9)(10)）。通道一天只給 5,000 個工號，
-- 所以只有真的登入才問，每 45 分鐘的續期不問（Q133 (6)「不必每次問 OMS」）；通道也可能答不出來（這台沒設金鑰、
-- 當天額度用完、OMS 連不上），登入照樣成功。這兩種時候換證傳來的廠區是空的：原本的 record_login 會直接寫進員工參照，
-- 把上次記下的廠區洗掉；改成沒有新值就留著舊的（姓名同理），並回傳存下來的姓名與廠區，換證拿它們簽進 session，
-- 所以續期後首頁照樣看得到廠區。最後登入時間照常更新。
--
-- 回傳型別從 void 改成一列，create or replace 改不了回傳型別，所以先 drop 再建。

drop function public.record_login(text, text, text);

create function public.record_login(p_emp_id text, p_name text, p_factory_code text)
returns table (name text, factory_code text)
language sql
security definer
set search_path = public
as $$
  insert into public.employee_ref as e (emp_id, name, factory_code, last_login_at)
  values (p_emp_id, p_name, p_factory_code, now())
  on conflict (emp_id) do update
    set name = coalesce(excluded.name, e.name),
        factory_code = coalesce(excluded.factory_code, e.factory_code),
        last_login_at = excluded.last_login_at
  returning e.name, e.factory_code
$$;
comment on function public.record_login(text, text, text) is
  '換證成功：更新員工參照的姓名、廠區與最後登入時間（Q98 (8)）；這次沒帶姓名或廠區就留著原本的，回傳存下來的姓名與廠區（#218）。只給換證服務（service_role）呼叫。';
revoke execute on function public.record_login(text, text, text) from public, anon, authenticated;
grant execute on function public.record_login(text, text, text) to service_role;
