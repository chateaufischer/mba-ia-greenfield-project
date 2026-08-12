/**
 * Ciclo de vida do vídeo (phase-03-videos/TD-08).
 *
 * `draft` é criado no pré-cadastro, antes de existir qualquer byte;
 * `processing` é assumido quando o multipart é concluído e o job é publicado;
 * `ready` quando o worker persistiu duração, metadados e thumbnail;
 * `failed` quando as tentativas de processamento se esgotaram.
 *
 * Não existe `uploading`: a API não observa os `PUT` das partes, que vão direto
 * ao storage — seria um estado que mente.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}
