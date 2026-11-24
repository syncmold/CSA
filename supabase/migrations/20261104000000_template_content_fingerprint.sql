-- 範本管理先選廠區 (工單 #84 第三段，B2)：清單多兩個計算欄位。實作決定見需求決策紀錄 Q111 (4)。
--
--   題數            控制要點數（一題多單位算一題，和紙本的題號一致）。
--   內容指紋        章節名稱、控制要點文字與各題的自評單位（都依順序）的雜湊。每廠一份範本、互不影響，畫面用它
--                   列出「內容相同的廠區」給稽核部參考：要統一修改同一題時，看得出還有哪些廠要一起改。編號、名稱、
--                   版本、狀態不算內容（陸合的「研發循環（沖壓）」和別廠的「研發循環」題目相同就算相同）。還沒有任何
--                   章節的範本沒有指紋（null），否則所有新建的空範本都會算成內容相同。
--   兩個都是 PostgREST 的計算欄位（select=…,control_point_count,content_fingerprint）。以呼叫者的身分讀，
--   所以照舊只有讀得到範本的稽核管理者拿得到 (RLS)；不新增資料表。

create or replace function public.control_point_count(t public.questionnaire_template)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
  from public.template_section s
  join public.control_point cp on cp.section_id = s.id
  where s.template_id = t.id
$$;
comment on function public.control_point_count(public.questionnaire_template) is '問卷範本的控制要點數（範本管理的「題數」）。';

-- 分隔字元用控制字元，不會出現在章節名稱、控制要點文字與單位名稱裡，所以不同的內容不會接成同一串。
create or replace function public.content_fingerprint(t public.questionnaire_template)
returns text
language sql
stable
set search_path = public
as $$
  select md5(string_agg(s.name || chr(31) || coalesce(p.points, ''), chr(30) order by s.position))
  from public.template_section s
  left join lateral (
    select string_agg(cp.text || chr(29) || coalesce(u.units, ''), chr(28) order by cp.position) as points
    from public.control_point cp
    left join lateral (
      select string_agg(au.name, chr(27) order by cpu.position) as units
      from public.control_point_unit cpu
      join public.assessing_unit au on au.id = cpu.assessing_unit_id
      where cpu.control_point_id = cp.id
    ) u on true
    where cp.section_id = s.id
  ) p on true
  where s.template_id = t.id
$$;
comment on function public.content_fingerprint(public.questionnaire_template) is
  '問卷範本內容（章節、控制要點、各題自評單位，依順序）的雜湊，沒有章節時是 null；範本管理用來列出內容相同的其他廠區（Q111）。';

revoke execute on function public.control_point_count(public.questionnaire_template) from public, anon;
revoke execute on function public.content_fingerprint(public.questionnaire_template) from public, anon;
grant execute on function public.control_point_count(public.questionnaire_template) to authenticated;
grant execute on function public.content_fingerprint(public.questionnaire_template) to authenticated;
