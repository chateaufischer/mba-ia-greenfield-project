/**
 * Overrides de ambiente aplicados antes de qualquer teste (`setupFiles`),
 * depois do `dotenv/config`.
 *
 * A suíte usa uma **fila própria**. O serviço `video-worker` do Compose fica
 * de pé consumindo `video.processing`, então um teste que publica e depois
 * conta mensagens na fila principal disputaria com ele e falharia de forma
 * intermitente — não por bug do código, mas porque o consumidor real fez o
 * trabalho dele. Isolar a fila mantém as asserções determinísticas sem desligar
 * o worker nem mocar o broker (phase-03-videos/TD-11).
 */
process.env.VIDEO_QUEUE_NAME =
  process.env.TEST_VIDEO_QUEUE_NAME ?? 'video.processing.test';
