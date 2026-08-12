import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoStatus } from '../video-status.enum';

/**
 * O driver `pg` devolve `bigint` como string para não perder precisão acima de
 * 2^53. O tamanho máximo aceito aqui é 10GiB (~10^10), bem dentro do seguro em
 * `number`, então a conversão na borda mantém a API tipada sem risco.
 */
const bigintToNumber = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

export interface VideoMetadata {
  format_name?: string;
  bit_rate?: number;
  width?: number;
  height?: number;
  video_codec?: string;
  audio_codec?: string;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Identificador público curto usado nas URLs (phase-03-videos/TD-07). */
  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 150 })
  title: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 512 })
  source_key: string;

  @Column({ type: 'varchar', length: 150 })
  source_content_type: string;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: bigintToNumber,
  })
  source_size_bytes: number | null;

  /** `uploadId` do multipart enquanto o upload está aberto. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  /** stderr do FFmpeg quando o processamento falha em definitivo. */
  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'smallint', default: 0 })
  processing_attempts: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
