import { Decimal } from 'decimal.js'

// An isolated constructor rather than Decimal.set: the configuration stays
// inside Money. Decimal.set mutates the library globally, so any other code in
// the process would inherit our precision, and its own Decimal.set would break
// our toString().
const D = Decimal.clone({ precision: 40, toExpNeg: -30, toExpPos: 40 })

export class Money {
  readonly #value: Decimal

  private constructor(value: Decimal) {
    this.#value = value
  }

  static of(value: string | Money): Money {
    if (typeof value !== 'string' && !(value instanceof Money)) {
      throw new TypeError('number is not allowed for money, use string')
    }
    return value instanceof Money ? value : new Money(new D(value))
  }

  plus(x: string | Money): Money {
    return new Money(this.#value.plus(Money.of(x).#value))
  }
  minus(x: string | Money): Money {
    return new Money(this.#value.minus(Money.of(x).#value))
  }
  times(x: string | Money): Money {
    return new Money(this.#value.times(Money.of(x).#value))
  }
  // Единственная операция, результат которой может не поместиться: 10/3
  // бесконечно. Масштаб задаётся явно, по умолчанию 8 знаков — как numeric(28,8)
  // в базе. Округление банковское: HALF_UP систематически завышает.
  div(x: string | Money, scale = 8): Money {
    const divisor = Money.of(x).#value
    if (divisor.isZero()) throw new RangeError('division by zero')
    return new Money(this.#value.div(divisor).toDecimalPlaces(scale, D.ROUND_HALF_EVEN))
  }
  eq(x: string | Money): boolean {
    return this.#value.eq(Money.of(x).#value)
  }
  lt(x: string | Money): boolean {
    return this.#value.lt(Money.of(x).#value)
  }
  gte(x: string | Money): boolean {
    return this.#value.gte(Money.of(x).#value)
  }
  isNegative(): boolean {
    return this.#value.isNegative()
  }
  toString(): string {
    return this.#value.toFixed()
  }
}
