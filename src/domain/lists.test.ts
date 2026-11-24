import { describe, expect, it } from 'vitest'
import { listLoading } from './lists'

describe('listLoading', () => {
  it('is loading while the first fetch is under way', () => {
    expect(listLoading({ isPending: true, isFetching: true })).toBe(true)
  })

  it('is loading while an empty list kept from earlier is fetched again', () => {
    expect(listLoading({ isPending: false, isFetching: true, data: [] })).toBe(true)
  })

  it('keeps showing the rows it has while they refresh', () => {
    expect(listLoading({ isPending: false, isFetching: true, data: [{ id: 'a' }] })).toBe(false)
  })

  it('is done once the fetch came back, empty or not', () => {
    expect(listLoading({ isPending: false, isFetching: false, data: [] })).toBe(false)
    expect(listLoading({ isPending: false, isFetching: false, data: [{ id: 'a' }] })).toBe(false)
  })
})
