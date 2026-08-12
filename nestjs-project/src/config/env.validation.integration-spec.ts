import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'storage-key',
  STORAGE_SECRET_KEY: 'storage-secret',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage (phase-03-videos/TD-01)', () => {
  it('should reject a missing STORAGE_ACCESS_KEY', () => {
    const { STORAGE_ACCESS_KEY: _omitted, ...withoutKey } = requiredEnv;
    const { error } = envValidationSchema.validate(withoutKey, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should reject a non-URI STORAGE_PUBLIC_ENDPOINT', () => {
    const { error } = validate({ STORAGE_PUBLIC_ENDPOINT: 'minio:9000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_PUBLIC_ENDPOINT');
  });

  it('should reject a part size below the 5MiB S3 minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1024' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should apply storage defaults when only the credentials are provided', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('minio');
    expect(value.STORAGE_PORT).toBe(9000);
    expect(value.STORAGE_BUCKET).toBe('streamtube-media');
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://minio:9000');
  });

  it('should coerce UPLOAD_MAX_BYTES from string to number', () => {
    const { value, error } = validate({ UPLOAD_MAX_BYTES: '10737418240' });
    expect(error).toBeUndefined();
    expect(value.UPLOAD_MAX_BYTES).toBe(10737418240);
  });
});

describe('envValidationSchema — queue (phase-03-videos/TD-02)', () => {
  it('should reject a missing RABBITMQ_URL', () => {
    const { RABBITMQ_URL: _omitted, ...withoutUrl } = requiredEnv;
    const { error } = envValidationSchema.validate(withoutUrl, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('RABBITMQ_URL');
  });

  it('should reject VIDEO_JOB_MAX_ATTEMPTS below 1', () => {
    const { error } = validate({ VIDEO_JOB_MAX_ATTEMPTS: '0' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_JOB_MAX_ATTEMPTS');
  });

  it('should apply queue defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.VIDEO_QUEUE_NAME).toBe('video.processing');
    expect(value.VIDEO_JOB_MAX_ATTEMPTS).toBe(3);
  });
});
