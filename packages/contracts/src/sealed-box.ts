import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Шифротекст ключа от биржи — часть контракта между сервисами, а не внутреннее
// дело одного из них: шифрует `api`, расшифровывает `ingestor`, и совпадать у
// них должно всё — алгоритм, длина nonce, место тега. Поэтому модуль лежит
// рядом с типами событий.
//
// GCM, а не CBC: подменённый шифротекст должен ломать расшифровку, а не
// превращаться в мусор, с которым код пойдёт на биржу.

const ALGORITHM = 'aes-256-gcm'

// 96 бит — длина nonce, под которую GCM спроектирован: при ней счётчик блоков
// не укорачивается и реализация не хеширует nonce лишний раз.
const NONCE_BYTES = 12

// AES-256 — ключ ровно в 32 байта. Короче нельзя, длиннее — другой алгоритм.
export const MASTER_KEY_BYTES = 32

// Байты, а не Buffer: из базы коробка приходит Uint8Array, и тип контракта
// обязан это принимать. `seal` отдаёт Buffer — его удобно кодировать в base64.
export type SealedBox = {
  ciphertext: Uint8Array
  nonce: Uint8Array
  // Тег аутентификации. Хранится рядом: без него расшифровка не отличит
  // подменённые байты от настоящих.
  tag: Uint8Array
}

export function seal(
  plain: string,
  masterKey: Uint8Array,
): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  // Свой nonce на каждую запись: повторный nonce с тем же ключом в GCM — это
  // не «чуть слабее», а раскрытый поток.
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { ciphertext, nonce, tag: cipher.getAuthTag() }
}

export function unseal(box: SealedBox, masterKey: Uint8Array): string {
  const decipher = createDecipheriv(ALGORITHM, masterKey, box.nonce)
  decipher.setAuthTag(box.tag)
  // final() бросает, если тег не сошёлся: подмена и чужой мастер-ключ
  // различимы от правильной расшифровки, и это проверяется тестом.
  return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]).toString('utf8')
}

// Мастер-ключ лежит файлом на сервере и читается обоими процессами. В базе его
// нет намеренно: ключ рядом с шифротекстом не защищает ни от чего — тот, кто
// унёс базу, унёс и то, и другое.
export function parseMasterKey(text: string): Buffer {
  // hex, а не сырые байты: файл можно открыть глазами и сверить, и он не
  // ломается переносом строки или кодировкой.
  const key = Buffer.from(text.trim(), 'hex')
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `мастер-ключ: нужно ${MASTER_KEY_BYTES} байт в hex, получено ${key.length}`,
    )
  }
  return key
}
