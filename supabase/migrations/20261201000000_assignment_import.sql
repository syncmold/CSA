-- 匯入分派表（工單 #180；Q130）。分派填寫人頁把一廠一年度的分派表下載成 Excel，填好工號再匯入；檔案的四項檢查與預覽在
-- 前端（src/domain/assignmentSheet.ts），OMS 比對在 CSA 後端（exchange/omsMatch.ts）。這裡只有兩件事，規則都沿用分派：
--
--   can_assign_plant   呼叫者能分派這一廠嗎：稽核管理者、系統維護員（is_audit_admin），或這一廠的廠區管理員。
--                      CSA 後端收到 OMS 比對的請求時，用呼叫者自己的 token 問它，不另寫一份角色清單。
--   import_assignment  確認匯入後一次寫入：每一格照樣走 assign_step_signer，所以誰能改哪一關（本廠、廠區端、還沒簽）、
--                      異動紀錄都和逐格選人相同。預覽之後才剛簽、剛結案的關卡跳過並計數；其他拒絕（沒有權限、
--                      稽核室關卡、空白工號）整批不寫。security invoker：不比逐格選人多任何權限。

create function public.can_assign_plant(p_factory_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_audit_admin() or exists (
    select 1 from public.plant_coordinator pc
      join public.plant p on p.id = pc.plant_id
     where pc.emp_id = public.current_emp_id() and p.factory_code = p_factory_code
  )
$$;
comment on function public.can_assign_plant(text) is
  '呼叫者能分派這一廠嗎（Q130 (5)）：稽核管理者、系統維護員，或這一廠的廠區管理員；匯入分派表的 OMS 比對用它擋人。';
revoke execute on function public.can_assign_plant(text) from public, anon;
grant execute on function public.can_assign_plant(text) to authenticated;

create function public.import_assignment(p_cells jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cell    jsonb;
  v_hint    text;
  v_written int := 0;
  v_skipped int := 0;
begin
  if jsonb_typeof(p_cells) is distinct from 'array' then
    raise exception 'p_cells must be an array of {step_id, emp_id}' using errcode = '22023';
  end if;
  for v_cell in select value from jsonb_array_elements(p_cells) loop
    begin
      perform public.assign_step_signer((v_cell ->> 'step_id')::uuid, v_cell ->> 'emp_id', null);
      v_written := v_written + 1;
    exception when check_violation then
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint in ('step_signed', 'assessment_closed') then
        v_skipped := v_skipped + 1;
      else
        raise;
      end if;
    end;
  end loop;
  return jsonb_build_object('written', v_written, 'skipped', v_skipped);
end
$$;
comment on function public.import_assignment(jsonb) is
  '匯入分派表確認後的寫入（Q130）：[{step_id, emp_id}] 逐格呼叫 assign_step_signer；預覽後才簽或結案的跳過並計數，其他拒絕整批不寫。';
revoke execute on function public.import_assignment(jsonb) from public, anon;
grant execute on function public.import_assignment(jsonb) to authenticated;
