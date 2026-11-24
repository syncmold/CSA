// 重建流程的排法（#207，Q143）：每個自評單位一條分流，匯流後照 Word 原檔簽核欄的職稱與稽核室關卡（route-shapes.json）。
import { describe, expect, it } from 'vitest'
import { routeDefinition, routeShapes, templateDefinitions } from './rebuild.mjs'

const signers = { taipei: 'T1', chief: 'C1' }

describe('routeDefinition', () => {
  it('gives each unit its branch, then the 廠區端 titles and the 稽核室 steps of the shape, in order', () => {
    const def = routeDefinition('TC-06', 'TC', ['管理單位', '財會單位'], signers, {
      branchManager: '部門主管', merged: ['副總經理', '廠區經理人'], audit: ['subsidiary', 'taipei_auditor', 'audit_chief'],
    })
    expect(def).toMatchObject({ kind: 'route', templateCode: 'TC-06', factoryCode: 'TC' })
    expect(def.steps.map((s) => s.name)).toEqual([
      '自行檢查人員－管理單位', '部門主管－管理單位', '自行檢查人員－財會單位', '部門主管－財會單位',
      '副總經理', '廠區經理人', '子公司擔當稽核', '台北稽核人員', '稽核主管',
    ])
    expect(def.steps[1]).toEqual({ name: '部門主管－管理單位', group: 'plant', editableUnit: null, branchUnit: '管理單位' })
    expect(def.steps[4]).toEqual({ name: '副總經理', group: 'plant', editableUnit: null })
    // 子公司擔當稽核不存人，發出後由廠區管理員分派（Q143）；連動的兩關帶連動的人。
    expect(def.steps.slice(-3)).toEqual([
      { name: '子公司擔當稽核', group: 'audit_review', signer: null, editableUnit: null },
      { name: '台北稽核人員', group: 'audit_review', signer: 'T1', editableUnit: null, link: 'taipei_auditor' },
      { name: '稽核主管', group: 'audit_review', signer: 'C1', editableUnit: null, link: 'audit_chief' },
    ])
  })

  it('leaves out the 部門主管 and 台北稽核人員 when the Word file has none (SY 董事長簽的表、D 監督)', () => {
    const def = routeDefinition('SY-13', 'SY', ['待指定單位'], { taipei: null, chief: 'C1' }, {
      branchManager: null, merged: ['董事長'], audit: ['subsidiary', 'audit_chief'],
    })
    expect(def.steps.map((s) => s.name)).toEqual(['自行檢查人員－待指定單位', '董事長', '子公司擔當稽核', '稽核主管'])
  })
})

describe('routeShapes', () => {
  it('has a shape for every template, each ending with the 稽核主管 (Q143)', () => {
    const shapes = routeShapes()
    const codes = [...templateDefinitions().map((d) => d.def.code), 'FQ-02']
    expect(codes.filter((c) => !shapes[c])).toEqual([])
    expect(Object.values(shapes).filter((s) => s.audit.at(-1) !== 'audit_chief')).toEqual([])
  })

  it('reads the Word signature blocks as the user decided (2026-11-19)', () => {
    const shapes = routeShapes()
    const summary = (code: string) => {
      const s = shapes[code]!
      return [s.branchManager, ...s.merged, ...s.audit]
    }
    expect(summary('FQ-04')).toEqual(['部門主管', '廠區經理人', 'subsidiary', 'taipei_auditor', 'audit_chief'])
    expect(summary('TH-04')).toEqual(['部門主管', '廠區經理人', 'taipei_auditor', 'audit_chief']) // 子公司擔當稽核從缺
    expect(summary('GT-06')).toEqual(['部門主管', '廠長', '執行副總', 'taipei_auditor', 'audit_chief'])
    expect(summary('TC-06')).toEqual(['部門主管', '副總經理', '廠區經理人', 'subsidiary', 'taipei_auditor', 'audit_chief'])
    expect(summary('TC-05')).toEqual(['部門主管', '副總經理', '廠區經理人', 'subsidiary', 'taipei_auditor', 'audit_chief']) // 中間那格當台北
    expect(summary('SH-04')).toEqual(['部門主管', '總經理', 'taipei_auditor', 'audit_chief'])
    expect(summary('SY-03')).toEqual(['部門主管', '執行副總經理', '總經理', 'subsidiary', 'audit_chief'])
    expect(summary('SY-13')).toEqual([null, '董事長', 'subsidiary', 'audit_chief'])
    expect(summary('FQ-D')).toEqual([null, 'subsidiary', 'taipei_auditor', 'audit_chief'])
    expect(summary('SAMOA-01')).toEqual(['相關所屬主管(審核)', 'subsidiary', 'audit_chief'])
  })
})

describe('templateDefinitions', () => {
  it('reads every definition file once, the FQ-02 seed not among them', () => {
    const codes = templateDefinitions().map((d) => d.def.code)
    expect(codes).toHaveLength(292)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).not.toContain('FQ-02')
  })
})
