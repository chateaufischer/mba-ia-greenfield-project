import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { sourceKey, thumbnailKey } from '../storage/storage.keys';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from '../videos/processing/ffmpeg.service';
import { generatePublicId } from '../videos/public-id.util';
import { VideoStatus } from '../videos/video-status.enum';
import { VideoProcessingService } from './video-processing.service';

const ENTITIES = [User, Channel, Video];

/**
 * O caminho completo do worker com as três infraestruturas reais
 * (phase-03-videos/TD-11): o objeto vem do MinIO por URL pré-assinada, o
 * FFmpeg real lê e extrai o frame, e o resultado é persistido no Postgres.
 */
describe('VideoProcessingService (integration — MinIO + FFmpeg reais)', () => {
  let moduleRef: TestingModule;
  let service: VideoProcessingService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  const uploadedKeys: string[] = [];
  const workdir = path.join(os.tmpdir(), `worker-it-${randomUUID()}`);
  let sampleBytes: Buffer;

  const generateSample = (output: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=4:size=640x360:rate=15',
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

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'db',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_NAME ?? 'streamtube',
          entities: ENTITIES,
          synchronize: false,
        }),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessingService, FfmpegService],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(VideoProcessingService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleRef.get(StorageService);
  }, 90_000);

  afterAll(async () => {
    await Promise.all(
      uploadedKeys.map((key) =>
        storage.removeObject(key).catch(() => undefined),
      ),
    );
    await fs.rm(workdir, { recursive: true, force: true });
    await moduleRef.close();
  });

  let counter = 0;
  let channelId: string;

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `worker_${++counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Worker',
      nickname: `worker${counter}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  async function seedProcessingVideo(content: Buffer): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channelId,
        title: 'Processável',
        status: VideoStatus.PROCESSING,
        source_content_type: 'video/mp4',
        source_key: 'placeholder',
        source_size_bytes: content.length,
      }),
    );

    const key = sourceKey(video.id, 'sample.mp4');
    await storage.putObject(key, content, 'video/mp4');
    uploadedKeys.push(key, thumbnailKey(video.id));

    await videoRepository.update({ id: video.id }, { source_key: key });
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  it('should take a processing video all the way to ready', async () => {
    const video = await seedProcessingVideo(sampleBytes);

    const outcome = await service.process(video.id, 1);

    expect(outcome).toEqual({ kind: 'processed' });

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeCloseTo(4, 0);
    expect(processed.metadata).toEqual(
      expect.objectContaining({ width: 640, height: 360, video_codec: 'h264' }),
    );
    expect(processed.thumbnail_key).toBe(thumbnailKey(video.id));
    expect(processed.processing_error).toBeNull();
  }, 60_000);

  it('should store a real JPEG thumbnail in the object storage', async () => {
    const video = await seedProcessingVideo(sampleBytes);

    await service.process(video.id, 1);

    const key = thumbnailKey(video.id);
    const stat = await storage.statObject(key);
    expect(stat.size).toBeGreaterThan(0);

    const url = await storage.presignGetUrl(key, 60);
    const response = await fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  }, 60_000);

  it('should retry instead of failing while attempts remain', async () => {
    const video = await seedProcessingVideo(
      Buffer.from('definitely not a video'),
    );

    const outcome = await service.process(video.id, 1);

    expect(outcome.kind).toBe('retry');
    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
    expect(stored.processing_attempts).toBe(1);
  }, 60_000);

  it('should mark the video failed with the ffmpeg error on the last attempt', async () => {
    const video = await seedProcessingVideo(
      Buffer.from('definitely not a video'),
    );

    const outcome = await service.process(
      video.id,
      queueConfig().jobMaxAttempts,
    );

    expect(outcome.kind).toBe('failed');
    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.FAILED);
    expect(stored.processing_error).toBeTruthy();
    expect(stored.thumbnail_key).toBeNull();
  }, 60_000);

  it('should ignore a duplicated delivery for an already ready video', async () => {
    const video = await seedProcessingVideo(sampleBytes);
    await service.process(video.id, 1);
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    const outcome = await service.process(video.id, 1);

    expect(outcome.kind).toBe('skipped');
    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.updated_at).toEqual(first.updated_at);
  }, 60_000);
});
