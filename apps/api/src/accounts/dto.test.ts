import { expect, it } from 'vitest'
import { createAccountSchema } from './dto.ts'

const account = { provider: 'bybit', baseCurrency: 'usdt' }

// Валюта длиннее трёх символов — не исключение, а норма для биржи. Проверка
// жила тройкой в трёх местах сразу: в колонке, в этой схеме и в поле формы.
it('валюта стейблкоина проходит и приводится к верхнему регистру', () => {
  expect(createAccountSchema.parse(account).baseCurrency).toBe('USDT')
})

it('валюта короче трёх символов и длиннее десяти отбивается', () => {
  expect(() => createAccountSchema.parse({ ...account, baseCurrency: 'US' })).toThrow()
  expect(() => createAccountSchema.parse({ ...account, baseCurrency: 'ОЧЕНЬДЛИННАЯ' })).toThrow()
})

// Пробелы по краям — следствие копирования из кабинета биржи, а не ввода.
it('пробелы по краям срезаются', () => {
  expect(createAccountSchema.parse({ ...account, baseCurrency: ' usdt ' }).baseCurrency).toBe(
    'USDT',
  )
})
