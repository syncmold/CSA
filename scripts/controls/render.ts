// 內控文件轉檔 ②: 解析出的內控文件＋內控依據對照（Q38） → 種子 SQL（migration 檔）。
// 和範本種子（scripts/templates/render.ts）一樣，資料以 JSON 字面值放在 dollar-quoted 字串裡，SQL 再用 jsonb
// 函式展開，所以條文不需要逐字跳脫。
import type { ParsedClause } from './parse.ts'

/** 一份內控文件目前這一版，連同它的條文；pdfFile 是轉成的 PDF 在本機設定資料夾裡的檔名（不進版控）。 */
export interface ControlDocumentSeed {
  number: string
  code: string
  name: string
  version: string
  effectiveDate: string
  pdfFile: string
  clauses: ParsedClause[]
}

/**
 * 內控依據對照（Q34、Q38–Q40）：一份範本在一個廠區，每章的預設依據文件與每個控制要點對到的條文。
 * 章節與控制要點以位置對應，另寫出名稱與文字讓人審閱，種子寫入時也逐一比對，範本改過就停下來。
 * 依據寫成畫面上的簡碼「PR01 §6.1」。沒有對應條文的控制要點 references 為空（Q41，畫面留白）。
 */
export interface ReferenceMapping {
  template: { code: string; version: string }
  factoryCode: string
  sections: {
    position: number
    name: string
    /** 本章依據的內控文件簡碼。 */
    documents: string[]
    controlPoints: { position: number; text: string; references: string[] }[]
  }[]
}

export function parseReference(ref: string): { document: string; clause: string } {
  const m = ref.match(/^([A-Z]+\d+) §(\d+(?:\.\d+)*)$/)
  if (!m) throw new Error(`內控依據要寫成「PR01 §6.1」的形式：${ref}`)
  return { document: m[1]!, clause: m[2]! }
}

/** 對照檔裡每一個文件與條文都要在轉檔的文件裡；回傳找不到的，一行一個。 */
export function checkReferences(documents: ControlDocumentSeed[], mapping: ReferenceMapping): string[] {
  const byCode = new Map(documents.map((d) => [d.code, d]))
  const problems: string[] = []
  for (const s of mapping.sections) {
    for (const code of s.documents) {
      if (!byCode.has(code)) problems.push(`${s.position}. ${s.name} 的本章依據 ${code} 不是轉檔的內控文件`)
    }
    for (const p of s.controlPoints) {
      for (const ref of p.references) {
        const { document, clause } = parseReference(ref)
        const doc = byCode.get(document)
        if (!doc) problems.push(`${s.position}.${p.position} 的內控依據 ${ref}：${document} 不是轉檔的內控文件`)
        else if (!doc.clauses.some((c) => c.number === clause)) problems.push(`${s.position}.${p.position} 的內控依據 ${ref}：${document} 沒有第 ${clause} 條`)
      }
    }
  }
  return problems
}

const JSON_TAG = '$csa_json$'
const BODY_TAG = '$seed$'

function literal(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  for (const tag of [JSON_TAG, BODY_TAG]) {
    if (json.includes(tag)) throw new Error(`內容含有 ${tag}，會破壞種子 SQL 的 dollar-quote`)
  }
  return `${JSON_TAG}${json}${JSON_TAG}::jsonb`
}

