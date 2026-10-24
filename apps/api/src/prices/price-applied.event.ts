import type { PriceQuoted } from '@thesis/contracts'

// Событие внутри процесса, не в брокере: цена уже записана и уже разослана
// Kafka, а здесь нужно другое — сказать шлюзу, что проекция изменилась.
// Прямой вызов шлюза из консьюмера связал бы запись с доставкой: тест
// консьюмера потянул бы за собой сокеты.
export const PRICE_APPLIED = 'price.applied'

export type PriceApplied = PriceQuoted
