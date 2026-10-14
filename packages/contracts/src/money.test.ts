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

  it('операция вычитания в отрицательное', () => {
    expect(Money.of('3.123').minus('4.05').toString()).toBe('-0.927')
  })

  it('сравнивает по значению, а не по записи', () => {
    expect(Money.of('1.0').eq('1.00')).toBe(true)
    expect(Money.of('1').eq('2')).toBe(false)
  })

  it('сравнивает на границе равенства', () => {
    expect(Money.of('2').gte('2')).toBe(true)
    expect(Money.of('1').gte('2')).toBe(false)
    expect(Money.of('1').lt('2')).toBe(true)
    expect(Money.of('2').lt('2')).toBe(false)
  })

  it('не считает ноль отрицательным', () => {
    expect(Money.of('0').isNegative()).toBe(false)
    expect(Money.of('-0.000000000000000001').isNegative()).toBe(true)
  })

  it('принимает Money и не меняет значение', () => {
    expect(Money.of(Money.of('5')).toString()).toBe('5')
    expect(Money.of('2').plus(Money.of('3')).toString()).toBe('5')
  })
})
