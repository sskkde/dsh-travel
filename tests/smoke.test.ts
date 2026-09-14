import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index'

describe('dsh-travel W0 工程地基', () => {
  it('name 为 dsh-travel（注入器标识）', () => {
    expect(name).toBe('dsh-travel')
  })

  it('inject 为数组（W0 空注入，W1 起按需追加）', () => {
    expect(Array.isArray(inject)).toBe(true)
  })

  it('apply 为函数（空 apply 满足 cordis 三件套）', () => {
    expect(typeof apply).toBe('function')
  })
})