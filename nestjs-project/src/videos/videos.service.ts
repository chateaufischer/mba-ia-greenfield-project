import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  PublicIdGenerationFailedException,
  UnsupportedMediaTypeException,
  UploadNotOpenException,
  UploadTooLargeException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { sourceKey } from '../storage/storage.keys';
import { CreateVideoDto } from './dto/create-video.dto';
import type { UploadedPartDto } from './dto/complete-upload.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoQueuePublisher } from './queue/video-queue.publisher';
import { VideoStatus } from './video-status.enum';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_MAX_RETRIES = 5;

export interface CreatedVideo {
  id: string;
  public_id: string;
  status: VideoStatus;
  upload: {
    upload_id: string;
    part_size_bytes: number;
    total_parts: number;
  };
}

function isPublicIdViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error as unknown as { code?: string; detail?: string };
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes('public_id')
  );
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly queue: VideoQueuePublisher,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pré-cadastra o vídeo como rascunho e abre o multipart upload
   * (phase-03-videos/TD-03 + TD-08). Nenhum byte passa por aqui: o cliente
   * envia as partes direto ao storage com as URLs pré-assinadas.
   */
  async createDraft(userId: string, dto: CreateVideoDto): Promise<CreatedVideo> {
    if (!dto.content_type.startsWith('video/')) {
      throw new UnsupportedMediaTypeException();
    }
    if (dto.size_bytes > this.config.uploadMaxBytes) {
      throw new UploadTooLargeException(this.config.uploadMaxBytes);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const video = await this.persistDraftWithUniquePublicId(
      channel.id,
      dto,
    );

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
      upload: {
        upload_id: video.upload_id as string,
        part_size_bytes: this.config.uploadPartSizeBytes,
        total_parts: this.totalParts(dto.size_bytes),
      },
    };
  }

  totalParts(sizeBytes: number): number {
    return Math.max(
      1,
      Math.ceil(sizeBytes / this.config.uploadPartSizeBytes),
    );
  }

  /**
   * Mesmo padrão de colisão usado para o nickname do canal na Fase 02:
   * tenta gravar e, na violação de unicidade, gera outro identificador.
   */
  private async persistDraftWithUniquePublicId(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_RETRIES; attempt++) {
      const publicId = generatePublicId();
      const draft = this.videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: dto.title,
        status: VideoStatus.DRAFT,
        source_content_type: dto.content_type,
        source_key: '',
        // Tamanho declarado pelo cliente: é o que permite validar o intervalo
        // de partes antes do upload. No `complete` ele é substituído pelo
        // tamanho real lido do storage.
        source_size_bytes: dto.size_bytes,
      });

      try {
        const saved = await this.videoRepository.save(draft);
        const key = sourceKey(saved.id, dto.filename);
        const uploadId = await this.storage.createMultipartUpload(
          key,
          dto.content_type,
        );
        saved.source_key = key;
        saved.upload_id = uploadId;
        return await this.videoRepository.save(saved);
      } catch (error) {
        if (!isPublicIdViolation(error)) throw error;
        this.logger.warn(
          `public_id collision on attempt ${attempt + 1}; regenerating`,
        );
      }
    }

    throw new PublicIdGenerationFailedException();
  }

  /** Emite URLs pré-assinadas para um lote de partes (phase-03-videos/TD-03). */
  async issuePartUrls(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<{ parts: Awaited<ReturnType<StorageService['presignPartUrls']>> }> {
    const video = await this.findOwnedVideo(userId, videoId);
    const uploadId = this.requireOpenUpload(video);

    const total =
      video.source_size_bytes === null
        ? null
        : this.totalParts(video.source_size_bytes);
    const outOfRange = partNumbers.filter(
      (part) => part < 1 || (total !== null && part > total),
    );
    if (outOfRange.length > 0) {
      throw new InvalidUploadPartsException(
        `part numbers out of range: ${outOfRange.join(', ')}`,
      );
    }

    const parts = await this.storage.presignPartUrls(
      video.source_key,
      uploadId,
      partNumbers,
    );
    return { parts };
  }

  /**
   * Fecha o multipart, transiciona `draft → processing` de forma condicional e
   * só então publica o job — a transição é o mecanismo de idempotência que
   * substitui o `jobId` do BullMQ (phase-03-videos/TD-08).
   */
  async completeUpload(
    userId: string,
    videoId: string,
    parts: UploadedPartDto[],
  ): Promise<{ id: string; public_id: string; status: VideoStatus }> {
    const video = await this.findOwnedVideo(userId, videoId);
    const uploadId = this.requireOpenUpload(video);
    this.assertPartsAreCoherent(parts);

    try {
      await this.storage.completeMultipartUpload(
        video.source_key,
        uploadId,
        parts.map((part) => ({
          part_number: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      throw new InvalidUploadPartsException(
        error instanceof Error ? error.message : 'rejected by storage',
      );
    }

    const stat = await this.storage.statObject(video.source_key);

    const transition = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        upload_id: null,
        source_size_bytes: stat.size,
      },
    );

    if (transition.affected === 1) {
      await this.queue.publishProcessJob(video.id);
    }

    return {
      id: video.id,
      public_id: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  /** Aborta o multipart e descarta o rascunho (phase-03-videos/TD-03). */
  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, videoId);
    const uploadId = this.requireOpenUpload(video);

    await this.storage.abortMultipartUpload(video.source_key, uploadId);
    await this.videoRepository.delete({ id: video.id });
  }

  private assertPartsAreCoherent(parts: UploadedPartDto[]): void {
    if (parts.length === 0) {
      throw new InvalidUploadPartsException('the list is empty');
    }

    const numbers = parts.map((part) => part.part_number);
    if (new Set(numbers).size !== numbers.length) {
      throw new InvalidUploadPartsException('duplicated part numbers');
    }
    if (numbers.some((number) => number < 1)) {
      throw new InvalidUploadPartsException('part numbers must start at 1');
    }
  }

  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();
    if (channel.id !== video.channel_id) throw new VideoNotOwnedException();

    return video;
  }

  private requireOpenUpload(video: Video): string {
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadNotOpenException();
    }
    return video.upload_id;
  }
}
