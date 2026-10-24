import { Logger } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { JwtService } from '@nestjs/jwt'
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets'
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets'
import type { WebSocket } from 'ws'
import { PortfolioService } from '../portfolio/portfolio.service.ts'
import { PRICE_APPLIED } from '../prices/price-applied.event.ts'

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
@WebSocketGateway({ path: '/ws' })
export class PortfolioGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown
{
  private readonly log = new Logger(PortfolioGateway.name)
  private readonly clients = new Map<WebSocket, ClientState>()

  constructor(
    private readonly jwt: JwtService,
    private readonly portfolio: PortfolioService,
  ) {}

  handleConnection(client: WebSocket): void {
    const state: ClientState = { userId: null, lastSentAt: 0, pending: null, closeTimer: null }
    state.closeTimer = setTimeout(
      () => client.close(CODES.unauthorized, 'auth timeout'),
      AUTH_TIMEOUT_MS,
    )
    this.clients.set(client, state)
  }

  handleDisconnect(client: WebSocket): void {
    const state = this.clients.get(client)
    if (state?.closeTimer) clearTimeout(state.closeTimer)
    if (state?.pending) clearTimeout(state.pending)
    this.clients.delete(client)
  }

  // Конверт входящего сообщения — шлюзовой, `{ event, data }`: свой поверх
  // него был бы вторым протоколом в том же соединении.
  @SubscribeMessage('auth')
  async auth(@MessageBody() body: unknown, @ConnectedSocket() client: WebSocket): Promise<void> {
    const state = this.clients.get(client)
    // Повторная авторизация ничего не меняет: сокет уже чей-то.
    if (!state || state.userId) return

    const token = (body as { token?: unknown } | null)?.token
    if (typeof token !== 'string') {
      client.close(CODES.malformed, 'token expected')
      return
    }

    let userId: string
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token)
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

  onApplicationShutdown(): void {
    for (const [client, state] of this.clients) {
      if (state.closeTimer) clearTimeout(state.closeTimer)
      if (state.pending) clearTimeout(state.pending)
      client.close()
    }
    this.clients.clear()
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
    // Отметка времени до запроса, а не после: иначе медленный запрос сдвигает
    // окно, и клиент получает сообщения чаще, чем раз в секунду.
    state.lastSentAt = Date.now()

    try {
      // Тот же итог, что на экране, и считается он тем же кодом: второй,
      // «быстрый» расчёт жил бы своей жизнью и однажды разошёлся бы с первым.
      const { grandTotal } = await this.portfolio.summary(state.userId)
      client.send(
        JSON.stringify({
          event: 'portfolio.value',
          data: {
            total: grandTotal.totalPnl,
            currency: grandTotal.currency,
            // Валюта без курса в итог не вошла: признак едет вместе с числом.
            incomplete: grandTotal.incomplete,
            ts: new Date().toISOString(),
          },
        }),
      )
    } catch (error) {
      // Молчащий сокет выглядит как работающий: сказать вслух.
      this.log.warn(`итог не посчитан: ${String(error)}`)
    }
  }
}
