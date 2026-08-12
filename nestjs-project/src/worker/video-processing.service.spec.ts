import { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from '../videos/processing/ffmpeg.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VideoProcessingService } from './video-processing.service';

const MAX_ATTEMPTS = 3;
const VIDEO_ID = 'video-1';

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let repository: jest.Mocked<Repository<Video>>;
  let storage: jest.Mocked<Partial<StorageService>>;
  let ffmpeg: jest.Mocked<Partial<FfmpegService>>;

  const processingVideo = {
    id: VIDEO_ID,
    status: VideoStatus.PROCESSING,
    source_key: `videos/${VIDEO_ID}/source.mp4`,
  } as Video;

  beforeEach(async () => {
    repository = {
      findOneBy: jest.fn().mockResolvedValue(processingVideo),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as jest.Mocked<Repository<Video>>;

    storage = {
      presignInternalGetUrl: jest
        .fn()
        .mockResolvedValue('http://minio:9000/signed'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };

    ffmpeg = {
      probe: jest.fn().mockResolvedValue({
        duration_seconds: 30,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
      }),
      thumbnailTimestamp: jest.fn().mockReturnValue(3),
      extractThumbnail: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
        {
          provide: queueConfig.KEY,
          useValue: { jobMaxAttempts: MAX_ATTEMPTS } as ConfigType<
            typeof queueConfig
          >,
        },
        {
          provide: storageConfig.KEY,
          useValue: { uploadUrlExpirationSeconds: 3600 } as ConfigType<
            typeof storageConfig
          >,
        },
      ],
    }).compile();

    service = moduleRef.get(VideoProcessingService);
  });

  describe('idempotence', () => {
    it('should skip a video that no longer exists', async () => {
      repository.findOneBy.mockResolvedValue(null);

      await expect(service.process(VIDEO_ID, 1)).resolves.toMatchObject({
        kind: 'skipped',
      });
      expect(ffmpeg.probe).not.toHaveBeenCalled();
    });

    it('should skip a video that is already ready', async () => {
      repository.findOneBy.mockResolvedValue({
        ...processingVideo,
        status: VideoStatus.READY,
      } as Video);

      const outcome = await service.process(VIDEO_ID, 1);

      expect(outcome).toMatchObject({ kind: 'skipped' });
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('should probe a presigned URL rather than a local file', async () => {
      await service.process(VIDEO_ID, 1);

      expect(storage.presignInternalGetUrl).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/source.mp4`,
        3600,
      );
      expect(ffmpeg.probe).toHaveBeenCalledWith('http://minio:9000/signed');
    });

    it('should store the thumbnail under the video thumbnail key', async () => {
      await service.process(VIDEO_ID, 1);

      expect(storage.putObject).toHaveBeenCalledWith(
        `thumbnails/${VIDEO_ID}/thumbnail.jpg`,
        expect.any(Buffer),
        'image/jpeg',
      );
    });

    it('should persist duration, metadata and the ready status', async () => {
      const outcome = await service.process(VIDEO_ID, 1);

      expect(outcome).toEqual({ kind: 'processed' });
      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({
          status: VideoStatus.READY,
          duration_seconds: 30,
          thumbnail_key: `thumbnails/${VIDEO_ID}/thumbnail.jpg`,
          processing_error: null,
          metadata: expect.objectContaining({ width: 1920, height: 1080 }),
        }),
      );
    });

    it('should not put duration inside the metadata blob', async () => {
      await service.process(VIDEO_ID, 1);

      const [, patch] = repository.update.mock.calls[0] as [
        unknown,
        { metadata: Record<string, unknown> },
      ];
      expect(patch.metadata).not.toHaveProperty('duration_seconds');
    });
  });

  describe('failure policy', () => {
    beforeEach(() => {
      (ffmpeg.probe as jest.Mock).mockRejectedValue(
        new Error('Invalid data found when processing input'),
      );
    });

    it('should ask for a retry while attempts remain', async () => {
      const outcome = await service.process(VIDEO_ID, 1);

      expect(outcome).toEqual({
        kind: 'retry',
        nextAttempt: 2,
        error: 'Invalid data found when processing input',
      });
      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        { processing_attempts: 1 },
      );
    });

    it('should keep the video out of failed while retrying', async () => {
      await service.process(VIDEO_ID, 2);

      expect(repository.update).not.toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({ status: VideoStatus.FAILED }),
      );
    });

    it('should mark the video failed on the last attempt', async () => {
      const outcome = await service.process(VIDEO_ID, MAX_ATTEMPTS);

      expect(outcome.kind).toBe('failed');
      expect(repository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          processing_error: 'Invalid data found when processing input',
          processing_attempts: MAX_ATTEMPTS,
        }),
      );
    });
  });
});
