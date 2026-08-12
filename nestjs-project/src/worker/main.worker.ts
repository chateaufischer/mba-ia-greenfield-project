import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import queueConfig from '../config/queue.config';
import { VIDEO_QUEUE_OPTIONS } from '../videos/queue/video-queue.constants';
import { VideoQueueTopology } from '../videos/queue/video-queue.topology';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint do container `video-worker` (phase-03-videos/TD-04): um
 * microservice RMQ puro, sem listener HTTP.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('VideoWorker');
  const config = queueConfig();

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    WorkerModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [config.url],
        queue: config.videoQueue,
        // Precisa ser idêntico ao do produtor, senão o broker derruba o canal
        // com PRECONDITION_FAILED.
        queueOptions: { ...VIDEO_QUEUE_OPTIONS },
        // Ack manual: a política de retry do TD-08 depende de decidir o
        // destino da mensagem depois de processar.
        noAck: false,
        prefetchCount: 1,
      },
    },
  );

  // As filas de retry/DLQ não são declaradas pelo transporte do Nest.
  await app.get(VideoQueueTopology).assert();

  app.enableShutdownHooks();
  await app.listen();
  logger.log(`Video worker listening on queue "${config.videoQueue}"`);
}

void bootstrap();
