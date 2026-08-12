import * as path from 'node:path';

/**
 * Layout de chaves do object storage (phase-03-videos/TD-01): um bucket privado
 * único, com prefixo por vídeo, para que "apagar um vídeo" seja um delete por
 * prefixo e origem + derivados fiquem colocados para regras de lifecycle.
 */
export const STORAGE_KEY_PREFIXES = {
  VIDEOS: 'videos',
  THUMBNAILS: 'thumbnails',
} as const;

/**
 * Extrai a extensão do nome de arquivo informado pelo cliente, normalizada em
 * minúsculas. Devolve string vazia quando não há extensão reconhecível.
 */
export function sourceExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

export function sourceKey(videoId: string, filename: string): string {
  return `${STORAGE_KEY_PREFIXES.VIDEOS}/${videoId}/source${sourceExtension(filename)}`;
}

export function thumbnailKey(videoId: string): string {
  return `${STORAGE_KEY_PREFIXES.THUMBNAILS}/${videoId}/thumbnail.jpg`;
}
