import { createChart, createSeriesMarkers, LineSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, SeriesMarker, UTCTimestamp } from 'lightweight-charts'
import { useEffect, useRef } from 'react'

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

// Время в библиотеке — секунды, не миллисекунды: на миллисекундах график молча
// уезжает в 56000 год.
function seconds(iso: string): UTCTimestamp {
  return Math.floor(Date.parse(iso) / 1000) as UTCTimestamp
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

  // График создаётся один раз и убирается в cleanup: пересоздавать его на каждый
  // рендер — верный способ получить утечку канвасов.
  useEffect(() => {
    if (!box.current) return
    const instance = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: INK, attributionLogo: false },
      grid: { horzLines: { color: RULE }, vertLines: { visible: false } },
      rightPriceScale: { borderColor: RULE },
      timeScale: { borderColor: RULE, timeVisible: true },
    })
    chart.current = instance
    line.current = instance.addSeries(LineSeries, { color: INK, lineWidth: 2 })
    return () => {
      instance.remove()
      chart.current = null
      line.current = null
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

    const seriesMarkers: SeriesMarker<UTCTimestamp>[] = markers.map((marker) => ({
      time: seconds(marker.at),
      position:
        marker.kind === 'decision' ? 'inBar' : marker.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: marker.kind === 'decision' ? INK : marker.side === 'buy' ? GAIN : LOSS,
      shape:
        marker.kind === 'decision' ? 'circle' : marker.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: marker.text,
    }))
    createSeriesMarkers(series, seriesMarkers)

    if (averagePrice) {
      series.createPriceLine({
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

  return <div ref={box} className="mt-6 h-80 w-full" />
}
