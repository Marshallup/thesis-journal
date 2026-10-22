import { createChart, createSeriesMarkers, LineSeries, TickMarkType } from 'lightweight-charts'
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import { formatMoscowMoment } from '../../shared/ui/format.ts'

export type ChartPoint = { price: string; quotedAt: string }
export type ChartMarker = {
  at: string
  side: 'buy' | 'sell'
  text: string
  kind: 'trade' | 'decision'
}

const GAIN = '#0f766e'
const LOSS = '#8b2c55'
const INK = '#1c1917'
const RULE = '#d6d3d1'

const MOSCOW = 'Europe/Moscow'
const ticks = {
  year: new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, year: 'numeric' }),
  month: new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, month: 'short' }),
  day: new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, day: 'numeric' }),
  time: new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, hour: '2-digit', minute: '2-digit' }),
}

// Время в библиотеке — секунды, не миллисекунды: на миллисекундах график молча
// уезжает в 56000 год.
function seconds(iso: string): UTCTimestamp {
  return Math.floor(Date.parse(iso) / 1000) as UTCTimestamp
}

// Своего часового пояса у библиотеки нет вовсе, ось она рисует в UTC.
// Форматтеры — единственное место, где это лечится.
function tickMark(time: Time, type: TickMarkType): string {
  const at = new Date(Number(time) * 1000)
  if (type === TickMarkType.Year) return ticks.year.format(at)
  if (type === TickMarkType.Month) return ticks.month.format(at)
  if (type === TickMarkType.DayOfMonth) return ticks.day.format(at)
  return ticks.time.format(at)
}

// Дальше пяти дней от любой цены — значит вне истории: привязывать такую
// метку некуда, и честнее сказать, что её на графике нет.
const NEAR_SECONDS = 5 * 24 * 60 * 60

// Метка стоит только на существующей точке, иначе библиотека сдвигает её на
// первую — и все старые сделки слипаются в одну. Берём ближайшую точку, а не
// предыдущую: сделка в 15:57 ближе к закрытию своего дня (18:45), чем к
// вчерашнему, и привязка «не позже» сдвинула бы каждую отметку на день назад.
function snap(times: UTCTimestamp[], at: UTCTimestamp): UTCTimestamp | null {
  let low = 0
  let high = times.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (times[middle]! < at) low = middle + 1
    else high = middle
  }

  const after = times[low]
  const before = times[low - 1]
  const nearest =
    before === undefined
      ? after
      : after === undefined
        ? before
        : at - before <= after - at
          ? before
          : after
  if (nearest === undefined) return null
  return Math.abs(nearest - at) <= NEAR_SECONDS ? nearest : null
}

export function PriceChart({
  points,
  markers,
  averagePrice,
}: {
  points: ChartPoint[]
  markers: ChartMarker[]
  averagePrice: string | null
}) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi>(null)
  const line = useRef<ISeriesApi<'Line'>>(null)
  // Примитив меток и линия средней живут между рендерами: createSeriesMarkers и
  // createPriceLine каждый раз добавляют новые, а не заменяют прежние.
  const pins = useRef<ISeriesMarkersPluginApi<Time>>(null)
  const average = useRef<IPriceLine>(null)
  const [hidden, setHidden] = useState(0)

  // График создаётся один раз и убирается в cleanup: пересоздавать его на каждый
  // рендер — верный способ получить утечку канвасов.
  useEffect(() => {
    if (!box.current) return
    const instance = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: INK, attributionLogo: false },
      grid: { horzLines: { color: RULE }, vertLines: { visible: false } },
      rightPriceScale: { borderColor: RULE },
      timeScale: { borderColor: RULE, timeVisible: true, tickMarkFormatter: tickMark },
      localization: {
        timeFormatter: (time: Time) => formatMoscowMoment(new Date(Number(time) * 1000)),
      },
    })
    chart.current = instance
    const series = instance.addSeries(LineSeries, { color: INK, lineWidth: 2 })
    line.current = series
    pins.current = createSeriesMarkers(series)
    return () => {
      instance.remove()
      chart.current = null
      line.current = null
      pins.current = null
      average.current = null
    }
  }, [])

  useEffect(() => {
    const series = line.current
    if (!series) return

    // Точки строго по возрастанию и без повторов времени — требование
    // библиотеки, иначе данные молча не принимаются.
    const data = points
      .map((point) => ({ time: seconds(point.quotedAt), value: Number(point.price) }))
      .toSorted((a, b) => a.time - b.time)
      .filter((point, i, all) => i === 0 || point.time !== all[i - 1]?.time)
    series.setData(data)

    const times = data.map((point) => point.time)
    const placed: SeriesMarker<UTCTimestamp>[] = []
    let lost = 0

    for (const marker of markers) {
      const time = snap(times, seconds(marker.at))
      if (time === null) {
        lost += 1
        continue
      }
      placed.push({
        time,
        position:
          marker.kind === 'decision' ? 'inBar' : marker.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: marker.kind === 'decision' ? INK : marker.side === 'buy' ? GAIN : LOSS,
        shape:
          marker.kind === 'decision' ? 'circle' : marker.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: marker.text,
      })
    }
    pins.current?.setMarkers(placed.toSorted((a, b) => a.time - b.time))
    setHidden(lost)

    if (average.current) {
      series.removePriceLine(average.current)
      average.current = null
    }
    if (averagePrice) {
      average.current = series.createPriceLine({
        price: Number(averagePrice),
        color: RULE,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'средняя',
      })
    }
    chart.current?.timeScale().fitContent()
  }, [points, markers, averagePrice])

  return (
    <>
      <div ref={box} className="mt-6 h-80 w-full" />
      {hidden > 0 ? (
        <p className="mt-2 text-xs text-ink-muted">
          Отметок вне истории цен: {hidden} — на графике их нет.
        </p>
      ) : null}
    </>
  )
}
