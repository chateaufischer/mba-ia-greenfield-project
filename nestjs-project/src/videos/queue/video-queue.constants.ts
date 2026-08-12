/**
 * Contrato de mensageria entre API e worker (phase-03-videos/TD-02).
 *
 * Produtor e consumidor asseguram a MESMA fila: se os argumentos divergirem, o
 * RabbitMQ derruba o canal com `PRECONDITION_FAILED`. Por isso as opções vivem
 * aqui e são importadas pelos dois lados, em vez de literais duplicados.
 */
export const VIDEO_QUEUE_CLIENT = 'VIDEO_QUEUE_CLIENT';

export const VIDEO_PROCESS_PATTERN = 'video.process';

export const VIDEO_QUEUE_OPTIONS = { durable: true } as const;

/** Sufixos derivados do nome da fila principal (`VIDEO_QUEUE_NAME`). */
export const RETRY_QUEUE_SUFFIX = '.retry';
export const DLQ_SUFFIX = '.dlq';

export function retryQueueName(mainQueue: string): string {
  return `${mainQueue}${RETRY_QUEUE_SUFFIX}`;
}

export function deadLetterQueueName(mainQueue: string): string {
  return `${mainQueue}${DLQ_SUFFIX}`;
}

/** Corpo do job publicado no pattern `video.process`. */
export interface VideoProcessJob {
  video_id: string;
  attempt: number;
}

/** Envelope que o transporte RMQ do Nest serializa na fila. */
export interface VideoQueueEnvelope {
  pattern: string;
  data: VideoProcessJob;
}
