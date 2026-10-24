import { Inject, Injectable, Logger } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'

const STREAM = 'wss://stream.bybit.com/v5/public/spot'
// Биржа закрывает молчащее соединение сама; двадцать секунд — её же интервал.
const PING_MS = 20_000
// Пауза перед переподключением растёт: разрыв бывает и на нашей стороне, и на
// бирже, и обслуживание длится минуты. Последняя ступень повторяется.
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000]
// Не больше десяти тем в одном сообщении — ограничение Bybit.
const CHUNK = 10

// Ровно то, что от сокета нужно. Полный `WebSocket` в тип не берём: тогда
// подделка в тестах обязана реализовать весь браузерный интерфейс, а ей нужно
// четыре метода.
export type SocketLike = {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}

export type SocketFactory = (url: string) => SocketLike

export type Tick = { symbol: string; price: string; at: Date }

export const BYBIT_SOCKET = Symbol('BYBIT_SOCKET')

// Node 24 умеет WebSocket сам: отдельной зависимости поток цен не требует.
export const socketProvider = {
  provide: BYBIT_SOCKET,
  useValue: ((url: string) => new WebSocket(url) as unknown as SocketLike) satisfies SocketFactory,
}

const topicOf = (symbol: string) => `tickers.${symbol}`

// Поток цен Bybit: цена меняется десять раз в секунду, и запрашивать её
// опросом значило бы отставать всегда. Подписка только на свои пары — на всю
// биржу это тики по тысяче монет, из которых нужны двадцать.
//
// Размыкателя здесь нет намеренно, и это отступление от правила проекта:
// разрыв потока — норма, а не отказ провайдера. Общий размыкатель Bybit,
// открытый обычным разрывом сокета, остановил бы синхронизацию сделок, которая
// работает. Вместо него backoff, и он же ограничивает частоту попыток.
@Injectable()
export class BybitWsClient implements OnApplicationShutdown {
  private readonly log = new Logger(BybitWsClient.name)
  // Темы, а не символы: восстанавливать после разрыва надо именно их.
  private readonly topics = new Set<string>()
  private socket: SocketLike | null = null
  private ready = false
  private attempt = 0
  private stopped = false
  private ping: ReturnType<typeof setInterval> | null = null
  private handler: ((tick: Tick) => void) | null = null

  constructor(@Inject(BYBIT_SOCKET) private readonly open: SocketFactory) {}

  onTick(handler: (tick: Tick) => void): void {
    this.handler = handler
  }

  // Подписка докладывается, а не заменяется: новая монета в журнале добавляет
  // тему, а не пересобирает соединение.
  subscribe(symbols: string[]): void {
    const fresh = symbols.map(topicOf).filter((topic) => !this.topics.has(topic))
    for (const topic of fresh) this.topics.add(topic)
    if (this.topics.size === 0) return

    if (!this.socket) {
      this.connect()
      return
    }
    // Пока соединение не открылось, отправлять нельзя — и не нужно: при
    // открытии уезжает весь набор тем целиком.
    if (this.ready && fresh.length > 0) this.send(fresh)
  }

  onApplicationShutdown(): void {
    this.stopped = true
    this.stopPing()
    this.socket?.close()
    this.socket = null
  }

  private connect(): void {
    const socket = this.open(STREAM)
    this.socket = socket
    this.ready = false

    socket.addEventListener('open', () => {
      this.ready = true
      this.attempt = 0
      // Переподписка при каждом открытии: биржа о прошлом соединении не знает,
      // и соединение без подписок выглядит живым, но молчит.
      this.send([...this.topics])
      this.ping = setInterval(() => socket.send(JSON.stringify({ op: 'ping' })), PING_MS)
      this.log.log(`поток цен Bybit, подписок: ${this.topics.size}`)
    })
    socket.addEventListener('message', (event) => this.receive(event.data))
    // Ошибка приедет вместе с close: обрабатывать её дважды значит
    // переподключаться дважды.
    socket.addEventListener('error', () => {})
    socket.addEventListener('close', () => this.reconnect())
  }

  private reconnect(): void {
    this.stopPing()
    this.socket = null
    this.ready = false
    if (this.stopped || this.topics.size === 0) return

    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 1_000
    this.attempt += 1
    // Предупреждение, а не ошибка: разрыв на бирже — обычное дело, а молчащий
    // поток выглядит как работающий.
    this.log.warn(`поток цен оборвался, переподключение через ${delay} мс`)
    setTimeout(() => {
      if (!this.stopped) this.connect()
    }, delay)
  }

  private stopPing(): void {
    if (!this.ping) return
    clearInterval(this.ping)
    this.ping = null
  }

  private send(topics: string[]): void {
    for (let i = 0; i < topics.length; i += CHUNK) {
      this.socket?.send(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + CHUNK) }))
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return

    let body: unknown
    try {
      body = JSON.parse(data)
    } catch {
      // Поток отдаёт и служебные ответы на подписку; нечитаемое сообщение не
      // повод рвать соединение.
      return
    }

    const message = body as {
      topic?: string
      ts?: number
      data?: { symbol?: string; lastPrice?: string }
    }
    if (!message.topic?.startsWith('tickers.')) return

    const symbol = message.data?.symbol
    const price = message.data?.lastPrice
    // Нулевая цена не цена: на делистнутых парах биржа отдаёт ноль.
    if (!symbol || !price || Number(price) <= 0) return

    this.handler?.({ symbol, price, at: new Date(message.ts ?? Date.now()) })
  }
}
