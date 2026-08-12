import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import queueConfig from '../../config/queue.config';
import { VideoQueueModule } from './video-queue.module';
import { VideoQueueTopology } from './video-queue.topology';

describe('VideoQueueTopology (integration — RabbitMQ real)', () => {
  let moduleRef: TestingModule;
  let topology: VideoQueueTopology;
  let connection: ChannelModel;
  let channel: Channel;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoQueueModule,
      ],
    }).compile();
    await moduleRef.init();

    topology = moduleRef.get(VideoQueueTopology);
    await topology.assert();

    connection = await connect(queueConfig().url);
    channel = await connection.createChannel();
  });

  afterAll(async () => {
    await channel.close();
    await connection.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await channel.purgeQueue(topology.mainQueue);
    await channel.purgeQueue(topology.retryQueue);
    await channel.purgeQueue(topology.deadLetterQueue);
  });

  it('should declare the three queues', async () => {
    await expect(channel.checkQueue(topology.mainQueue)).resolves.toBeDefined();
    await expect(
      channel.checkQueue(topology.retryQueue),
    ).resolves.toBeDefined();
    await expect(
      channel.checkQueue(topology.deadLetterQueue),
    ).resolves.toBeDefined();
  });

  it('should be idempotent when asserted twice', async () => {
    await expect(topology.assert()).resolves.toBeUndefined();
  });

  it('should dead-letter an expired retry message back to the main queue', async () => {
    const payload = Buffer.from(
      JSON.stringify({ pattern: 'video.process', data: { video_id: 'x' } }),
    );

    channel.sendToQueue(topology.retryQueue, payload, { persistent: true });

    // O atraso é do broker (x-message-ttl), não do processo: a mensagem expira
    // e é encaminhada por dead-letter de volta para a fila principal.
    const ttl = queueConfig().jobRetryDelayMs;
    await new Promise((resolve) => setTimeout(resolve, ttl + 1500));

    const status = await channel.checkQueue(topology.mainQueue);
    expect(status.messageCount).toBe(1);
  }, 20_000);
});
