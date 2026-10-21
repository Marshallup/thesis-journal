// Один источник правды о форме публичных путей. Путь refresh-cookie обязан
// совпадать с маршрутом до символа: разойдутся — браузер просто не отправит
// cookie, и обновление сессии перестанет работать молча.
export const API_PREFIX = 'api'
export const API_VERSION = '1'

export function apiPath(...segments: string[]): string {
  return `/${API_PREFIX}/v${API_VERSION}/${segments.join('/')}`
}
