import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { FfprobeOutput, ProbedMetadata } from './ffmpeg.types';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_POSITION_RATIO = 0.1;
const MIN_THUMBNAIL_SECOND = 1;

export class FfmpegError extends Error {
  constructor(
    command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `${command} failed with exit code ${exitCode ?? 'null'}: ${stderr.trim()}`,
    );
    this.name = 'FfmpegError';
  }
}

/**
 * Adapter fino sobre os binários do sistema (phase-03-videos/TD-05).
 *
 * Sem wrapper de terceiros: `fluent-ffmpeg` está sem manutenção e apenas
 * invocaria os mesmos binários, embrulhando o stderr — que é justamente o que
 * alimenta `processing_error` no TD-08.
 *
 * `input` pode ser um caminho local **ou uma URL HTTP**: é isso que viabiliza o
 * TD-06 (o protocolo HTTP do FFmpeg faz range requests e lê só o necessário).
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  async probe(
    input: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ProbedMetadata> {
    const stdout = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      timeoutMs,
    );

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    return this.distill(parsed);
  }

  /**
   * Extrai um frame como JPEG. `-ss` vem **antes** de `-i` de propósito: assim
   * o seek é por keyframe (input seeking) e o FFmpeg não decodifica o arquivo
   * desde o começo — o que, contra uma URL, é a diferença entre ler megabytes
   * e ler gigabytes.
   */
  async extractThumbnail(
    input: string,
    atSeconds: number,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Buffer> {
    const outputPath = path.join(os.tmpdir(), `thumb-${randomUUID()}.jpg`);

    try {
      await this.run(
        'ffmpeg',
        [
          '-nostdin',
          '-ss',
          String(atSeconds),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          `scale=${THUMBNAIL_WIDTH}:-2`,
          '-f',
          'image2',
          '-y',
          outputPath,
        ],
        timeoutMs,
      );
      return await fs.readFile(outputPath);
    } finally {
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
    }
  }

  /** 10% da duração, com piso de 1s — evita o primeiro frame preto. */
  thumbnailTimestamp(durationSeconds: number | null): number {
    if (!durationSeconds || durationSeconds <= 0) return MIN_THUMBNAIL_SECOND;
    return Math.max(
      MIN_THUMBNAIL_SECOND,
      Math.floor(durationSeconds * THUMBNAIL_POSITION_RATIO),
    );
  }

  private distill(output: FfprobeOutput): ProbedMetadata {
    const streams = output.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const duration = output.format?.duration;
    const bitRate = output.format?.bit_rate;

    return {
      duration_seconds: duration === undefined ? null : Number(duration),
      format_name: output.format?.format_name,
      bit_rate: bitRate === undefined ? undefined : Number(bitRate),
      width: video?.width,
      height: video?.height,
      video_codec: video?.codec_name,
      audio_codec: audio?.codec_name,
    };
  }

  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(
          new FfmpegError(command, null, `timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new FfmpegError(command, null, error.message));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          this.logger.warn(`${command} exited with ${code}`);
          reject(new FfmpegError(command, code, stderr));
        }
      });
    });
  }
}
