// Есть имя — показываем имя. Безымянный счёт приходится описывать тем, что
// есть: провайдер, валюта, ИИС, дата и, в крайнем случае, хвост id.
const PROVIDERS: Record<string, string> = {
  sber: 'Сбер',
  tinvest: 'Т-Инвест',
  bybit: 'Bybit',
  bitget: 'Bitget',
  manual: 'без брокера',
}

export type LabelledAccount = {
  id: string
  name: string | null
  provider: string
  baseCurrency: string
  isIis: boolean
  createdAt: string
}

function describe(account: LabelledAccount): string {
  const parts = [PROVIDERS[account.provider] ?? account.provider, account.baseCurrency]
  if (account.isIis) parts.push('ИИС')
  return parts.join(' · ')
}

function withDate(account: LabelledAccount): string {
  return `${describe(account)} · от ${new Date(account.createdAt).toLocaleDateString('ru-RU')}`
}

// Уточнения добавляются по одному и только пока подпись остаётся неоднозначной:
// сравнивается готовая строка, а не поля по отдельности — два счёта одного дня
// различаются датой ничуть не лучше, чем провайдером.
export function accountLabel(account: LabelledAccount, among: LabelledAccount[] = []): string {
  if (account.name) return account.name

  const nameless = among.filter((other) => !other.name)
  const plain = describe(account)
  if (nameless.filter((other) => describe(other) === plain).length < 2) return plain

  const dated = withDate(account)
  if (nameless.filter((other) => withDate(other) === dated).length < 2) return dated

  return `${dated} · #${account.id.slice(-4)}`
}
