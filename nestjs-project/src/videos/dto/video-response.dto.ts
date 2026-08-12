import { ApiProperty } from '@nestjs/swagger';
import type { VideoMetadata } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';

/** Projeção pública do vídeo. É DTO de resposta, então anota explicitamente. */
export class VideoResponseDto {
  @ApiProperty({ example: 'V1StGXR8_Z5' })
  public_id: string;

  @ApiProperty({ example: 'Minha primeira gravação' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ required: false, nullable: true, example: 128.5 })
  duration_seconds: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    example: { width: 1920, height: 1080, video_codec: 'h264' },
  })
  metadata: VideoMetadata | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'URL pré-assinada de vida curta para o thumbnail',
  })
  thumbnail_url: string | null;

  @ApiProperty({ example: '/videos/V1StGXR8_Z5/stream' })
  stream_url: string;

  @ApiProperty({ example: '/videos/V1StGXR8_Z5/download' })
  download_url: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Presente apenas para o dono do canal',
  })
  processing_error?: string | null;
}
