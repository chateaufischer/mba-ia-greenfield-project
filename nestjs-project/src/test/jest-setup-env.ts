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

/**
 * A suíte roda **dentro** da rede do Compose, então as URLs pré-assinadas que
 * ela busca precisam ser assinadas para o host interno. Fixar aqui desacopla os
 * testes do valor de `STORAGE_PUBLIC_ENDPOINT` no `.env`, que o desenvolvedor
 * costuma apontar para `localhost:9000` para conseguir abrir as URLs no
 * navegador do host (a assinatura SigV4 cobre o host, então uma URL não vale
 * nos dois lugares).
 */
process.env.STORAGE_PUBLIC_ENDPOINT =
  process.env.TEST_STORAGE_PUBLIC_ENDPOINT ??
  `http://${process.env.STORAGE_ENDPOINT ?? 'minio'}:${process.env.STORAGE_PORT ?? '9000'}`;
