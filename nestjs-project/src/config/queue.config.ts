import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  url:
    process.env.RABBITMQ_URL ||
    'amqp://streamtube:streamtube@rabbitmq:5672',
  videoQueue: process.env.VIDEO_QUEUE_NAME || 'video.processing',
  jobMaxAttempts: parseInt(process.env.VIDEO_JOB_MAX_ATTEMPTS || '3', 10),
  jobRetryDelayMs: parseInt(process.env.VIDEO_JOB_RETRY_DELAY_MS || '5000', 10),
}));
