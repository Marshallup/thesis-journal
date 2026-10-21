import { afterEach, expect, it, vi } from 'vitest'
import { refreshSession } from './client.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

// Ротация списывает refresh-токен первым же обращением: параллельный второй
// запрос строки не найдёт и получит 401. Если клиент шлёт два refresh разом,
// ответ проигравшего затирает успех победителя, и человек с живой сессией
// видит форму входа.
it('не шлёт два refresh одновременно', async () => {
  const fetchMock = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return new Response(JSON.stringify({ accessToken: 'fresh' }), { status: 200 })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const [first, second] = await Promise.all([refreshSession(), refreshSession()])

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(first).toBe(true)
  expect(second).toBe(true)
})

// Следующий запрос после завершения — уже новый: иначе протухший результат
// держался бы вечно.
it('после завершения начинает новый запрос', async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ accessToken: 'fresh' }), { status: 200 }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  await refreshSession()
  await refreshSession()

  expect(fetchMock).toHaveBeenCalledTimes(2)
})
