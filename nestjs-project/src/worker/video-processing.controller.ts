import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import type { Channel, Message } from 'amqplib';
import {
  VIDEO_PROCESS_PATTERN,
  type VideoProcessJob,
  type VideoQueueEnvelope,
} from '../videos/queue/video-queue.constants';
import { VideoQueueTopology } from '../videos/queue/video-queue.topology';
import { VideoProcessingService } from './video-processing.service';

/**
 * Consumidor da fila de processamento (phase-03-videos/TD-04).
 *
 * `noAck: false` está ligado no bootstrap, então **todo** caminho de saída
 * precisa terminar em `ack`: uma exceção não tratada deixaria a mensagem em
 * unacked até o canal cair, e ela voltaria em loop.
 */
@Controller()
export class VideoProcessingController {
  private readonly logger = new Logger(VideoProcessingController.name);

  constructor(
    private readonly processing: VideoProcessingService,
    private readonly topology: VideoQueueTopology,
  ) {}

  @EventPattern(VIDEO_PROCESS_PATTERN)
  async handle(
    @Payload() job: VideoProcessJob,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    // `getChannelRef()` é tipado como `any` no @nestjs/microservices; tipar
    // localmente devolve a checagem do compilador.
    const channel = context.getChannelRef() as Channel;
    const message = context.getMessage() as Message;
    const attempt = job.attempt ?? 1;

    try {
      const outcome = await this.processing.process(job.video_id, attempt);

      if (outcome.kind === 'retry') {
        this.republishForRetry(channel, message, outcome.nextAttempt);
      } else if (outcome.kind === 'failed') {
        this.parkInDeadLetterQueue(channel, message);
      } else if (outcome.kind === 'skipped') {
        this.logger.log(`Skipped: ${outcome.reason}`);
      }
    } catch (error) {
      // Falha fora do serviço (ex.: banco fora do ar). Sem estado confiável
      // para decidir retry, a mensagem vai para a DLQ em vez de girar em loop.
      this.logger.error(
        `Unexpected failure handling video ${job.video_id}`,
        error instanceof Error ? error.stack : String(error),
      );
      this.parkInDeadLetterQueue(channel, message);
    } finally {
      channel.ack(message);
    }
  }

  /**
   * Publica o envelope com `attempt + 1` na fila de retry. O atraso é do
   * broker (`x-message-ttl` + dead-letter de volta para a fila principal), o
   * que faz o backoff sobreviver a restart do worker (phase-03-videos/TD-08).
   */
  private republishForRetry(
    channel: Channel,
    message: Message,
    nextAttempt: number,
  ): void {
    const envelope = JSON.parse(
      message.content.toString(),
    ) as VideoQueueEnvelope;
    envelope.data = { ...envelope.data, attempt: nextAttempt };

    channel.sendToQueue(
      this.topology.retryQueue,
      Buffer.from(JSON.stringify(envelope)),
      { persistent: true },
    );
  }

  private parkInDeadLetterQueue(channel: Channel, message: Message): void {
    channel.sendToQueue(this.topology.deadLetterQueue, message.content, {
      persistent: true,
    });
  }
}
