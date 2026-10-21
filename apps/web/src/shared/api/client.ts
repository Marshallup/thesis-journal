// Один префикс на весь клиент: версия API меняется здесь, а не в каждом вызове.
const BASE = '/api/v1'

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

// Один общий запрос на всех, кто попросил обновиться, пока он летит.
// Ротация на сервере списывает refresh-токен первым же обращением, поэтому
// второй параллельный запрос гарантированно получит 401 — и затрёт токен,
// добытый первым. Пара параллельных 401 на экране сделок приводит сюда же.
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
        'content-type': 'application/json',
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
    throw new Error(`${init.method ?? 'GET'} ${BASE}${path} → ${response.status}`)
  }

  return (await response.json()) as T
}
