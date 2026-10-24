import { expect, it } from 'vitest'
import { formatAmount, isNegativeAmount, isZeroAmount } from './format.ts'

const money = { fractionDigits: 2, maxFractionDigits: 8, signed: false }

it('форматирует строку, не теряя знаков', () => {
  // Через Number это значение превратилось бы в 12345678901234567000.
  expect(formatAmount('12345678901234567890.125', money)).toContain('890,125')
})

it('группирует разряды и ставит запятую десятичным разделителем', () => {
  const formatted = formatAmount('1234567.5', money)

  expect(formatted).toContain('567,50')
  expect(formatted).not.toContain('.')
})

it('показывает знак явно, когда он значим', () => {
  expect(formatAmount('140', { ...money, signed: true })).toMatch(/^\+/)
  expect(formatAmount('-140', { ...money, signed: true })).not.toMatch(/^\+/)
  // У нуля знака нет: «+0» читается как прибыль, которой не было.
  expect(formatAmount('0', { ...money, signed: true })).not.toMatch(/^[+-]/)
})

it('узнаёт ноль по значению, а не по записи', () => {
  expect(isZeroAmount('0')).toBe(true)
  expect(isZeroAmount('0.00000000')).toBe(true)
  expect(isZeroAmount('-0.000')).toBe(true)
  expect(isZeroAmount('0.00000001')).toBe(false)
})

it('не считает минус-ноль убытком', () => {
  expect(isNegativeAmount('-0.00')).toBe(false)
  expect(isNegativeAmount('-0.01')).toBe(true)
  expect(isNegativeAmount('1')).toBe(false)
})

// Число, которого нет, не должно ронять страницу: формат и проверки получают
// строку, а поле может не прийти вовсе — сервер отвечает версией старше
// страницы. Экран показывает прочерк, а не белое полотно.
it('пустая строка не считается нулём и не ломает проверки', () => {
  expect(isZeroAmount('0')).toBe(true)
  expect(isZeroAmount('-0.000')).toBe(true)
  expect(isZeroAmount('')).toBe(true)
  expect(isNegativeAmount('')).toBe(false)
})
