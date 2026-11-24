-- 暫行（Q134，修訂 Q132）：OMS 連不上期間，分派選人的備援名單不限廠區——列 CSA 權限管理名單上所有人，任何人都能被
-- 分派去填任何廠的表，稽核人員才能用手上只有 CSA 名單的人把整張自評表實測走完。OMS 專用比對通道上線、選人改回 OMS
-- 名單後，把這個檔案的改動撤掉（函式內容還原成 20261130000000 的版本，或直接移除備援）。
--
-- 與 Q132 的差別只有兩處：拿掉「列的人要是本廠」；employee_ref 沒有他的人（沒登入過、用部署指令加進名單）原本因為
-- 比不了廠區而不列，現在也列（姓名、廠區為空，只能用工號找）。誰能讀不變（稽核管理者、系統維護員、該廠的廠區管理員），
-- 所以仍以 p_factory_code 判斷呼叫者能不能分派這一廠。回傳的 factory_code 是那個人自己的廠區。

create or replace function public.plant_access_members(p_factory_code text, p_term text default '', p_limit integer default 50)
returns table (emp_id text, name text, factory_code text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_term text := btrim(coalesce(p_term, ''));
begin
  if not (
    public.is_audit_admin()
    or exists (
      select 1 from public.plant_coordinator pc
        join public.plant p on p.id = pc.plant_id
       where pc.emp_id = public.current_emp_id() and p.factory_code = p_factory_code
    )
  ) then
    raise exception 'only the 廠區管理員 of this plant or a 稽核管理者 can list its people' using errcode = '42501';
  end if;

  return query
    select a.emp_id, e.name, e.factory_code
    from public.access_allowlist a
    left join public.employee_ref e on e.emp_id = a.emp_id
    where (v_term = '' or strpos(upper(a.emp_id), upper(v_term)) > 0 or strpos(upper(coalesce(e.name, '')), upper(v_term)) > 0)
    order by a.emp_id
    limit greatest(least(coalesce(p_limit, 50), 200), 1);
end
$$;
comment on function public.plant_access_members(text, text, integer) is
  '分派選人的備援（Q132、Q134）：權限管理名單上所有人（不限廠區；工號、姓名、他自己的廠區），工號或姓名包含 p_term；只給稽核管理者與 p_factory_code 這一廠的廠區管理員。Q134 暫行，OMS 專用比對通道上線後拿掉不限廠區。';
