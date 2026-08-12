import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { connect, type Channel as AmqpChannel, type ChannelModel } from 'amqplib';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoQueueModule } from './queue/video-queue.module';
import { VideoQueueTopology } from './queue/video-queue.topology';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Contrato de banco + storage + fila do serviço, com as três infraestruturas
 * reais do Compose (phase-03-videos/TD-11). O e2e cobre o contrato HTTP; aqui
 * o alvo são as queries e os efeitos colaterais.
 */
describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storage: StorageService;
  let topology: VideoQueueTopology;
  let connection: ChannelModel;
  let amqpChannel: AmqpChannel;
  let userRepository: Repository<User>;

  beforeAll(async () => {
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
        ChannelsModule,
        StorageModule,
        VideoQueueModule,
      ],
      providers: [VideosService],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelsService = moduleRef.get(ChannelsService);
    storage = moduleRef.get(StorageService);

    topology = moduleRef.get(VideoQueueTopology);
    await topology.assert();
    connection = await connect(queueConfig().url);
    amqpChannel = await connection.createChannel();
  });

  afterAll(async () => {
    await amqpChannel.close();
    await connection.close();
    await moduleRef.close();
  });

  let counter = 0;
  let userId: string;
  let channelId: string;

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await amqpChannel.purgeQueue(topology.mainQueue);

    const user = await userRepository.save(
      userRepository.create({
        email: `vsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    userId = user.id;
    const channel = await channelsService.createChannel(
      user.id,
      `vsvc${counter}@example.com`,
    );
    channelId = channel.id;
  });

  const dto = {
    title: 'Integração',
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 4096,
  };

  it('should bind the draft to the channel of the authenticated user', async () => {
    const created = await service.createDraft(userId, dto);

    const persisted = await videoRepository.findOneByOrFail({
      id: created.id,
    });
    expect(persisted.channel_id).toBe(channelId);
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.upload_id).toBeTruthy();
    expect(persisted.source_key).toBe(`videos/${created.id}/source.mp4`);
  });

  it('should open a multipart upload that the storage recognises', async () => {
    const created = await service.createDraft(userId, dto);
    const { parts } = await service.issuePartUrls(userId, created.id, [1]);

    const response = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(1024, 9)),
    });

    expect(response.status).toBe(200);
    await storage.abortMultipartUpload(
      `videos/${created.id}/source.mp4`,
      created.upload.upload_id,
    );
  });

  it('should transition to processing and enqueue exactly one job', async () => {
    const created = await service.createDraft(userId, dto);
    const { parts } = await service.issuePartUrls(userId, created.id, [1]);
    const put = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(2048, 4)),
    });

    await service.completeUpload(userId, created.id, [
      { part_number: 1, etag: put.headers.get('etag') as string },
    ]);

    const persisted = await videoRepository.findOneByOrFail({
      id: created.id,
    });
    expect(persisted.status).toBe(VideoStatus.PROCESSING);
    expect(persisted.source_size_bytes).toBe(2048);
    expect(persisted.upload_id).toBeNull();

    const status = await amqpChannel.checkQueue(topology.mainQueue);
    expect(status.messageCount).toBe(1);
  });

  it('should not enqueue when the conditional transition finds no draft', async () => {
    const created = await service.createDraft(userId, dto);
    const { parts } = await service.issuePartUrls(userId, created.id, [1]);
    const put = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(1024, 5)),
    });
    const etag = put.headers.get('etag') as string;

    // Simula a corrida: alguém já moveu o vídeo para processing.
    await videoRepository.update(
      { id: created.id },
      { status: VideoStatus.PROCESSING },
    );
    await amqpChannel.purgeQueue(topology.mainQueue);

    await expect(
      service.completeUpload(userId, created.id, [
        { part_number: 1, etag },
      ]),
    ).rejects.toMatchObject({ errorCode: 'UPLOAD_NOT_OPEN' });

    const status = await amqpChannel.checkQueue(topology.mainQueue);
    expect(status.messageCount).toBe(0);
  });

  it('should remove the draft row when the upload is aborted', async () => {
    const created = await service.createDraft(userId, dto);

    await service.abortUpload(userId, created.id);

    await expect(
      videoRepository.findOneBy({ id: created.id }),
    ).resolves.toBeNull();
  });
});
