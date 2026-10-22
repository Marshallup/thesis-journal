// Один префикс на весь клиент: версия API меняется здесь, а не в каждом вызове.
const BASE = '/api/v1'

// Код и тело ответа, а не только текст: экранам надо отличать «отчёт уже
// применяется» (409) от «в отчёте продажи без покупок» (400) и показывать
// человеку то, что написал сервер, а не «POST /api/v1/imports → 400».
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Nest кладёт текст в message, и у ошибок валидации это массив.
function messageOf(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback
  const { message } = body as { message?: unknown }
  if (typeof message === 'string' && message !== '') return message
  if (Array.isArray(message)) return message.join('; ')
  return fallback
}

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'UnauthorizedError'
  }
}

// Access-токен живёт в памяти, а не в localStorage: оттуда его забирает любой
// XSS. Перезагрузка страницы восстанавливает сессию через refresh-cookie.
let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

// Один общий запрос на всех: ротация списывает refresh первым обращением,
// и второй параллельный получит 401, затерев токен первого.
let inFlight: Promise<boolean> | null = null

export function refreshSession(): Promise<boolean> {
  inFlight ??= requestRefresh().finally(() => {
    inFlight = null
  })
  return inFlight
}

// Сырой fetch, а не api(): иначе 401 на самом refresh снова позвал бы refresh.
async function requestRefresh(): Promise<boolean> {
  const response = await fetch(`${BASE}/auth/refresh`, { method: 'POST' })
  if (!response.ok) {
    accessToken = null
    return false
  }
  const body = (await response.json()) as { accessToken: string }
  accessToken = body.accessToken
  return true
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = () =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        // FormData сам выставляет content-type вместе с boundary; задать его
        // руками — значит сломать разбор multipart на сервере.
        ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    })

  let response = await send()

  // Повтор ровно один. Без ограничения истёкшая сессия даёт бесконечный цикл
  // «запрос → 401 → refresh → 401 → запрос».
  if (response.status === 401 && (await refreshSession())) {
    response = await send()
  }
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) {
    // Тело читаем всегда: там лежит объяснение, ради которого сервер и
    // старался. Если его нет — остаётся метод, путь и код.
    const body: unknown = await response.json().catch(() => null)
    throw new ApiError(
      response.status,
      body,
      messageOf(body, `${init.method ?? 'GET'} ${BASE}${path} → ${response.status}`),
    )
  }

  return (await response.json()) as T
}
