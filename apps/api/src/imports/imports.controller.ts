import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiConsumes, ApiOperation } from '@nestjs/swagger'
import type { Response } from 'express'
import { z } from 'zod'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { ApplyImportService } from './apply-import.service.ts'
import type { ImportResult } from './apply-import.service.ts'
import { RawImportService } from './raw-import.service.ts'
import type { UploadResult } from './raw-import.service.ts'

// Десять мегабайт: брокерский отчёт за год укладывается с запасом, а без
// границы загрузка становится способом занять диск.
const MAX_BYTES = 10 * 1024 * 1024

@Controller('imports')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class ImportsController {
  constructor(
    private readonly imports: RawImportService,
    private readonly apply: ApplyImportService,
  ) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Залить отчёт. Повтор того же содержимого отдаёт 200' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body('accountId', { schema: z.uuid() }) accountId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UploadResult> {
    if (!file) throw new BadRequestException('file is required')

    const result = await this.imports.upload(user.userId, accountId, file.buffer, file.originalname)
    // 201 только на настоящую запись. Дубль — это не создание, а указание на
    // уже существующий импорт, и честный код для него 200.
    response.status(result.status === 'duplicate' ? 200 : 201)
    return result
  }

  // Отдельный список, а не часть ответа на применение: про отложенное надо
  // помнить и после того, как человек ушёл с экрана.
  @Get('deferred')
  @ApiOperation({ summary: 'Операции, ждущие покупок: продажи без лотов' })
  deferred(@CurrentUser() user: AuthenticatedUser) {
    return this.apply.pending(user.userId)
  }

  // Применение отдельным запросом, а не внутри заливки: сохранённый отчёт
  // переживает неудачный разбор, и повторить применение можно, не загружая
  // файл второй раз. Отказы здесь свои: 409 — отчёт по этому счёту уже
  // применяется, 400 — в отчёте есть продажи без покупок.
  @Post(':id/apply')
  // 200, а не дефолтный для POST 201: по этому адресу ничего не создаётся,
  // применение меняет состояние уже существующего импорта.
  @HttpCode(200)
  @ApiOperation({ summary: 'Применить залитый отчёт: сделки, лоты, позиции, деньги' })
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: z.uuid() }) id: string,
  ): Promise<ImportResult> {
    return this.apply.run(user.userId, id)
  }
}
