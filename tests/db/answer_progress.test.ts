// 答題頁的「已答 a／b 題」（#134）在瀏覽器裡用 isAnswered 算，首頁的「已答 a／b 題」與送出的「未作答」用資料庫的
// answer_is_complete。兩邊各寫一份，這裡逐一比對所有組合，規則一改就會在這裡分歧。
import { describe, expect, it } from 'vitest'
import { DESIGN_OPTIONS, EXECUTION_OPTIONS, SATISFACTION_OPTIONS, type Answer } from '../../src/api/answerModel'
import { isAnswered } from '../../src/domain/answering'
import { withSuperuser } from './helpers'

const LAYOUTS = ['control_activity', 'element'] as const
const withNull = <T>(options: readonly T[]) => [null, ...options]

describe('isAnswered agrees with answer_is_complete', () => {
  it('on every combination of 內控設計, 執行情形 and 滿意度 on both layouts', async () => {
    const cases = LAYOUTS.flatMap((layout) =>
      withNull(DESIGN_OPTIONS).flatMap((design) =>
        withNull(EXECUTION_OPTIONS).flatMap((execution) =>
          withNull(SATISFACTION_OPTIONS).map((satisfaction) => ({ layout, answer: { design, execution, satisfaction, improvement: null } as Answer })),
        ),
      ),
    )
    const { rows } = await withSuperuser((sql) =>
      sql.query<{ complete: boolean }>(
        `select public.answer_is_complete(
           (c->>'layout')::public.template_layout, (c->>'design')::public.design_status,
           (c->>'execution')::public.execution_status, (c->>'satisfaction')::public.satisfaction_level
         ) as complete
         from jsonb_array_elements($1::jsonb) with ordinality t(c, n) order by n`,
        [JSON.stringify(cases.map(({ layout, answer }) => ({ layout, ...answer })))],
      ),
    )
    expect(rows.map((r) => r.complete)).toEqual(cases.map(({ layout, answer }) => isAnswered(layout, answer)))
  })
})
