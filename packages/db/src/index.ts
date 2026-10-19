// Клиент Prisma 7 генерируется в каталог из схемы, а не в node_modules.
export { Prisma, PrismaClient } from '../generated/prisma/client.ts'
// Адаптер реэкспортируем отсюда: драйвер — дело этого пакета, а не потребителей.
export { PrismaPg } from '@prisma/adapter-pg'
