import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { OnEvent } from '@nestjs/event-emitter'
import { JwtService } from '@nestjs/jwt'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Server } from 'node:http'
import { PortfolioService } from '../portfolio/portfolio.service.ts'
import { PRICE_APPLIED } from '../prices/price-applied.event.ts'

export const WS_PATH = '/ws'

// Сколько сокет живёт без авторизации. Открытый анонимный сокет — бесплатный
// ресурс для любого желающего, и держать его незачем.
const AUTH_TIMEOUT_MS = 5_000
// Не чаще одного сообщения в секунду на клиента, даже если тиков сто: браузер
// захлёбывается, а человек цену десять раз в секунду не читает.
const THROTTLE_MS = 1_000
const OPEN = 1

// Коды закрытия из частного диапазона 4000–4999: в WebSocket нет кода ответа,
// и причину, кроме строки, сказать нечем.
const CODES = { unauthorized: 4401, malformed: 4400 }

type ClientState = {
  userId: string | null
  lastSentAt: number
  pending: ReturnType<typeof setTimeout> | null
  closeTimer: ReturnType<typeof setTimeout> | null
}

// Живая стоимость портфеля. Токен приходит первым сообщением, а не в
// query-строке: query попадает в логи прокси целиком, и access-токен остался
// бы там навсегда.
//
// Сервер `ws` вешается на уже существующий http-сервер Nest, без
// `@nestjs/websockets` и его адаптера. Причина не в экономии пакета: у
// `@nestjs/core` есть необязательный peer `@nestjs/websockets`, и стоит его
// поставить, как в монорепозитории появляется второй экземпляр ядра. Общий
// `nestjs-pino` привязывается к одному из них, и воркер, который про сокеты
// ничего не знает, перестаёт подниматься с ошибкой про `ApplicationConfig`.
// Поймано 24.10.2026 на `pnpm dev`.
@Injectable()
export class PortfolioGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(PortfolioGateway.name)
  private readonly clients = new Map<WebSocket, ClientState>()
  private sockets: WebSocketServer | null = null

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly jwt: JwtService,
    private readonly portfolio: PortfolioService,
  ) {}

  onApplicationBootstrap(): void {
    // Воркеры поднимаются без http-сервера: там сокетам не на чем жить, и это
    // не ошибка.
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined
    if (!server) return

    // Слушатель апгрейда вешается здесь, до listen(): порт появится позже, а
    // обработчик уже на месте.
    this.sockets = new WebSocketServer({ server, path: WS_PATH })
    this.sockets.on('connection', (client: WebSocket) => this.accept(client))
  }

  onApplicationShutdown(): void {
    for (const [client, state] of this.clients) {
      this.forget(state)
      client.close()
    }
    this.clients.clear()
    this.sockets?.close()
    this.sockets = null
  }

  private accept(client: WebSocket): void {
    const state: ClientState = { userId: null, lastSentAt: 0, pending: null, closeTimer: null }
    state.closeTimer = setTimeout(
      () => client.close(CODES.unauthorized, 'auth timeout'),
      AUTH_TIMEOUT_MS,
    )
    this.clients.set(client, state)

    client.on('message', (raw: unknown) => void this.receive(client, state, String(raw)))
    client.on('close', () => {
      this.forget(state)
      this.clients.delete(client)
    })
    // Ошибка сокета приедет вместе с close: обрабатывать её дважды незачем, но
    // без слушателя `ws` бросает её в процесс.
    client.on('error', () => {})
  }

  private forget(state: ClientState): void {
    if (state.closeTimer) clearTimeout(state.closeTimer)
    if (state.pending) clearTimeout(state.pending)
    state.closeTimer = null
    state.pending = null
  }

  private async receive(client: WebSocket, state: ClientState, raw: string): Promise<void> {
    let message: { type?: unknown; token?: unknown }
    try {
      message = JSON.parse(raw) as { type?: unknown; token?: unknown }
    } catch {
      // Нечитаемое сообщение — не повод рвать соединение: мало ли что пришлёт
      // чужой скрипт в открытый сокет.
      return
    }
    if (message.type !== 'auth') return
    // Повторная авторизация ничего не меняет: сокет уже чей-то.
    if (state.userId) return

    if (typeof message.token !== 'string') {
      client.close(CODES.malformed, 'token expected')
      return
    }

    let userId: string
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(message.token)
      userId = payload.sub
    } catch {
      // Закрываем с кодом, а не молчим: иначе истёкшая сессия выглядит как
      // «сумма просто не обновляется».
      client.close(CODES.unauthorized, 'bad token')
      return
    }

    state.userId = userId
    if (state.closeTimer) {
      clearTimeout(state.closeTimer)
      state.closeTimer = null
    }
    // Сразу текущее значение: иначе до первой цены экран пуст, и непонятно,
    // работает ли вообще.
    await this.send(client, state)
  }

  // Цена применена к проекции — значит итог мог измениться у всех, кто сейчас
  // смотрит. Кому именно, шлюз не выясняет: ответ на этот вопрос стоит запроса
  // в базу на каждый тик, а троттлинг и так ограничивает работу секундой.
  @OnEvent(PRICE_APPLIED)
  onPriceApplied(): void {
    for (const [client, state] of this.clients) {
      if (state.userId) this.schedule(client, state)
    }
  }

  private schedule(client: WebSocket, state: ClientState): void {
    // Уже запланировано: второй таймер слал бы то же число дважды.
    if (state.pending) return

    const wait = THROTTLE_MS - (Date.now() - state.lastSentAt)
    if (wait <= 0) {
      void this.send(client, state)
      return
    }
    state.pending = setTimeout(() => {
      state.pending = null
      void this.send(client, state)
    }, wait)
  }

  private async send(client: WebSocket, state: ClientState): Promise<void> {
    if (!state.userId || client.readyState !== OPEN) return
    // Отметка времени до запроса, а не после: иначе медленный расчёт сдвигает
    // окно, и клиент получает сообщения чаще, чем раз в секунду.
    state.lastSentAt = Date.now()

    try {
      // Тот же итог, что на экране, и считается он тем же кодом: второй,
      // «быстрый» расчёт жил бы своей жизнью и однажды разошёлся бы с первым.
      const { grandTotal } = await this.portfolio.summary(state.userId)
      client.send(
        JSON.stringify({
          type: 'portfolio.value',
          total: grandTotal.totalPnl,
          currency: grandTotal.currency,
          // Валюта без курса в итог не вошла: признак едет вместе с числом.
          incomplete: grandTotal.incomplete,
          ts: new Date().toISOString(),
        }),
      )
    } catch (error) {
      // Молчащий сокет выглядит как работающий: сказать вслух.
      this.log.warn(`итог не посчитан: ${String(error)}`)
    }
  }
}
