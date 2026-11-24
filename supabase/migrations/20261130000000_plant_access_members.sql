-- 分派選人的備援（Q132，接續 Q131）：OMS 連不上時，分派填寫人與換人的下拉改列 CSA 權限管理名單上、廠區是本廠的人。
-- access_member 只給管理權限的人讀，廠區管理員讀不到，所以另開這支：只回工號、姓名、廠區，只給稽核管理者（含系統
-- 維護員，is_audit_admin）與該廠的廠區管理員。搜尋是工號或姓名「包含」輸入的字（照字面比、不分大小寫，不當萬用字元）。

create function public.plant_access_members(p_factory_code text, p_term text default '', p_limit integer default 50)
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
    join public.employee_ref e on e.emp_id = a.emp_id
    where e.factory_code = p_factory_code
      and (v_term = '' or strpos(upper(a.emp_id), upper(v_term)) > 0 or strpos(upper(coalesce(e.name, '')), upper(v_term)) > 0)
    order by a.emp_id
    limit greatest(least(coalesce(p_limit, 50), 200), 1);
end
$$;
comment on function public.plant_access_members(text, text, integer) is
  '分派選人的備援（Q132）：權限管理名單上、廠區是 p_factory_code 的人（工號、姓名、廠區），工號或姓名包含 p_term；只給稽核管理者與該廠的廠區管理員。';
revoke execute on function public.plant_access_members(text, text, integer) from public, anon;
grant execute on function public.plant_access_members(text, text, integer) to authenticated;
