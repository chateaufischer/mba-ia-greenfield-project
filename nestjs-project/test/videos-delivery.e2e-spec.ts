import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageModule } from '../src/storage/storage.module';
import { StorageService } from '../src/storage/storage.service';
import { sourceKey, thumbnailKey } from '../src/storage/storage.keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingService } from '../src/worker/video-processing.service';
import { FfmpegService } from '../src/videos/processing/ffmpeg.service';
import { generatePublicId } from '../src/videos/public-id.util';
import { VideoStatus } from '../src/videos/video-status.enum';

/**
 * Entrega ponta a ponta (phase-03-videos/TD-09 + TD-10).
 *
 * O ponto que este arquivo prova: a API responde `302` e é o **storage** que
 * serve `206 Partial Content` sob `Range` — reprodução começa sem download
 * completo e nenhum byte de vídeo atravessa o processo Node.
 */
describe('Videos — delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let processing: VideoProcessingService;

  const workdir = path.join(os.tmpdir(), `delivery-e2e-${randomUUID()}`);
  const uploadedKeys: string[] = [];
  let sampleBytes: Buffer;

  const generateSample = (output: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=3:size=320x240:rate=15',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        output,
      ]);
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
    });

  beforeAll(async () => {
    await fs.mkdir(workdir, { recursive: true });
    const samplePath = path.join(workdir, 'sample.mp4');
    await generateSample(samplePath);
    sampleBytes = await fs.readFile(samplePath);

    // O worker roda em outro processo; para o teste de entrega precisamos de um
    // vídeo já processado, então o serviço de processamento é montado aqui
    // sobre a mesma conexão e o mesmo storage da aplicação.
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, TypeOrmModule.forFeature([Video]), StorageModule],
      providers: [VideoProcessingService, FfmpegService],
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
    storage = moduleFixture.get(StorageService);
    processing = moduleFixture.get(VideoProcessingService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 90_000);

  afterAll(async () => {
    await Promise.all(
      uploadedKeys.map((key) =>
        storage.removeObject(key).catch(() => undefined),
      ),
    );
    await fs.rm(workdir, { recursive: true, force: true });
    await app.close();
  });

  let counter = 0;
  let ownerToken: string;
  let channelId: string;

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    ownerToken = await registerOwner();
  });

  async function registerOwner(): Promise<string> {
    const email = `viewer_${++counter}@example.com`;
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

    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ nickname: email.split('@')[0] });
    channelId = channel.id;

    return login.body.access_token as string;
  }

  /** Cria um vídeo já processado, passando pelo worker real. */
  async function seedReadyVideo(): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        title: 'Ação: minha gravação!',
        status: VideoStatus.PROCESSING,
        source_content_type: 'video/mp4',
        source_key: 'placeholder',
        source_size_bytes: sampleBytes.length,
      }),
    );

    const key = sourceKey(video.id, 'sample.mp4');
    await storage.putObject(key, sampleBytes, 'video/mp4');
    uploadedKeys.push(key, thumbnailKey(video.id));
    await videoRepository.update({ id: video.id }, { source_key: key });

    await processing.process(video.id, 1);
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  async function seedProcessingVideo(): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        title: 'Ainda processando',
        status: VideoStatus.PROCESSING,
        source_content_type: 'video/mp4',
        source_key: 'videos/none/source.mp4',
      }),
    );
  }

  describe('GET /videos/:public_id', () => {
    it('should expose a ready video to an anonymous visitor', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        public_id: video.public_id,
        status: 'ready',
        stream_url: `/videos/${video.public_id}/stream`,
        download_url: `/videos/${video.public_id}/download`,
      });
      expect(response.body.duration_seconds).toBeCloseTo(3, 0);
      expect(response.body.metadata).toMatchObject({ width: 320, height: 240 });
      expect(response.body.thumbnail_url).toEqual(expect.any(String));
    }, 60_000);

    it('should serve the thumbnail URL it advertises', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );
      const thumbnail = await fetch(response.body.thumbnail_url as string);
      const bytes = Buffer.from(await thumbnail.arrayBuffer());

      expect(thumbnail.status).toBe(200);
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    }, 60_000);

    it('should hide a video that is still processing from anonymous visitors', async () => {
      const video = await seedProcessingVideo();

      const response = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should show the processing video to the channel owner', async () => {
      const video = await seedProcessingVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('processing');
      expect(response.body).toHaveProperty('processing_error');
    });

    it('should return 404 for an unknown public id', async () => {
      const response = await request(app.getHttpServer()).get(
        '/videos/doesnotexi',
      );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:public_id/stream', () => {
    it('should redirect with 302 instead of piping bytes through the API', async () => {
      const video = await seedReadyVideo();

      const response = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/stream`,
      );

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain(video.source_key);
      // O corpo do 302 não carrega o vídeo.
      expect(Number(response.headers['content-length'] ?? 0)).toBeLessThan(
        sampleBytes.length,
      );
    }, 60_000);

    it('should let the redirect target answer a Range request with 206', async () => {
      const video = await seedReadyVideo();

      const redirect = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/stream`,
      );
      const ranged = await fetch(redirect.headers.location, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${sampleBytes.length}`,
      );
      expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
    }, 60_000);

    it('should let the redirect target serve the whole file too', async () => {
      const video = await seedReadyVideo();

      const redirect = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/stream`,
      );
      const full = await fetch(redirect.headers.location);

      expect(full.status).toBe(200);
      expect(full.headers.get('accept-ranges')).toBe('bytes');
      expect((await full.arrayBuffer()).byteLength).toBe(sampleBytes.length);
    }, 60_000);

    it('should return 409 when the owner asks for a video still processing', async () => {
      const video = await seedProcessingVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('VIDEO_NOT_READY');
    });

    it('should return 404 for an anonymous visitor on a processing video', async () => {
      const video = await seedProcessingVideo();

      const response = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/stream`,
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /videos/:public_id/download', () => {
    it('should redirect to a URL that forces an attachment download', async () => {
      const video = await seedReadyVideo();

      const redirect = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/download`,
      );
      expect(redirect.status).toBe(302);

      const download = await fetch(redirect.headers.location);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toBe(
        'attachment; filename="Acao-minha-gravacao.mp4"',
      );
      expect((await download.arrayBuffer()).byteLength).toBe(
        sampleBytes.length,
      );
    }, 60_000);

    it('should return 404 for an unknown public id', async () => {
      const response = await request(app.getHttpServer()).get(
        '/videos/doesnotexi/download',
      );

      expect(response.status).toBe(404);
    });
  });
});
