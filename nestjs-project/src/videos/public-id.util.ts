import { randomBytes } from 'node:crypto';

/**
 * Tamanho em bytes da entropia bruta. 8 bytes → 64 bits → 11 caracteres
 * base64url (phase-03-videos/TD-07).
 */
const PUBLIC_ID_ENTROPY_BYTES = 8;
export const PUBLIC_ID_LENGTH = 11;

/**
 * Identificador público curto e opaco do vídeo. Opaco de propósito: URLs
 * enumeráveis quebrariam a visibilidade `unlisted` que chega na Fase 04.
 */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_ENTROPY_BYTES).toString('base64url');
}
