import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Integração contra o MinIO real do Compose (phase-03-videos/TD-11).
 * Presign, multipart e Range/206 não têm análogo em filesystem — mocar aqui
 * esconderia exatamente os bugs que esta fase pode introduzir.
 */
describe('StorageService (integration — MinIO real)', () => {
  const runPrefix = `test-runs/${randomUUID()}`;
  const createdKeys: string[] = [];
  let storage: StorageService;

  const key = (name: string): string => {
    const full = `${runPrefix}/${name}`;
    createdKeys.push(full);
    return full;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storage = moduleRef.get(StorageService);
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((k) => storage.removeObject(k).catch(() => undefined)),
    );
  });

  const putPart = async (url: string, body: Buffer): Promise<string> => {
    // `Buffer` não satisfaz `BodyInit` nas typings do fetch global; a view
    // Uint8Array sobre o mesmo buffer satisfaz e não copia os bytes.
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag as string;
  };

  describe('bucket bootstrap', () => {
    it('should be idempotent when the bucket already exists', async () => {
      await expect(storage.ensureBucket()).resolves.toBeUndefined();
      await expect(storage.ensureBucket()).resolves.toBeUndefined();
    });
  });

  describe('multipart upload lifecycle', () => {
    it('should upload two presigned parts and complete into a single object', async () => {
      const objectKey = key('multipart-complete.bin');
      // Partes intermediárias precisam ter no mínimo 5MiB no protocolo S3;
      // só a última pode ser menor.
      const firstPart = Buffer.alloc(5 * 1024 * 1024, 1);
      const lastPart = Buffer.alloc(1024, 2);

      const uploadId = await storage.createMultipartUpload(
        objectKey,
        'application/octet-stream',
      );
      const presigned = await storage.presignPartUrls(
        objectKey,
        uploadId,
        [1, 2],
      );
      expect(presigned).toHaveLength(2);

      const etags = await Promise.all([
        putPart(presigned[0].url, firstPart),
        putPart(presigned[1].url, lastPart),
      ]);

      await storage.completeMultipartUpload(objectKey, uploadId, [
        { part_number: 2, etag: etags[1] },
        { part_number: 1, etag: etags[0] },
      ]);

      const stat = await storage.statObject(objectKey);
      expect(stat.size).toBe(firstPart.length + lastPart.length);
    });

    it('should make completing an aborted upload fail', async () => {
      const objectKey = key('multipart-aborted.bin');
      const uploadId = await storage.createMultipartUpload(
        objectKey,
        'application/octet-stream',
      );
      const [presigned] = await storage.presignPartUrls(
        objectKey,
        uploadId,
        [1],
      );
      const etag = await putPart(presigned.url, Buffer.alloc(1024, 3));

      await storage.abortMultipartUpload(objectKey, uploadId);

      await expect(
        storage.completeMultipartUpload(objectKey, uploadId, [
          { part_number: 1, etag },
        ]),
      ).rejects.toBeDefined();
    });
  });

  describe('presigned GET', () => {
    const body = Buffer.from('a'.repeat(4096));

    it('should serve 206 Partial Content for a Range request', async () => {
      const objectKey = key('range.bin');
      await storage.putObject(objectKey, body, 'application/octet-stream');

      const url = await storage.presignGetUrl(objectKey, 60);
      const response = await fetch(url, { headers: { Range: 'bytes=0-9' } });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-9/4096');
      expect((await response.arrayBuffer()).byteLength).toBe(10);
    });

    it('should advertise range support on a full GET', async () => {
      const objectKey = key('full.bin');
      await storage.putObject(objectKey, body, 'application/octet-stream');

      const url = await storage.presignGetUrl(objectKey, 60);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
    });

    it('should honour a signed response-content-disposition override', async () => {
      const objectKey = key('download.bin');
      await storage.putObject(objectKey, body, 'video/mp4');

      const url = await storage.presignGetUrl(objectKey, 60, {
        'response-content-disposition': 'attachment; filename="clip.mp4"',
      });
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
    });
  });

  describe('object operations', () => {
    it('should report the stored size and remove the object', async () => {
      const objectKey = key('removable.bin');
      const body = Buffer.from('12345');

      await storage.putObject(objectKey, body, 'application/octet-stream');
      await expect(storage.statObject(objectKey)).resolves.toEqual(
        expect.objectContaining({ size: 5 }),
      );

      await storage.removeObject(objectKey);
      await expect(storage.statObject(objectKey)).rejects.toBeDefined();
    });
  });
});
