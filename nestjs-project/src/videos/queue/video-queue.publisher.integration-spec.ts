import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import queueConfig from '../../config/queue.config';
import {
  VIDEO_PROCESS_PATTERN,
  type VideoQueueEnvelope,
} from './video-queue.constants';
import { VideoQueueModule } from './video-queue.module';
import { VideoQueuePublisher } from './video-queue.publisher';
import { VideoQueueTopology } from './video-queue.topology';

/**
 * Integração contra o RabbitMQ real do Compose (phase-03-videos/TD-11).
 * Um mock aqui provaria apenas que chamamos nosso próprio mock — não pegaria
 * `queueOptions` divergente, envelope errado ou o Observable frio do `emit()`.
 */
describe('VideoQueuePublisher (integration — RabbitMQ real)', () => {
  let moduleRef: TestingModule;
  let publisher: VideoQueuePublisher;
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

    publisher = moduleRef.get(VideoQueuePublisher);
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
  });

  it('should publish one message carrying the Nest RMQ envelope', async () => {
    await publisher.publishProcessJob('video-123');

    const message = await channel.get(topology.mainQueue, { noAck: true });
    expect(message).not.toBe(false);

    const envelope = JSON.parse(
      (message as { content: Buffer }).content.toString(),
    ) as VideoQueueEnvelope;

    expect(envelope.pattern).toBe(VIDEO_PROCESS_PATTERN);
    expect(envelope.data).toEqual({ video_id: 'video-123', attempt: 1 });
  });

  it('should mark the message as persistent', async () => {
    await publisher.publishProcessJob('video-persistent');

    const message = await channel.get(topology.mainQueue, { noAck: true });
    expect(message).not.toBe(false);
    expect(
      (message as { properties: { deliveryMode?: number } }).properties
        .deliveryMode,
    ).toBe(2);
  });

  it('should carry the attempt number given by the caller', async () => {
    await publisher.publishProcessJob('video-retry', 3);

    const message = await channel.get(topology.mainQueue, { noAck: true });
    const envelope = JSON.parse(
      (message as { content: Buffer }).content.toString(),
    ) as VideoQueueEnvelope;

    expect(envelope.data.attempt).toBe(3);
  });

  it('should leave exactly one message per publish', async () => {
    await publisher.publishProcessJob('video-a');
    await publisher.publishProcessJob('video-b');

    const status = await channel.checkQueue(topology.mainQueue);
    expect(status.messageCount).toBe(2);
  });
});
