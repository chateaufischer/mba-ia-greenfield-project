import { registerAs } from '@nestjs/config';

/**
 * Parses `STORAGE_PUBLIC_ENDPOINT` (a full URL such as `http://minio:9000`)
 * into the host/port/TLS triple the MinIO client constructor expects.
 *
 * The SigV4 signature covers the host, so a URL signed for `minio:9000` is not
 * valid at `localhost:9000`. Keeping the public endpoint as a separate knob
 * lets production point presigned URLs at the CDN/S3 host while the API and the
 * worker keep talking to the internal Compose service name.
 */
function parseEndpointUrl(raw: string): {
  host: string;
  port: number;
  useSSL: boolean;
} {
  const url = new URL(raw);
  const useSSL = url.protocol === 'https:';
  return {
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : useSSL ? 443 : 80,
    useSSL,
  };
}

export default registerAs('storage', () => {
  const endpoint = process.env.STORAGE_ENDPOINT || 'minio';
  const port = parseInt(process.env.STORAGE_PORT || '9000', 10);
  const useSSL = process.env.STORAGE_USE_SSL === 'true';

  const publicEndpoint = parseEndpointUrl(
    process.env.STORAGE_PUBLIC_ENDPOINT ||
      `${useSSL ? 'https' : 'http'}://${endpoint}:${port}`,
  );

  return {
    endpoint,
    port,
    useSSL,
    accessKey: process.env.STORAGE_ACCESS_KEY || 'streamtube',
    secretKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
    region: process.env.STORAGE_REGION || 'us-east-1',
    bucket: process.env.STORAGE_BUCKET || 'streamtube-media',
    publicEndpoint,
    uploadMaxBytes: parseInt(
      process.env.UPLOAD_MAX_BYTES || `${10 * 1024 * 1024 * 1024}`,
      10,
    ),
    uploadPartSizeBytes: parseInt(
      process.env.UPLOAD_PART_SIZE_BYTES || `${8 * 1024 * 1024}`,
      10,
    ),
    uploadUrlExpirationSeconds: parseInt(
      process.env.UPLOAD_URL_EXPIRATION_SECONDS || '3600',
      10,
    ),
    deliveryUrlExpirationSeconds: parseInt(
      process.env.DELIVERY_URL_EXPIRATION_SECONDS || '3600',
      10,
    ),
  };
});
