import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import queueConfig from '../../config/queue.config';
import {
  VIDEO_QUEUE_CLIENT,
  VIDEO_QUEUE_OPTIONS,
} from './video-queue.constants';
import { VideoQueuePublisher } from './video-queue.publisher';
import { VideoQueueTopology } from './video-queue.topology';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: VIDEO_QUEUE_CLIENT,
        inject: [queueConfig.KEY],
        useFactory: (config: ConfigType<typeof queueConfig>) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.url],
            queue: config.videoQueue,
            queueOptions: { ...VIDEO_QUEUE_OPTIONS },
            // Sem isto a mensagem não sobrevive a restart do broker, mesmo com
            // a fila durável.
            persistent: true,
          },
        }),
      },
    ]),
  ],
  providers: [VideoQueuePublisher, VideoQueueTopology],
  exports: [VideoQueuePublisher, VideoQueueTopology],
})
export class VideoQueueModule {}
