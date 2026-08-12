import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { thumbnailKey } from '../storage/storage.keys';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from '../videos/processing/ffmpeg.service';
import { VideoStatus } from '../videos/video-status.enum';

/** Resultado do processamento, do ponto de vista do handler da fila. */
export type ProcessingOutcome =
  | { kind: 'processed' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry'; nextAttempt: number; error: string }
  | { kind: 'failed'; error: string };

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Processa um vídeo em `processing`: lê metadados e extrai o thumbnail via
   * FFmpeg apontado para uma URL pré-assinada (phase-03-videos/TD-06), e
   * persiste o resultado.
   *
   * Idempotência sem `jobId` (phase-03-videos/TD-08): vídeo que não está em
   * `processing` é ignorado, então entrega duplicada não reprocessa.
   */
  async process(videoId: string, attempt: number): Promise<ProcessingOutcome> {
    const video = await this.videoRepository.findOneBy({ id: videoId });

    if (!video) {
      return { kind: 'skipped', reason: `video ${videoId} no longer exists` };
    }
    if (video.status !== VideoStatus.PROCESSING) {
      return {
        kind: 'skipped',
        reason: `video ${videoId} is ${video.status}, not processing`,
      };
    }

    try {
      const sourceUrl = await this.storage.presignInternalGetUrl(
        video.source_key,
        this.storageSettings.uploadUrlExpirationSeconds,
      );

      const metadata = await this.ffmpeg.probe(sourceUrl);
      const frameAt = this.ffmpeg.thumbnailTimestamp(metadata.duration_seconds);
      const thumbnail = await this.ffmpeg.extractThumbnail(sourceUrl, frameAt);

      const key = thumbnailKey(video.id);
      await this.storage.putObject(key, thumbnail, THUMBNAIL_CONTENT_TYPE);

      const { duration_seconds: duration, ...rest } = metadata;
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.READY,
          duration_seconds: duration,
          metadata: rest,
          thumbnail_key: key,
          processing_error: null,
          processing_attempts: attempt,
        },
      );

      this.logger.log(`Video ${video.id} is ready (attempt ${attempt})`);
      return { kind: 'processed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt < this.queue.jobMaxAttempts) {
        await this.videoRepository.update(
          { id: video.id },
          { processing_attempts: attempt },
        );
        this.logger.warn(
          `Video ${video.id} failed on attempt ${attempt}; scheduling retry`,
        );
        return { kind: 'retry', nextAttempt: attempt + 1, error: message };
      }

      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          processing_error: message,
          processing_attempts: attempt,
        },
      );
      this.logger.error(
        `Video ${video.id} failed permanently after ${attempt} attempts`,
      );
      return { kind: 'failed', error: message };
    }
  }
}
