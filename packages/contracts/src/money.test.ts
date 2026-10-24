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

  it('делит с явным масштабом', () => {
    expect(Money.of('10').div('3').toString()).toBe('3.33333333')
    expect(Money.of('10').div('3', 2).toString()).toBe('3.33')
    expect(Money.of('10').div('4').toString()).toBe('2.5')
  })

  it('округляет к чётному, а не вверх', () => {
    // HALF_UP дал бы 0.00000001 и 0.00000002 — смещение вверх на каждой копейке
    expect(Money.of('0.000000005').div('1').toString()).toBe('0')
    expect(Money.of('0.000000015').div('1').toString()).toBe('0.00000002')
  })

  it('отказывается делить на ноль, а не отдаёт Infinity', () => {
    expect(() => Money.of('1').div('0')).toThrow('division by zero')
  })

  it('принимает Money и не меняет значение', () => {
    expect(Money.of(Money.of('5')).toString()).toBe('5')
    expect(Money.of('2').plus(Money.of('3')).toString()).toBe('5')
  })
})

it('gt строго больше, а не больше или равно', () => {
  expect(Money.of('0.3').gt('0.2')).toBe(true)
  expect(Money.of('0.3').gt('0.3')).toBe(false)
  expect(Money.of('-0.1').gt('0')).toBe(false)
})

// Знак в выгрузках биржи несёт смысл «ушло со счёта», а количество и цена в
// журнале положительны всегда: сторону несёт отдельное поле.
it('abs и negated меняют знак, не теряя точности', () => {
  expect(Money.of('-0.00105400000000000000').abs().toString()).toBe('0.001054')
  expect(Money.of('146.541009').negated().toString()).toBe('-146.541009')
  expect(Money.of('-0').abs().toString()).toBe('0')
})
