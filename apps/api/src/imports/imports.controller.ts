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
import { ImportsService } from './imports.service.ts'
import type { ImportStatus, UploadResult } from './imports.service.ts'

// Десять мегабайт: брокерский отчёт за год укладывается с запасом, а без
// границы загрузка становится способом занять диск.
const MAX_BYTES = 10 * 1024 * 1024

@Controller('imports')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
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
    //
    // Разбор к этому моменту ещё не случился: команда ушла воркеру, и экран
    // следит за статусом. Притворяться, что ответ окончательный, нельзя.
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

  // Разбор асинхронный, поэтому экрану нужен статус: uploaded → parsing →
  // parsed либо failed с причиной.
  @Get(':id')
  @ApiOperation({ summary: 'Статус импорта: разбирается, применён или отказал' })
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: z.uuid() }) id: string,
  ): Promise<ImportStatus> {
    return this.imports.status(user.userId, id)
  }

  // Отдельным запросом: сырьё переживает неудачный разбор, и повторить можно,
  // не загружая файл заново. Теперь это не «примени», а «разбери снова» —
  // байты лежат у воркера, и применение случится по событию.
  @Post(':id/apply')
  // 200, а не дефолтный для POST 201: по этому адресу ничего не создаётся,
  // меняется состояние уже существующего импорта.
  @HttpCode(200)
  @ApiOperation({ summary: 'Разобрать залитый отчёт заново' })
  reparse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: z.uuid() }) id: string,
  ): Promise<ImportStatus> {
    return this.imports.reparse(user.userId, id)
  }
}
