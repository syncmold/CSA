// 轉檔 ②: 範本定義 → 種子 SQL（migration 檔）。
// 資料以一份 JSON 字面值放在 dollar-quoted 字串裡，SQL 再用 jsonb 函式展開，
// 所以控制要點文字不需要逐字跳脫引號；只要確定文字不會提前結束字面值即可。
import type { ParsedSection, TemplateLayout } from './parse.ts'

/**
 * 種子 migration 的章節：一題一個 assessingUnit。02 的種子早已套用（20261014000003），格式不能變，否則
 * templates:verify 會和已套用的檔案不一致；#46 之後一題多單位只走草稿途徑。
 */
export interface SeedSection {
  name: string
  controlPoints: { text: string; assessingUnit: string | null }[]
}

/** 解析結果 → 種子的章節；有一題多單位、多層章節或題號就丟錯（不默默丟掉），那份範本要改走草稿途徑。 */
export function seedSections(sections: ParsedSection[]): SeedSection[] {
  return sections.map((s) => {
    if (s.level || s.code || s.controlPoints.some((p) => p.code)) throw new Error(`種子 migration 不支援多層章節與題號：「${s.name}」`)
    return {
    name: s.name,
    controlPoints: s.controlPoints.map((p) => {
      if (p.assessingUnits.length > 1) throw new Error(`種子 migration 不支援一題多單位：「${p.text}」（${p.assessingUnits.join('、')}）`)
      return { text: p.text, assessingUnit: p.assessingUnits[0] ?? null }
    }),
    }
  })
}

export interface TemplateDefinition {
  code: string
  name: string
  layout: TemplateLayout
  version: string
  /** Only the FQ-02 seed migration uses this shape, written as it was applied (啟用). */
  status: 'active'
  allPlants: boolean
  assessingUnits: string[]
  sections: SeedSection[]
}

const JSON_TAG = '$csa_json$'
const BODY_TAG = '$seed$'

export function renderSeedSql(def: TemplateDefinition): string {
  const json = JSON.stringify(def, null, 2)
  for (const tag of [JSON_TAG, BODY_TAG]) {
    if (json.includes(tag)) throw new Error(`範本內容含有 ${tag}，會破壞種子 SQL 的 dollar-quote`)
  }

  return `-- 產生檔，請勿手改：由 \`npm run templates:convert\` 從 Word 原檔重新產生（scripts/templates/）。
-- 範本 ${def.code} ${def.name}：只含控制要點文字與結構，不含任何人名。
do ${BODY_TAG}
declare
  def jsonb := ${JSON_TAG}${json}${JSON_TAG}::jsonb;
  tpl_id uuid;
  expected integer;
  inserted integer;
begin
  insert into public.assessing_unit (name)
  select u from jsonb_array_elements_text(def -> 'assessingUnits') as u
  on conflict (name) do nothing;

  insert into public.questionnaire_template (code, name, layout, version, status, all_plants)
  values (
    def ->> 'code', def ->> 'name', (def ->> 'layout')::public.template_layout, def ->> 'version',
    (def ->> 'status')::public.template_status, (def ->> 'allPlants')::boolean
  )
  returning id into tpl_id;

  with s as (
    insert into public.template_section (template_id, position, name)
    select tpl_id, t.ord, t.sec ->> 'name'
    from jsonb_array_elements(def -> 'sections') with ordinality as t(sec, ord)
    returning id, position
  )
  insert into public.control_point (section_id, position, text, assessing_unit_id)
  select s.id, cp.ord, cp.item ->> 'text', au.id
  from jsonb_array_elements(def -> 'sections') with ordinality as t(sec, sord)
  join s on s.position = t.sord
  cross join lateral jsonb_array_elements(t.sec -> 'controlPoints') with ordinality as cp(item, ord)
  join public.assessing_unit au on au.name = cp.item ->> 'assessingUnit';
  get diagnostics inserted = row_count;

  select count(*) into expected
  from jsonb_array_elements(def -> 'sections') as sec,
       jsonb_array_elements(sec -> 'controlPoints') as cp;
  if inserted <> expected then
    raise exception '種子控制要點數不符：預期 %，實際寫入 %', expected, inserted;
  end if;
end
${BODY_TAG};
`
}

/**
 * 對話寫入的範本定義（supabase/drafts/templates/*.json，由 `npm run drafts:write` 交給 draft_template）。
 * 沒有 status 與 version：寫入的一律是停用，啟用由稽核主管在範本管理按；範本沒有版本 (Q90、Q137)。
 */
export interface DraftTemplate {
  kind: 'template'
  /** 產生方式，給人看；資料庫忽略這一欄。 */
  generatedBy: string
  code: string
  name: string
  layout: TemplateLayout
  allPlants: boolean
  factoryCodes: string[]
  sections: ParsedSection[]
}

export function renderDraftJson(def: DraftTemplate): string {
  return `${JSON.stringify(def, null, 2)}\n`
}
