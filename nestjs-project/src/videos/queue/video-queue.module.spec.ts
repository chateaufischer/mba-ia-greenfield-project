import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../../config/queue.config';
import { VideoQueueModule } from './video-queue.module';
import { VideoQueuePublisher } from './video-queue.publisher';
import { VideoQueueTopology } from './video-queue.topology';

describe('VideoQueueModule', () => {
  it('should compile and resolve the publisher and the topology', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoQueueModule,
      ],
    }).compile();

    expect(moduleRef.get(VideoQueuePublisher)).toBeInstanceOf(
      VideoQueuePublisher,
    );
    expect(moduleRef.get(VideoQueueTopology)).toBeInstanceOf(
      VideoQueueTopology,
    );
    await moduleRef.close();
  });
});
