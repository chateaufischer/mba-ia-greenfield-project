import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const errorSchema = { schema: { $ref: getSchemaPath(ApiErrorEnvelope) } };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pré-cadastrar vídeo e abrir o upload',
    description:
      'Cria o vídeo como rascunho e abre um multipart upload no object storage. Nenhum byte do arquivo passa pela API: o cliente envia as partes direto ao storage com as URLs pré-assinadas emitidas em POST /videos/:id/upload/parts.',
  })
  @ApiResponse({
    status: 201,
    description: 'Rascunho criado e upload aberto',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        upload: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            part_size_bytes: { type: 'number' },
            total_parts: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    ...errorSchema,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 404,
    description: 'User has no channel',
    ...errorSchema,
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the size limit',
    ...errorSchema,
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not a video',
    ...errorSchema,
  })
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVideoDto) {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Emitir URLs pré-assinadas para um lote de partes',
    description:
      'Devolve uma URL PUT pré-assinada por parte solicitada. O cliente envia cada parte direto ao storage e guarda o ETag devolvido.',
  })
  @ApiResponse({
    status: 200,
    description: 'URLs emitidas',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'number' },
              url: { type: 'string' },
              expires_in: { type: 'number' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid part numbers',
    ...errorSchema,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    ...errorSchema,
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...errorSchema })
  @ApiResponse({
    status: 409,
    description: 'No open upload for this video',
    ...errorSchema,
  })
  async issueParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadPartsDto,
  ) {
    return this.videosService.issuePartUrls(user.sub, id, dto.part_numbers);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Concluir o upload e enfileirar o processamento',
    description:
      'Consolida as partes no storage, transiciona o vídeo de rascunho para processando e publica o job de processamento. Reenviar a mesma conclusão é idempotente: o job só é publicado quando a transição de status realmente acontece.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload concluído; processamento enfileirado',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid parts', ...errorSchema })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    ...errorSchema,
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...errorSchema })
  @ApiResponse({
    status: 409,
    description: 'No open upload for this video',
    ...errorSchema,
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Public()
  @Get(':public_id')
  @ApiOperation({
    summary: 'Consultar o vídeo pela URL única',
    description:
      'Devolve os metadados públicos do vídeo. Vídeos que ainda não estão prontos respondem 404 para qualquer um, exceto para o dono do canal — que enxerga o status e o erro de processamento.',
  })
  @ApiResponse({
    status: 200,
    description: 'Metadados do vídeo',
    type: VideoResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...errorSchema })
  async findOne(
    @Param('public_id') publicId: string,
    @CurrentUser() user?: JwtPayload,
  ): Promise<VideoResponseDto> {
    const { video, isOwner } = await this.videosService.findByPublicId(
      publicId,
      user?.sub,
    );
    return this.videosService.toResponse(video, isOwner);
  }

  @Public()
  @Get(':public_id/stream')
  @ApiOperation({
    summary: 'Reproduzir o vídeo',
    description:
      'Responde 302 apontando para uma URL pré-assinada de vida curta. O storage serve a URL com Accept-Ranges e responde 206 Partial Content a requisições Range — a reprodução começa sem download completo e nenhum byte de vídeo atravessa a API.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redireciona para a URL de reprodução',
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...errorSchema })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    ...errorSchema,
  })
  async stream(
    @Param('public_id') publicId: string,
    @Res() response: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<void> {
    const url = await this.videosService.getStreamUrl(publicId, user?.sub);
    response.redirect(HttpStatus.FOUND, url);
  }

  @Public()
  @Get(':public_id/download')
  @ApiOperation({
    summary: 'Baixar o vídeo',
    description:
      'Responde 302 para uma URL pré-assinada gerada com Content-Disposition: attachment assinado, de modo que o download completo é servido pelo storage e não pela API.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redireciona para a URL de download',
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...errorSchema })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    ...errorSchema,
  })
  async download(
    @Param('public_id') publicId: string,
    @Res() response: Response,
    @CurrentUser() user?: JwtPayload,
  ): Promise<void> {
    const url = await this.videosService.getDownloadUrl(publicId, user?.sub);
    response.redirect(HttpStatus.FOUND, url);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abortar o upload em andamento',
    description:
      'Cancela o multipart no storage e descarta o rascunho, liberando as partes já enviadas.',
  })
  @ApiResponse({ status: 204, description: 'Upload abortado' })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    ...errorSchema,
  })
  @ApiResponse({ status: 404, description: 'Video not found', ...errorSchema })
  @ApiResponse({
    status: 409,
    description: 'No open upload for this video',
    ...errorSchema,
  })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id);
  }
}
