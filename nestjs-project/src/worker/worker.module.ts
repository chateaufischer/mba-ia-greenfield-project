import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import { User } from '../users/entities/user.entity';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { FfmpegService } from '../videos/processing/ffmpeg.service';
import { VideoQueueTopology } from '../videos/queue/video-queue.topology';
import { VideoProcessingController } from './video-processing.controller';
import { VideoProcessingService } from './video-processing.service';

/**
 * Módulo raiz do worker de vídeo (phase-03-videos/TD-04).
 *
 * Mesmo código da API — mesmas entidades, mesmo `StorageService`, mesmo
 * contrato de fila — mas sem controllers HTTP, guards ou Swagger: o worker não
 * escuta porta nenhuma.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // Lista explícita em vez de `autoLoadEntities`: o worker só faz
        // `forFeature([Video])`, e `Video` tem relação com `Channel`, que por
        // sua vez tem com `User`. Sem as duas, o TypeORM não consegue montar os
        // metadados da relação e o boot falha.
        entities: [User, Channel, Video],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
  ],
  controllers: [VideoProcessingController],
  providers: [VideoProcessingService, FfmpegService, VideoQueueTopology],
})
export class WorkerModule {}
