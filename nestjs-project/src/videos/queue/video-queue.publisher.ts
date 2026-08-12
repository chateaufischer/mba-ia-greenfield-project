import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import {
  VIDEO_PROCESS_PATTERN,
  VIDEO_QUEUE_CLIENT,
  type VideoProcessJob,
} from './video-queue.constants';

@Injectable()
export class VideoQueuePublisher implements OnApplicationShutdown {
  constructor(
    @Inject(VIDEO_QUEUE_CLIENT) private readonly client: ClientProxy,
  ) {}

  /**
   * `emit()` devolve um Observable frio: sem `lastValueFrom` nada é publicado.
   * É o erro silencioso mais comum do transporte RMQ do Nest.
   */
  async publishProcessJob(videoId: string, attempt = 1): Promise<void> {
    const job: VideoProcessJob = { video_id: videoId, attempt };
    await lastValueFrom(this.client.emit(VIDEO_PROCESS_PATTERN, job));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
