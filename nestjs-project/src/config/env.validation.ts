import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Object storage (MinIO / S3-compatible) — phase-03-videos/TD-01
  STORAGE_ENDPOINT: Joi.string().default('minio'),
  STORAGE_PORT: Joi.number().port().default(9000),
  STORAGE_USE_SSL: Joi.string().valid('true', 'false').default('false'),
  STORAGE_ACCESS_KEY: Joi.string().required(),
  STORAGE_SECRET_KEY: Joi.string().required(),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_BUCKET: Joi.string().default('streamtube-media'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://minio:9000'),

  // Upload handshake — phase-03-videos/TD-03
  UPLOAD_MAX_BYTES: Joi.number()
    .integer()
    .positive()
    .default(10 * 1024 * 1024 * 1024),
  UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  UPLOAD_URL_EXPIRATION_SECONDS: Joi.number().integer().positive().default(3600),
  DELIVERY_URL_EXPIRATION_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(3600),

  // Processing queue (RabbitMQ) — phase-03-videos/TD-02
  RABBITMQ_URL: Joi.string().required(),
  VIDEO_QUEUE_NAME: Joi.string().default('video.processing'),
  VIDEO_JOB_MAX_ATTEMPTS: Joi.number().integer().min(1).default(3),
  VIDEO_JOB_RETRY_DELAY_MS: Joi.number().integer().min(0).default(5000),
});
