import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FfmpegError, FfmpegService } from './ffmpeg.service';

const JPEG_SOI = [0xff, 0xd8];

/**
 * Integração contra os binários reais instalados na imagem
 * (phase-03-videos/TD-05 + TD-11). Fingir o spawn aqui provaria apenas que
 * sabemos montar um array de argumentos.
 */
describe('FfmpegService (integration — ffmpeg/ffprobe reais)', () => {
  const service = new FfmpegService();
  const workdir = path.join(os.tmpdir(), `ffmpeg-it-${randomUUID()}`);
  let samplePath: string;

  const generateSample = (output: string): Promise<void> =>
    new Promise((resolve, reject) => {
      // testsrc: gerador sintético do próprio ffmpeg — não precisa de fixture
      // binária no repositório.
      const child = spawn('ffmpeg', [
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=3:size=320x240:rate=15',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        output,
      ]);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr)),
      );
    });

  beforeAll(async () => {
    await fs.mkdir(workdir, { recursive: true });
    samplePath = path.join(workdir, 'sample.mp4');
    await generateSample(samplePath);
  }, 60_000);

  afterAll(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  describe('probe', () => {
    it('should read duration, dimensions and codec from a real file', async () => {
      const metadata = await service.probe(samplePath);

      expect(metadata.duration_seconds).toBeCloseTo(3, 0);
      expect(metadata.width).toBe(320);
      expect(metadata.height).toBe(240);
      expect(metadata.video_codec).toBe('h264');
      expect(metadata.format_name).toContain('mp4');
    });

    it('should reject with the stderr emitted by ffprobe', async () => {
      const missing = path.join(workdir, 'does-not-exist.mp4');

      await expect(service.probe(missing)).rejects.toBeInstanceOf(FfmpegError);
      await expect(service.probe(missing)).rejects.toThrow(
        /No such file|does-not-exist/,
      );
    });
  });

  describe('extractThumbnail', () => {
    it('should return a valid JPEG buffer', async () => {
      const buffer = await service.extractThumbnail(samplePath, 1);

      expect(buffer.length).toBeGreaterThan(0);
      expect([buffer[0], buffer[1]]).toEqual(JPEG_SOI);
    });

    it('should scale the frame to the configured width', async () => {
      const buffer = await service.extractThumbnail(samplePath, 1);
      const thumbPath = path.join(workdir, 'thumb.jpg');
      await fs.writeFile(thumbPath, buffer);

      const metadata = await service.probe(thumbPath);
      expect(metadata.width).toBe(1280);
      // 320x240 escalado para largura 1280 mantendo a proporção → 960.
      expect(metadata.height).toBe(960);
    });

    it('should not leave the temporary frame file behind', async () => {
      const before = await fs.readdir(os.tmpdir());
      await service.extractThumbnail(samplePath, 1);
      const after = await fs.readdir(os.tmpdir());

      const leaked = after.filter(
        (entry) => entry.startsWith('thumb-') && !before.includes(entry),
      );
      expect(leaked).toEqual([]);
    });

    it('should reject for an input that cannot be decoded', async () => {
      const corrupted = path.join(workdir, 'corrupted.mp4');
      await fs.writeFile(corrupted, Buffer.from('this is not a video'));

      await expect(
        service.extractThumbnail(corrupted, 1),
      ).rejects.toBeInstanceOf(FfmpegError);
    });
  });
});
