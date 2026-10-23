import type { ApiKeyInfo } from './client.ts'

// Право на вывод средств дневнику не нужно никогда. Проверяется отдельно от
// readOnly: если семантика флага у биржи когда-нибудь изменится, отказать
// лишний раз дешевле, чем принять ключ, которым можно вывести деньги.
const WITHDRAW = /withdraw/i

export type Verdict =
  | { ok: true; scopes: string[] }
  | { ok: false; scopes: string[]; reason: string }

// Дневнику нужен ключ только на чтение, и это обещано в README. Решает флаг
// readOnly: у Bybit он и означает «писать нельзя», независимо от того, какие
// группы перечислены в permissions — там при readOnly = 1 перечислено то, что
// ключ умеет читать.
export function verdict(info: ApiKeyInfo): Verdict {
  const scopes = Object.entries(info.permissions ?? {}).flatMap(([group, rights]) =>
    rights.map((right) => `${group}:${right}`),
  )

  if (info.readOnly !== 1) {
    return {
      ok: false,
      scopes,
      reason:
        'ключ умеет торговать и переводить средства. Нужен ключ с правом только на чтение: ' +
        'в кабинете Bybit это «Read-only» при создании ключа',
    }
  }

  const withdraw = scopes.find((scope) => WITHDRAW.test(scope))
  if (withdraw) {
    return { ok: false, scopes, reason: `у ключа есть право на вывод средств (${withdraw})` }
  }

  return { ok: true, scopes }
}
