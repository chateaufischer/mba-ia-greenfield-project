import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  let counter = 0;
  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: 'Owner',
        nickname: `owner${counter}`,
        user_id: user.id,
      }),
    );
  });

  const draft = (overrides: Partial<Video> = {}): Video =>
    videoRepository.create({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'Meu vídeo',
      source_key: 'videos/x/source.mp4',
      source_content_type: 'video/mp4',
      ...overrides,
    });

  it('should default status to draft and attempts to zero', async () => {
    const saved = await videoRepository.save(draft());

    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.processing_attempts).toBe(0);
  });

  it('should leave processing fields null until the worker fills them', async () => {
    const saved = await videoRepository.save(draft());

    expect(saved.thumbnail_key).toBeNull();
    expect(saved.duration_seconds).toBeNull();
    expect(saved.metadata).toBeNull();
    expect(saved.processing_error).toBeNull();
    expect(saved.source_size_bytes).toBeNull();
  });

  it('should enforce the unique public_id constraint', async () => {
    const publicId = generatePublicId();
    await videoRepository.save(draft({ public_id: publicId }));

    await expect(
      videoRepository.save(draft({ public_id: publicId })),
    ).rejects.toThrow();
  });

  it('should reject a video pointing at a channel that does not exist', async () => {
    await expect(
      videoRepository.save(
        draft({ channel_id: '11111111-2222-3333-4444-555555555555' }),
      ),
    ).rejects.toThrow();
  });

  it('should reject deleting a channel that still has videos', async () => {
    await videoRepository.save(draft());

    await expect(
      channelRepository.delete({ id: channel.id }),
    ).rejects.toThrow();
  });

  it('should read source_size_bytes back as a number, not a string', async () => {
    const size = 10_737_418_240;
    const saved = await videoRepository.save(
      draft({ source_size_bytes: size }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.source_size_bytes).toBe(size);
    expect(typeof found.source_size_bytes).toBe('number');
  });

  it('should persist metadata as structured jsonb', async () => {
    const saved = await videoRepository.save(
      draft({
        status: VideoStatus.READY,
        duration_seconds: 12.5,
        metadata: { width: 1920, height: 1080, video_codec: 'h264' },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.duration_seconds).toBeCloseTo(12.5);
    expect(found.metadata).toEqual({
      width: 1920,
      height: 1080,
      video_codec: 'h264',
    });
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "title", "status", "source_key", "source_content_type")
         VALUES ($1, $2, 'x', 'archived', 'k', 'video/mp4')`,
        [generatePublicId(), channel.id],
      ),
    ).rejects.toThrow();
  });

  it('should load the owning channel via the relation', async () => {
    const saved = await videoRepository.save(draft());

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
