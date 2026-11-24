-- 控制要點的換行照原檔 (工單 #170，需求決策紀錄 Q126)。用語依 GLOSSARY.md。
--
-- Word 原檔有些控制要點在同一格裡分行，轉檔原本把它們接成一行。現在轉檔保留寫完一句才換的行（括號說明、條列項，
-- 條列項前面留「·」），VN-10.1 兩處在詞中間打空白硬湊換行的接回一個詞（使用者 2026-11-11 決定）。這裡把既有的
-- 範本（不分狀態）與已發出的自評表快照（含已結案，使用者決定）裡的同一批文字換成新的寫法：依完整的原文比對，一模
-- 一樣才換，逐份列出換了幾題；只差空白的不換、列出來。比對：新文字拿掉換行（與條列項的「·」）後等於原文；VN-10.1 的兩題拿掉空白後相等。只換文字，控制要點的
-- id、答案、內控依據都不動，也不更新 updated_at（觸發器暫停）。對照表由 #170 前後的草稿定義檔逐題比對產生。

do $$
declare
  v_bad       text;
  v_row       record;
  v_templates integer := 0;
  v_snapshots integer := 0;
begin
  create temp table q126_texts (old_text text primary key, new_text text not null) on commit drop;
  insert into q126_texts (old_text, new_text) values
      -- 15 份：CF-01.1、FF-01.1、FQ-01.1、GH-01.4…
      ('銷貨單據是否序時序號連續開立？(若客戶端採上線模式始確認銷貨者，另應含括上線單據)',
       E'銷貨單據是否序時序號連續開立？\n(若客戶端採上線模式始確認銷貨者，另應含括上線單據)'),
      -- 16 份：CF-B、FF-B、FQ-B、GH-B…
      ('公司內部控制制度是否須因應調整？（意指外部環境、商業模式改變）',
       E'公司內部控制制度是否須因應調整？\n（意指外部環境、商業模式改變）'),
      -- 16 份：CF-B、FF-B、FQ-B、GH-B…
      ('公司內部控制制度是否須因應調整？（意指管理階層異動）',
       E'公司內部控制制度是否須因應調整？\n（意指管理階層異動）'),
      -- 2 份：SH-02、SY-02
      ('供應商之評估作業是否切實依規定辦理？(依規定提出〝供應商資料卡〞、〝供應商代碼申請書〞並登入系統〝合格供應商名冊〞)',
       E'供應商之評估作業是否切實依規定辦理？\n(依規定提出〝供應商資料卡〞、〝供應商代碼申請書〞並登入系統〝合格供應商名冊〞)'),
      -- 1 份：SY-13
      ('董事會議程及資料是否於開會7日前併同召集通知，一併寄送各獨立董事？(召集之通知，經相對人同意者，得以電子方式為之)',
       E'董事會議程及資料是否於開會7日前併同召集通知，一併寄送各獨立董事？\n(召集之通知，經相對人同意者，得以電子方式為之)'),
      -- 1 份：SY-20
      ('審計委員會議程及資料是否於開會7日前併同召集通知，一併寄送各獨立董事成員？但有緊急情事者，不在此限。(召集之通知，經相對人同意者，得以電子方式為之)',
       E'審計委員會議程及資料是否於開會7日前併同召集通知，一併寄送各獨立董事成員？但有緊急情事者，不在此限。\n(召集之通知，經相對人同意者，得以電子方式為之)'),
      -- 1 份：SY-A
      ('內部稽核實施細則是否包括下列項目：1.內部稽核單位之目的、職權及責任。2.對內部控制制度進行評估，以衡量現行政策、程序之有效性及遵循程度與其對各項營運活動之影響。3.釐定稽核項目、時間、程序及方法。',
       E'內部稽核實施細則是否包括下列項目：\n1.內部稽核單位之目的、職權及責任。\n2.對內部控制制度進行評估，以衡量現行政策、程序之有效性及遵循程度與其對各項營運活動之影響。\n3.釐定稽核項目、時間、程序及方法。'),
      -- 1 份：SY-D
      ('內部稽核單位是否評估與企業之治理、營運及資訊系統有關之暴險，包括：企業策略目標之達成。財務及營運資訊之可靠性及完整性。營運及計畫之效果及效率。資產之保全。法令、政策、程序及契約之遵循。',
       E'內部稽核單位是否評估與企業之治理、營運及資訊系統有關之暴險，包括：\n· 企業策略目標之達成。\n· 財務及營運資訊之可靠性及完整性。\n· 營運及計畫之效果及效率。\n· 資產之保全。\n· 法令、政策、程序及契約之遵循。'),
      -- 1 份：VN-10.1
      ('模具的設計變更是否依作業規定填寫「修模檢討報    告」與廠區及供應商確認後進行修模？',
       '模具的設計變更是否依作業規定填寫「修模檢討報告」與廠區及供應商確認後進行修模？'),
      -- 1 份：VN-10.1
      ('模具的驗收是否依作業規定提出「模具驗收單」由工   程相關人員確認？',
       '模具的驗收是否依作業規定提出「模具驗收單」由工程相關人員確認？')
;

  -- 每一組：新文字拿掉換行（與條列項的「·」）後等於原文；沒有換行的（VN-10.1 兩題）是原文拿掉空白後等於新文字。
  select format('「%s」→「%s」', old_text, new_text) into v_bad
  from q126_texts
  where case when new_text like E'%\n%' then regexp_replace(new_text, E'\n(· )?', '', 'g') <> old_text
             else replace(old_text, ' ', '') <> new_text end
  limit 1;
  if v_bad is not null then
    raise exception '換行對照表有一筆拿掉換行後和原文對不上：%', v_bad;
  end if;

  -- 拿掉空白後和某一組原文相同、卻不是一模一樣的控制要點（例如被改過幾個字以外的空白）：不換，列出來。
  for v_row in
    select 'questionnaire_template' as kind, t.code || ' ' || t.version as owner, cp.text
    from public.control_point cp
    join public.template_section s on s.id = cp.section_id
    join public.questionnaire_template t on t.id = s.template_id
    join q126_texts q on regexp_replace(cp.text, '\s', '', 'g') = regexp_replace(q.old_text, '\s', '', 'g')
    where cp.text <> q.old_text and cp.text <> q.new_text
    union all
    select 'assessment', a.template_code || ' 自評表 ' || a.id, cp.text
    from public.assessment_control_point cp
    join public.assessment a on a.id = cp.assessment_id
    join q126_texts q on regexp_replace(cp.text, '\s', '', 'g') = regexp_replace(q.old_text, '\s', '', 'g')
    where cp.text <> q.old_text and cp.text <> q.new_text
  loop
    raise notice '% 的控制要點和原文只差空白，沒有換：「%」', v_row.owner, v_row.text;
  end loop;

  alter table public.control_point disable trigger user;
  alter table public.assessment_control_point disable trigger user;

  for v_row in
    with changed as (
      update public.control_point cp set text = t.new_text from q126_texts t where cp.text = t.old_text returning cp.section_id
    )
    select t.code, count(*) as points
    from changed c
    join public.template_section s on s.id = c.section_id
    join public.questionnaire_template t on t.id = s.template_id
    group by t.code
    order by t.code
  loop
    raise notice '範本 %：% 題', v_row.code, v_row.points;
    v_templates := v_templates + v_row.points;
  end loop;

  for v_row in
    with changed as (
      update public.assessment_control_point cp set text = t.new_text from q126_texts t where cp.text = t.old_text returning cp.assessment_id
    )
    select a.template_code as code, count(*) as points
    from changed c
    join public.assessment a on a.id = c.assessment_id
    group by a.template_code
    order by a.template_code
  loop
    raise notice '自評表快照 %：% 題', v_row.code, v_row.points;
    v_snapshots := v_snapshots + v_row.points;
  end loop;

  alter table public.control_point enable trigger user;
  alter table public.assessment_control_point enable trigger user;

  raise notice '控制要點的換行照原檔：範本 % 題、自評表快照 % 題', v_templates, v_snapshots;
end
$$;
