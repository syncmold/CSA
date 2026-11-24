-- 分派表匯入到簽核流程（Q147 (6)；工單 #224，規格 #221）。用語依 GLOSSARY.md。
--
-- 分派填寫人頁「下次發出」的下載／匯入分派表對的是流程上的人：下載本廠每個範本流程目前的人，匯入寫回流程，發出時照抄。
-- 檔案的四項檢查、預覽與 OMS 比對照舊在前端與 CSA 後端（src/domain/assignmentSheet.ts、exchange/omsMatch.ts），格式仍是
-- csa-assignment-v1。這裡只有寫入：
--
--   import_route_assignment  確認匯入後一次寫入：每一格照樣走 assign_route_signer，所以誰能寫（稽核主管、系統維護員、該流程
--                            廠區的廠區管理員）、連動關卡不能寫、空白不寫、異動紀錄（流程分派／流程換人，每一格一筆）都和逐格
--                            選人相同。整批在同一個交易：有一格被拒就整批不寫。流程沒有「已簽」，不跳過任何一格。
--                            security invoker：不比逐格選人多任何權限。
--
-- 已發出年度的匯入（import_assignment）不變：20261215000000 已改成只有稽核主管，換人寫回流程。

create function public.import_route_assignment(p_cells jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cell    jsonb;
  v_written int := 0;
begin
  if jsonb_typeof(p_cells) is distinct from 'array' then
    raise exception 'p_cells must be an array of {route_step_id, emp_id}' using errcode = '22023';
  end if;
  for v_cell in select value from jsonb_array_elements(p_cells) loop
    perform public.assign_route_signer((v_cell ->> 'route_step_id')::uuid, v_cell ->> 'emp_id', null);
    v_written := v_written + 1;
  end loop;
  return jsonb_build_object('written', v_written);
end
$$;
comment on function public.import_route_assignment(jsonb) is
  '匯入分派表到簽核流程（下次發出，Q147）確認後的寫入：[{route_step_id, emp_id}] 逐格呼叫 assign_route_signer，同一個交易，'
  '有一格被拒就整批不寫；回傳 {written}。';
revoke execute on function public.import_route_assignment(jsonb) from public, anon;
grant execute on function public.import_route_assignment(jsonb) to authenticated;
