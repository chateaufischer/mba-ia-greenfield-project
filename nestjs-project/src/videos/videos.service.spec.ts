import { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoQueuePublisher } from './queue/video-queue.publisher';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const PART_SIZE = 8 * 1024 * 1024;
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
const CHANNEL_ID = 'channel-1';
const USER_ID = 'user-1';

const config = {
  uploadMaxBytes: MAX_BYTES,
  uploadPartSizeBytes: PART_SIZE,
} as ConfigType<typeof storageConfig>;

const validDto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto => ({
  title: 'Meu vídeo',
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size_bytes: PART_SIZE * 2,
  ...overrides,
});

describe('VideosService', () => {
  let service: VideosService;
  let repository: jest.Mocked<Repository<Video>>;
  let channels: { findByUserId: jest.Mock };
  let storage: jest.Mocked<Partial<StorageService>>;
  let queue: { publishProcessJob: jest.Mock };

  beforeEach(async () => {
    repository = {
      create: jest.fn((data) => data as Video),
      save: jest.fn((entity) => ({ id: 'video-1', ...entity }) as Video),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as jest.Mocked<Repository<Video>>;

    channels = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };

    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignPartUrls: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      statObject: jest.fn().mockResolvedValue({ size: 4096, etag: 'e' }),
    };

    queue = { publishProcessJob: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: VideoQueuePublisher, useValue: queue },
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('totalParts', () => {
    it('should round up to cover the whole file', () => {
      expect(service.totalParts(PART_SIZE * 2)).toBe(2);
      expect(service.totalParts(PART_SIZE * 2 + 1)).toBe(3);
    });

    it('should always require at least one part', () => {
      expect(service.totalParts(1)).toBe(1);
    });

    it('should keep a 10GB upload well under the 10000-part S3 ceiling', () => {
      expect(service.totalParts(MAX_BYTES)).toBe(1280);
    });
  });

  describe('createDraft', () => {
    it('should reject a non-video content type before touching storage', async () => {
      await expect(
        service.createDraft(
          USER_ID,
          validDto({ content_type: 'application/pdf' }),
        ),
      ).rejects.toMatchObject({ errorCode: 'UNSUPPORTED_MEDIA_TYPE' });

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a file above the size limit before touching storage', async () => {
      await expect(
        service.createDraft(USER_ID, validDto({ size_bytes: MAX_BYTES + 1 })),
      ).rejects.toMatchObject({ errorCode: 'UPLOAD_TOO_LARGE' });

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should fail when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(
        service.createDraft(USER_ID, validDto()),
      ).rejects.toMatchObject({ errorCode: 'CHANNEL_NOT_FOUND' });
    });

    it('should open the multipart upload and report the upload plan', async () => {
      const result = await service.createDraft(USER_ID, validDto());

      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        'video/mp4',
      );
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload).toEqual({
        upload_id: 'upload-1',
        part_size_bytes: PART_SIZE,
        total_parts: 2,
      });
    });

    it('should regenerate the public id on a unique violation', async () => {
      const violation = Object.assign(
        new QueryFailedError('insert', [], new Error('duplicate')),
        { code: '23505', detail: 'Key (public_id)=(abc) already exists.' },
      );
      repository.save
        .mockRejectedValueOnce(violation)
        .mockImplementation(
          (entity) => ({ id: 'video-1', ...entity }) as never,
        );

      const result = await service.createDraft(USER_ID, validDto());

      expect(result.public_id).toHaveLength(11);
      expect(repository.save).toHaveBeenCalledTimes(3); // falha + insert + update
    });

    it('should not swallow unrelated database errors', async () => {
      repository.save.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.createDraft(USER_ID, validDto())).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('issuePartUrls', () => {
    const draft = {
      id: 'video-1',
      channel_id: CHANNEL_ID,
      status: VideoStatus.DRAFT,
      upload_id: 'upload-1',
      source_key: 'videos/video-1/source.mp4',
      source_size_bytes: PART_SIZE * 2,
    } as Video;

    it('should reject part numbers beyond the declared total', async () => {
      repository.findOne.mockResolvedValue(draft);

      await expect(
        service.issuePartUrls(USER_ID, 'video-1', [1, 5]),
      ).rejects.toMatchObject({ errorCode: 'INVALID_UPLOAD_PARTS' });
    });

    it('should reject a video owned by another channel', async () => {
      repository.findOne.mockResolvedValue({
        ...draft,
        channel_id: 'other-channel',
      } as Video);

      await expect(
        service.issuePartUrls(USER_ID, 'video-1', [1]),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_OWNED' });
    });

    it('should reject when there is no open upload', async () => {
      repository.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.PROCESSING,
        upload_id: null,
      } as Video);

      await expect(
        service.issuePartUrls(USER_ID, 'video-1', [1]),
      ).rejects.toMatchObject({ errorCode: 'UPLOAD_NOT_OPEN' });
    });

    it('should presign the requested parts against the source key', async () => {
      repository.findOne.mockResolvedValue(draft);

      await service.issuePartUrls(USER_ID, 'video-1', [1, 2]);

      expect(storage.presignPartUrls).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        'upload-1',
        [1, 2],
      );
    });
  });

  describe('completeUpload', () => {
    const draft = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      channel_id: CHANNEL_ID,
      status: VideoStatus.DRAFT,
      upload_id: 'upload-1',
      source_key: 'videos/video-1/source.mp4',
      source_size_bytes: PART_SIZE * 2,
    } as Video;

    beforeEach(() => {
      repository.findOne.mockResolvedValue(draft);
    });

    it('should reject duplicated part numbers', async () => {
      await expect(
        service.completeUpload(USER_ID, 'video-1', [
          { part_number: 1, etag: 'a' },
          { part_number: 1, etag: 'b' },
        ]),
      ).rejects.toMatchObject({ errorCode: 'INVALID_UPLOAD_PARTS' });

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should surface a storage rejection as an invalid-parts error', async () => {
      (storage.completeMultipartUpload as jest.Mock).mockRejectedValue(
        new Error('InvalidPart'),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-1', [
          { part_number: 1, etag: 'a' },
        ]),
      ).rejects.toMatchObject({ errorCode: 'INVALID_UPLOAD_PARTS' });
    });

    it('should publish the job when the status transition happens', async () => {
      await service.completeUpload(USER_ID, 'video-1', [
        { part_number: 1, etag: 'a' },
      ]);

      expect(queue.publishProcessJob).toHaveBeenCalledWith('video-1');
    });

    it('should not publish again when the transition affects no row', async () => {
      (repository.update as jest.Mock).mockResolvedValue({ affected: 0 });

      await service.completeUpload(USER_ID, 'video-1', [
        { part_number: 1, etag: 'a' },
      ]);

      expect(queue.publishProcessJob).not.toHaveBeenCalled();
    });

    it('should persist the real size read from storage, not the declared one', async () => {
      await service.completeUpload(USER_ID, 'video-1', [
        { part_number: 1, etag: 'a' },
      ]);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        expect.objectContaining({ source_size_bytes: 4096 }),
      );
    });
  });

  describe('abortUpload', () => {
    it('should abort in storage and drop the draft', async () => {
      repository.findOne.mockResolvedValue({
        id: 'video-1',
        channel_id: CHANNEL_ID,
        status: VideoStatus.DRAFT,
        upload_id: 'upload-1',
        source_key: 'videos/video-1/source.mp4',
      } as Video);

      await service.abortUpload(USER_ID, 'video-1');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source.mp4',
        'upload-1',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should fail for a video that does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.abortUpload(USER_ID, 'video-1'),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });
    });
  });
});
