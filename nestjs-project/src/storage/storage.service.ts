import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Client } from 'minio';
import storageConfig from '../config/storage.config';

export interface UploadedPart {
  part_number: number;
  etag: string;
}

export interface PresignedPart {
  part_number: number;
  url: string;
  expires_in: number;
}

export interface ObjectStat {
  size: number;
  etag: string;
}

/**
 * Único ponto de contato com o object storage (phase-03-videos/TD-01).
 *
 * A escolha do cliente `minio` acopla o projeto a um SDK específico; esse
 * acoplamento é deliberadamente contido aqui — se o alvo passar a ser o AWS SDK
 * (produção em S3), este é o único arquivo que muda.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: Client;
  /**
   * Cliente usado só para assinar URLs. A assinatura SigV4 cobre o host, então
   * URLs destinadas ao consumidor externo precisam ser assinadas com o endpoint
   * público. Em dev os dois coincidem e a instância é reaproveitada.
   */
  private readonly presignClient: Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new Client({
      endPoint: config.endpoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });

    const samePublicEndpoint =
      config.publicEndpoint.host === config.endpoint &&
      config.publicEndpoint.port === config.port &&
      config.publicEndpoint.useSSL === config.useSSL;

    this.presignClient = samePublicEndpoint
      ? this.client
      : new Client({
          endPoint: config.publicEndpoint.host,
          port: config.publicEndpoint.port,
          useSSL: config.publicEndpoint.useSSL,
          accessKey: config.accessKey,
          secretKey: config.secretKey,
          region: config.region,
        });
  }

  get bucket(): string {
    return this.config.bucket;
  }

  get partSizeBytes(): number {
    return this.config.uploadPartSizeBytes;
  }

  /** Cria o bucket se ainda não existir. Idempotente por construção. */
  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    if (await this.client.bucketExists(this.config.bucket)) return;
    await this.client.makeBucket(this.config.bucket, this.config.region);
    this.logger.log(`Bucket "${this.config.bucket}" created`);
  }

  // --- multipart upload (phase-03-videos/TD-03) ---

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    return this.client.initiateNewMultipartUpload(this.config.bucket, key, {
      'Content-Type': contentType,
    });
  }

  /**
   * URL pré-assinada de `PUT` para uma parte. O presigner genérico é o único
   * caminho do cliente MinIO para assinar as query strings `uploadId` e
   * `partNumber` — que precisam ser string, não number.
   */
  async presignPartUrls(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    const expiresIn = this.config.uploadUrlExpirationSeconds;

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.presignClient.presignedUrl(
          'PUT',
          this.config.bucket,
          key,
          expiresIn,
          { uploadId, partNumber: String(partNumber) },
        ),
        expires_in: expiresIn,
      })),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const etags = [...parts]
      .sort((a, b) => a.part_number - b.part_number)
      .map((part) => ({ part: part.part_number, etag: part.etag }));

    await this.client.completeMultipartUpload(
      this.config.bucket,
      key,
      uploadId,
      etags,
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.abortMultipartUpload(this.config.bucket, key, uploadId);
  }

  // --- entrega e objetos (phase-03-videos/TD-06, TD-09, TD-10) ---

  async presignGetUrl(
    key: string,
    expiresIn: number = this.config.deliveryUrlExpirationSeconds,
    responseHeaders?: Record<string, string>,
  ): Promise<string> {
    return this.presignClient.presignedGetObject(
      this.config.bucket,
      key,
      expiresIn,
      responseHeaders,
    );
  }

  /**
   * URL pré-assinada para consumo interno (worker → FFmpeg). Assinada com o
   * endpoint interno, não com o público: quem consome está dentro da rede.
   */
  async presignInternalGetUrl(
    key: string,
    expiresIn: number,
  ): Promise<string> {
    return this.client.presignedGetObject(this.config.bucket, key, expiresIn);
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.putObject(this.config.bucket, key, body, body.length, {
      'Content-Type': contentType,
    });
  }

  async statObject(key: string): Promise<ObjectStat> {
    const stat = await this.client.statObject(this.config.bucket, key);
    return { size: stat.size, etag: stat.etag };
  }

  async removeObject(key: string): Promise<void> {
    await this.client.removeObject(this.config.bucket, key);
  }
}
