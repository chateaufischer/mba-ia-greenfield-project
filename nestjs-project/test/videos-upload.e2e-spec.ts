import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import queueConfig from '../src/config/queue.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoQueueTopology } from '../src/videos/queue/video-queue.topology';
import { VideoStatus } from '../src/videos/video-status.enum';

const PART_SIZE = 8 * 1024 * 1024;

/**
 * Ciclo de upload ponta a ponta contra MinIO e RabbitMQ reais
 * (phase-03-videos/TD-11). O ponto central que este teste prova é o do TD-03:
 * os bytes vão do cliente direto ao storage por URL pré-assinada, e a API só
 * intermedia o handshake.
 */
describe('Videos — upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let topology: VideoQueueTopology;
  let connection: ChannelModel;
  let amqpChannel: Channel;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    topology = moduleFixture.get(VideoQueueTopology);
    await topology.assert();
    connection = await connect(queueConfig().url);
    amqpChannel = await connection.createChannel();
  });

  afterAll(async () => {
    await amqpChannel.close();
    await connection.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await amqpChannel.purgeQueue(topology.mainQueue);
  });

  let userCounter = 0;

  async function loginAsChannelOwner(): Promise<string> {
    const email = `uploader_${++userCounter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailService = (
      authService as unknown as {
        mailService: {
          sendConfirmationEmail: (
            email: string,
            nickname: string,
            token: string,
          ) => Promise<void>;
        };
      }
    ).mailService;

    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_email, _nickname, token) => {
        confirmationToken = token;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return login.body.access_token as string;
  }

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    title: 'Minha gravação',
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 4096,
    ...overrides,
  });

  async function createDraft(
    token: string,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(overrides));
    expect(response.status).toBe(201);
    return response.body;
  }

  describe('POST /videos', () => {
    it('should pre-register the video as a draft and open the upload', async () => {
      const token = await loginAsChannelOwner();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody({ size_bytes: PART_SIZE * 3 }));

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('draft');
      expect(response.body.public_id).toHaveLength(11);
      expect(response.body.upload).toEqual({
        upload_id: expect.any(String),
        part_size_bytes: PART_SIZE,
        total_parts: 3,
      });

      const persisted = await videoRepository.findOneByOrFail({
        id: response.body.id,
      });
      expect(persisted.status).toBe(VideoStatus.DRAFT);
      expect(persisted.source_key).toBe(
        `videos/${response.body.id}/source.mp4`,
      );
    });

    it('should reject an upload above the size limit with 413', async () => {
      const token = await loginAsChannelOwner();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody({ size_bytes: 10 * 1024 * 1024 * 1024 + 1 }));

      expect(response.status).toBe(413);
      expect(response.body.error).toBe('UPLOAD_TOO_LARGE');
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('should reject a non-video content type with 415', async () => {
      const token = await loginAsChannelOwner();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody({ content_type: 'application/pdf' }));

      expect(response.status).toBe(415);
      expect(response.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('should reject an anonymous request with 401', async () => {
      const response = await request(app.getHttpServer())
        .post('/videos')
        .send(validBody());

      expect(response.status).toBe(401);
    });

    it('should reject an invalid body with 400 and field errors', async () => {
      const token = await loginAsChannelOwner();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'x' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect(Array.isArray(response.body.message)).toBe(true);
    });

    it('should generate a distinct public_id per video', async () => {
      const token = await loginAsChannelOwner();

      const first = await createDraft(token);
      const second = await createDraft(token);

      expect(first.public_id).not.toBe(second.public_id);
    });
  });

  describe('POST /videos/:id/upload/parts', () => {
    it('should issue a presigned URL that accepts a direct PUT to storage', async () => {
      const token = await loginAsChannelOwner();
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] });

      expect(response.status).toBe(200);
      expect(response.body.parts).toHaveLength(1);

      const put = await fetch(response.body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(1024, 7)),
      });
      expect(put.status).toBe(200);
    });

    it('should reject a part number beyond the declared total with 400', async () => {
      const token = await loginAsChannelOwner();
      const draft = await createDraft(token, { size_bytes: 4096 });

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [2] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_UPLOAD_PARTS');
    });

    it('should reject a video owned by another channel with 403', async () => {
      const owner = await loginAsChannelOwner();
      const intruder = await loginAsChannelOwner();
      const draft = await createDraft(owner);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/parts`)
        .set('Authorization', `Bearer ${intruder}`)
        .send({ part_numbers: [1] });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('VIDEO_NOT_OWNED');
    });
  });

  describe('POST /videos/:id/upload/complete', () => {
    async function uploadSinglePart(
      token: string,
      draft: { id: string },
      body: Buffer,
    ): Promise<{ part_number: number; etag: string }> {
      const parts = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] });

      const put = await fetch(parts.body.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(put.status).toBe(200);

      return { part_number: 1, etag: put.headers.get('etag') as string };
    }

    it('should complete the upload, flip to processing and enqueue exactly one job', async () => {
      const token = await loginAsChannelOwner();
      const draft = await createDraft(token);
      const body = Buffer.alloc(4096, 1);
      const part = await uploadSinglePart(token, draft, body);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('processing');

      const persisted = await videoRepository.findOneByOrFail({ id: draft.id });
      expect(persisted.status).toBe(VideoStatus.PROCESSING);
      expect(persisted.source_size_bytes).toBe(body.length);
      expect(persisted.upload_id).toBeNull();

      const queueStatus = await amqpChannel.checkQueue(topology.mainQueue);
      expect(queueStatus.messageCount).toBe(1);
    });

    it('should be idempotent: a repeated complete enqueues no second job', async () => {
      const token = await loginAsChannelOwner();
      const draft = await createDraft(token);
      const part = await uploadSinglePart(token, draft, Buffer.alloc(4096, 2));

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] });

      const second = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] });

      // O segundo complete não encontra upload aberto — o rascunho já saiu de
      // draft e o upload_id foi zerado na transição.
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('UPLOAD_NOT_OPEN');

      const queueStatus = await amqpChannel.checkQueue(topology.mainQueue);
      expect(queueStatus.messageCount).toBe(1);
    });

    it('should reject an empty parts list with 400', async () => {
      const token = await loginAsChannelOwner();
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should reject a bogus etag with 400 INVALID_UPLOAD_PARTS', async () => {
      const token = await loginAsChannelOwner();
      const draft = await createDraft(token);
      await uploadSinglePart(token, draft, Buffer.alloc(4096, 3));

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: '"not-the-real-etag"' }] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_UPLOAD_PARTS');
    });
  });

  describe('DELETE /videos/:id/upload', () => {
    it('should abort the upload and drop the draft', async () => {
      const token = await loginAsChannelOwner();
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .delete(`/videos/${draft.id}/upload`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(204);
      await expect(
        videoRepository.findOneBy({ id: draft.id }),
      ).resolves.toBeNull();
    });

    it('should return 404 for a video that does not exist', async () => {
      const token = await loginAsChannelOwner();

      const response = await request(app.getHttpServer())
        .delete('/videos/11111111-2222-3333-4444-555555555555/upload')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
