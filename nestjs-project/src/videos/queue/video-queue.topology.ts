import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { connect } from 'amqplib';
import queueConfig from '../../config/queue.config';
import {
  VIDEO_QUEUE_OPTIONS,
  deadLetterQueueName,
  retryQueueName,
} from './video-queue.constants';

/**
 * Declara a topologia de retentativa (phase-03-videos/TD-08).
 *
 * A fila de retry não tem consumidor: a mensagem expira por `x-message-ttl` e o
 * broker a encaminha, via dead-letter, de volta para a fila principal. É esse
 * mecanismo que substitui o backoff que o BullMQ daria pronto — e, por ser do
 * broker, o atraso sobrevive a restart do worker.
 */
@Injectable()
export class VideoQueueTopology {
  private readonly logger = new Logger(VideoQueueTopology.name);

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  get mainQueue(): string {
    return this.config.videoQueue;
  }

  get retryQueue(): string {
    return retryQueueName(this.config.videoQueue);
  }

  get deadLetterQueue(): string {
    return deadLetterQueueName(this.config.videoQueue);
  }

  /** Idempotente: `assertQueue` com os mesmos argumentos é um no-op. */
  async assert(): Promise<void> {
    const connection = await connect(this.config.url);
    try {
      const channel = await connection.createChannel();
      try {
        await channel.assertQueue(this.mainQueue, VIDEO_QUEUE_OPTIONS);
        await channel.assertQueue(this.retryQueue, {
          durable: true,
          arguments: {
            'x-message-ttl': this.config.jobRetryDelayMs,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': this.mainQueue,
          },
        });
        await channel.assertQueue(this.deadLetterQueue, { durable: true });
        this.logger.log(
          `Queue topology asserted: ${this.mainQueue}, ${this.retryQueue}, ${this.deadLetterQueue}`,
        );
      } finally {
        await channel.close();
      }
    } finally {
      await connection.close();
    }
  }
}
