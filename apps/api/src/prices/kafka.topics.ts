import { Logger } from '@nestjs/common'
import { KafkaJS } from '@confluentinc/kafka-javascript'

const { Kafka } = KafkaJS
const log = new Logger('KafkaTopics')

// Шесть партиций, как у брокера по умолчанию: порядок внутри тикера держит
// ключ сообщения, а не единственная партиция.
const PARTITIONS = 6

// Топик создаётся явно, а не автосозданием брокера. Причина выяснилась на
// живом стенде: консьюмер, подписавшийся на несуществующий топик, получает
// «Unknown topic or partition» и после его появления сам не оживает — сообщения
// просто не читаются. В проде автосоздание к тому же обычно выключено.
export async function ensureTopics(brokers: string, topics: string[]): Promise<void> {
  const admin = new Kafka().admin({ 'bootstrap.servers': brokers })
  await admin.connect()
  try {
    await admin.createTopics({
      topics: topics.map((topic) => ({
        topic,
        numPartitions: PARTITIONS,
        replicationFactor: 1,
      })),
    })
  } catch (error) {
    // Топик уже есть — это норма, а не ошибка: создание идемпотентно по смыслу.
    log.debug(`топики уже существуют (${String(error)})`)
  } finally {
    await admin.disconnect()
  }
}
