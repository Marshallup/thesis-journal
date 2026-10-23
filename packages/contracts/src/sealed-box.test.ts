import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { MASTER_KEY_BYTES, parseMasterKey, seal, unseal } from './sealed-box.ts'

const masterKey = randomBytes(MASTER_KEY_BYTES)

// Портим один байт, не меняя длины: подмена должна ловиться тегом, а не
// несовпадением размеров.
function flip(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes)
  copy[0] = (copy[0] ?? 0) ^ 0xff
  return copy
}

it('один и тот же секрет шифруется по-разному и расшифровывается обратно', () => {
  const first = seal('bybit-secret', masterKey)
  const second = seal('bybit-secret', masterKey)

  expect(first.ciphertext.equals(second.ciphertext)).toBe(false)
  expect(unseal(first, masterKey)).toBe('bybit-secret')
  expect(unseal(second, masterKey)).toBe('bybit-secret')
})

// Главный тест про выбор режима: аутентифицированное шифрование ловит подмену.
// CBC на этом месте вернул бы мусор, и с ним пошли бы на биржу.
it('подмена шифротекста ломает расшифровку, а не возвращает мусор', () => {
  const box = seal('bybit-secret', masterKey)

  expect(() => unseal({ ...box, ciphertext: flip(box.ciphertext) }, masterKey)).toThrow()
})

it('подмена тега тоже отбивается', () => {
  const box = seal('bybit-secret', masterKey)

  expect(() => unseal({ ...box, tag: flip(box.tag) }, masterKey)).toThrow()
})

// Если мастер-ключ у api и у воркера разный, узнать об этом надо на записи
// ключа, а не при первой синхронизации с биржей.
it('чужой мастер-ключ не расшифровывает', () => {
  const box = seal('bybit-secret', masterKey)

  expect(() => unseal(box, randomBytes(MASTER_KEY_BYTES))).toThrow()
})

it('мастер-ключ не той длины отбивается на чтении', () => {
  expect(() => parseMasterKey('ab'.repeat(16))).toThrow(/нужно 32 байт/)
  // Не hex вовсе: Buffer.from молча отдаёт пустой буфер, и без проверки
  // длины процесс поднялся бы с ключом из нуля байт.
  expect(() => parseMasterKey('не hex и близко')).toThrow(/нужно 32 байт/)
})

it('мастер-ключ в 32 байта читается, перевод строки не мешает', () => {
  const text = `${masterKey.toString('hex')}\n`

  expect(parseMasterKey(text).equals(masterKey)).toBe(true)
})
