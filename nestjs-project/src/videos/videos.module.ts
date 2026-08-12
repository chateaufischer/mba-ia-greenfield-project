import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoQueueModule } from './queue/video-queue.module';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    VideoQueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, VideosService],
})
export class VideosModule {}
