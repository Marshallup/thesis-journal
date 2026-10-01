import { describe, expect, it } from 'vitest'
import { Money } from './money.ts'

describe('Money', () => {
  it('складывает без потери точности, в отличие от number', () => {
    expect(0.1 + 0.2).not.toBe(0.3) // напоминание, зачем всё это
    expect(Money.of('0.1').plus('0.2').toString()).toBe('0.3')
  })

  it('держит 18 знаков', () => {
    expect(Money.of('0.000000000000000001').times('3').toString()).toBe('0.000000000000000003')
  })

  it('отказывается принимать number', () => {
    // @ts-expect-error number для денег запрещён на уровне типов
    expect(() => Money.of(0.1)).toThrow('number is not allowed')
  })
})