export function renderControlSeedSql(documents: ControlDocumentSeed[], mapping: ReferenceMapping): string {
  const problems = checkReferences(documents, mapping)
  if (problems.length > 0) throw new Error(`內控依據對照有問題：\n${problems.join('\n')}`)
  // The SQL joins on document code and clause number, so it gets them split here, by the one parser.
  const seeded = {
    ...mapping,
    sections: mapping.sections.map((s) => ({
      ...s,
      controlPoints: s.controlPoints.map((p) => ({ ...p, references: p.references.map(parseReference) })),
    })),
  }

  return `-- 產生檔，請勿手改：由 \`node scripts/controls/convert.mjs\` 從內控文件 Word 原檔與內控依據對照重新產生（scripts/controls/）。
-- 廠區 ${mapping.factoryCode} 的內控文件 ${documents.map((d) => d.code).join('、')}（第 5 節作業內容、第 6 節控制重點的條文），
-- 與範本 ${mapping.template.code} 在該廠區的內控依據（references-02-FQ.json，Q38）。只含作業程序條文，不含任何人名；
-- 轉成的 PDF 不進版控，pdf_file 是本機設定資料夾（CSA_CONTROL_DOC_DIR）裡的檔名。
do ${BODY_TAG}
declare
  docs jsonb := ${literal(documents)};
  mapping jsonb := ${literal(seeded)};
  v_plant uuid;
  v_template uuid;
  expected integer;
  inserted integer;
begin
  select id into v_plant from public.plant where factory_code = mapping ->> 'factoryCode';
  if v_plant is null then
    raise exception '找不到廠區 %', mapping ->> 'factoryCode';
  end if;

  with d as (
    insert into public.control_document (plant_id, number, code, name)
    select v_plant, doc ->> 'number', doc ->> 'code', doc ->> 'name'
    from jsonb_array_elements(docs) doc
    returning id, code
  ),
  v as (
    insert into public.control_document_version (document_id, version, effective_date, pdf_file)
    select d.id, doc ->> 'version', (doc ->> 'effectiveDate')::date, doc ->> 'pdfFile'
    from jsonb_array_elements(docs) doc
    join d on d.code = doc ->> 'code'
    returning id, document_id
  )
  insert into public.control_clause (version_id, position, number, text)
  select v.id, c.ord, c.clause ->> 'number', c.clause ->> 'text'
  from jsonb_array_elements(docs) doc
  join d on d.code = doc ->> 'code'
  join v on v.document_id = d.id
  cross join lateral jsonb_array_elements(doc -> 'clauses') with ordinality as c(clause, ord);

  select id into v_template
  from public.questionnaire_template
  where code = mapping #>> '{template,code}' and version = mapping #>> '{template,version}';
  if v_template is null then
    raise exception '找不到範本 % 版本 %', mapping #>> '{template,code}', mapping #>> '{template,version}';
  end if;

  -- 章節與控制要點以位置對應，名稱與文字也要一樣：範本改過就停下來，不把依據掛到別的控制要點上。
  select count(*) into expected from jsonb_array_elements(mapping -> 'sections');
  select count(*) into inserted
  from jsonb_array_elements(mapping -> 'sections') s
  join public.template_section ts
    on ts.template_id = v_template and ts.position = (s ->> 'position')::integer and ts.name = s ->> 'name';
  if inserted <> expected then
    raise exception '範本 % 的章節與內控依據對照不符：對照 % 章，對上 % 章', mapping #>> '{template,code}', expected, inserted;
  end if;

  select count(*) into expected from jsonb_array_elements(mapping -> 'sections') s, jsonb_array_elements(s -> 'controlPoints') p;
  select count(*) into inserted
  from jsonb_array_elements(mapping -> 'sections') s
  join public.template_section ts on ts.template_id = v_template and ts.position = (s ->> 'position')::integer
  cross join lateral jsonb_array_elements(s -> 'controlPoints') p
  join public.control_point cp
    on cp.section_id = ts.id and cp.position = (p ->> 'position')::integer and cp.text = p ->> 'text';
  if inserted <> expected then
    raise exception '範本 % 的控制要點與內控依據對照不符：對照 % 題，對上 % 題', mapping #>> '{template,code}', expected, inserted;
  end if;

  insert into public.section_control_document (section_id, plant_id, position, version_id)
  select ts.id, v_plant, sd.ord, ver.id
  from jsonb_array_elements(mapping -> 'sections') s
  join public.template_section ts on ts.template_id = v_template and ts.position = (s ->> 'position')::integer
  cross join lateral jsonb_array_elements_text(s -> 'documents') with ordinality as sd(code, ord)
  join public.control_document doc on doc.plant_id = v_plant and doc.code = sd.code
  join public.control_document_version ver on ver.document_id = doc.id;

  select count(*) into expected
  from jsonb_array_elements(mapping -> 'sections') s, jsonb_array_elements(s -> 'controlPoints') p, jsonb_array_elements(p -> 'references') r;
  insert into public.control_reference (control_point_id, plant_id, position, clause_id)
  select cp.id, v_plant, r.ord, cl.id
  from jsonb_array_elements(mapping -> 'sections') s
  join public.template_section ts on ts.template_id = v_template and ts.position = (s ->> 'position')::integer
  cross join lateral jsonb_array_elements(s -> 'controlPoints') p
  join public.control_point cp on cp.section_id = ts.id and cp.position = (p ->> 'position')::integer
  cross join lateral jsonb_array_elements(p -> 'references') with ordinality as r(ref, ord)
  join public.control_document doc on doc.plant_id = v_plant and doc.code = r.ref ->> 'document'
  join public.control_document_version ver on ver.document_id = doc.id
  join public.control_clause cl on cl.version_id = ver.id and cl.number = r.ref ->> 'clause';
  get diagnostics inserted = row_count;
  if inserted <> expected then
    raise exception '內控依據寫入數不符：預期 %，實際寫入 %', expected, inserted;
  end if;
end
${BODY_TAG};
`
}
