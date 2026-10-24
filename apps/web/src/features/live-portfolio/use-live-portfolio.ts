import { useEffect, useState } from 'react'
import { getAccessToken, refreshSession } from '../../shared/api/client.ts'

export type LiveTotal = { total: string; currency: string; incomplete: boolean; ts: string }

// Пауза перед переподключением растёт: закрытый ноутбук, упавший api и
// перезапуск в разработке выглядят одинаково, а долбить сервер незачем.
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000]
// Сервер закрывает сокет этим кодом, когда токен не принят: access-токен живёт
// пятнадцать минут, и открытая страница однажды его переживает.
const UNAUTHORIZED = 4401

// Живой итог портфеля. Токен уходит первым сообщением, а не в адресе: адрес
// попадает в логи прокси целиком и остаётся там навсегда.
export function useLivePortfolio(enabled: boolean): LiveTotal | null {
  const [value, setValue] = useState<LiveTotal | null>(null)

  useEffect(() => {
    if (!enabled) return

    let socket: WebSocket | null = null
    let timer: number | undefined
    let attempt = 0
    let stopped = false

    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${scheme}://${window.location.host}/ws`)

      socket.addEventListener('open', () => {
        attempt = 0
        socket?.send(JSON.stringify({ type: 'auth', token: getAccessToken() }))
      })

      socket.addEventListener('message', (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as Partial<LiveTotal> & { type?: string }
        if (message.type === 'portfolio.value' && message.total) setValue(message as LiveTotal)
      })

      socket.addEventListener('close', (event: CloseEvent) => {
        if (stopped) return
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 1_000
        attempt += 1
        timer = window.setTimeout(() => {
          if (stopped) return
          // Токен не принят — сначала обновить сессию: иначе страница тихо
          // перестаёт обновляться через пятнадцать минут, и выглядит это как
          // «живая сумма сломалась».
          if (event.code === UNAUTHORIZED) void refreshSession().then(() => !stopped && connect())
          else connect()
        }, delay)
      })
    }
    connect()

    return () => {
      stopped = true
      window.clearTimeout(timer)
      socket?.close()
    }
  }, [enabled])

  return value
}
