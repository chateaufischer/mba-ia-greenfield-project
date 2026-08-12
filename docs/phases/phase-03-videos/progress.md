# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/11 completed

### SI-03.1 — Infraestrutura de mídia no Compose e namespaces de configuração
- **Status:** completed
- **Tests:** 12/12 passing (`env.validation.integration-spec.ts`)
- **Observations:**
  - `Joi.string().uri()` aceita `minio:9000` como URI válida (`minio` vira scheme), então o teste que exigia rejeição só passou com `.uri({ scheme: ['http', 'https'] })` — que também é o contrato real, já que `storage.config.ts` faz `new URL()` sobre o valor.
  - `STORAGE_PUBLIC_ENDPOINT` ficou como URL completa (`http://minio:9000`) em vez de host + porta separados, para caber num único env var como o plano previa; o parse para o triplo host/port/useSSL que o cliente MinIO exige acontece em `storage.config.ts`.
  - `video-worker` foi declarado no `compose.yaml` mas não é iniciado ainda — não há entrypoint até SI-03.9.
  - MinIO fixado em `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` e RabbitMQ em `rabbitmq:4-management-alpine`; ambos alcançam `healthy`. `ffmpeg`/`ffprobe` 5.1.9 disponíveis no container da API.

### SI-03.2 — StorageService: cliente MinIO, bootstrap de bucket e layout de chaves
- **Status:** completed
- **Tests:** 15/15 passing (`storage.service.integration-spec.ts` 8 contra MinIO real, `storage.keys.spec.ts` 6, `storage.module.spec.ts` 1)
- **Observations:**
  - O ciclo multipart completo funcionou de primeira contra o MinIO real, incluindo `PUT` das partes por URL pré-assinada via `fetch` — sem nenhum ajuste de checksum, o que confirma na prática o principal argumento a favor da Opção B do TD-01.
  - Partes intermediárias de multipart precisam ter no mínimo 5MiB no protocolo S3 (só a última pode ser menor); o teste de ciclo completo usa 5MiB + 1KiB por causa disso.
  - Foram adicionados dois presigners: `presignGetUrl` (endpoint público, para o cliente) e `presignInternalGetUrl` (endpoint interno, para o worker) — a assinatura SigV4 cobre o host, então não dá para reaproveitar uma URL entre os dois contextos.

### SI-03.3 — Entidade Video, migration e gerador de public_id
- **Status:** completed
- **Tests:** 14/14 passing (`video.entity.integration-spec.ts` 9, `public-id.util.spec.ts` 3, `migrations.integration-spec.ts` 2)
- **Observations:**
  - O banco de dev estava com resíduo de `synchronize` (tabelas presentes, tabela `migrations` vazia) — exatamente o cenário descrito em `.claude/rules/typeorm-migrations.md`. Aplicada a recuperação prescrita: drop das tabelas gerenciadas + `migrations` e execução das três migrations do zero. Só havia dados efêmeros de teste (2 users, 2 channels).
  - `migrations.integration-spec.ts` tinha um bug latente: os `DROP TABLE ... CASCADE` do `beforeAll` rodavam em `Promise.all`, e drops concorrentes num grafo de FKs encadeadas se travam mutuamente (`deadlock detected`). Só apareceu quando `videos` entrou na lista. Corrigido para drop sequencial; também passou a derrubar os tipos enum, que sobreviviam ao drop das tabelas e quebravam o replay das migrations.
  - `source_size_bytes` é `bigint` e o driver `pg` devolve string; a entidade usa transformer para expor `number` (10GiB ≈ 10^10 cabe com folga em `Number.MAX_SAFE_INTEGER`).

### SI-03.4 — Resolução de canal por usuário no ChannelsModule
- **Status:** completed
- **Tests:** 29/29 passing na suíte de channels (4 novos em `channels.service.integration-spec.ts`)
- **Observations:**
  - `findByUserId` ficou no `ChannelsService`, não no módulo de vídeos: quem consulta canal é o módulo dono do domínio de canal. Fecha o `DG-1` do `validation.md`.

### SI-03.5 — Contrato da fila: constantes compartilhadas, publisher e topologia de retry/DLQ
- **Status:** completed
- **Tests:** 8/8 passing (`video-queue.publisher.integration-spec.ts` 4, `video-queue.topology.integration-spec.ts` 3, `video-queue.module.spec.ts` 1) contra RabbitMQ real
- **Observations:**
  - O teste de dead-letter confirmou o mecanismo do TD-08 na prática: mensagem publicada na fila de retry expira por `x-message-ttl` e o broker a devolve para a fila principal, sem nenhum timer no processo.
  - `emit()` só publica com `lastValueFrom` — o Observable é frio. Está encapsulado no `VideoQueuePublisher` para que nenhum chamador precise lembrar disso.
  - `persistent: true` no cliente e `durable: true` na fila são coisas diferentes e as duas são necessárias; o teste assere `deliveryMode === 2`.

### SI-03.6 — POST /videos: pré-cadastro do rascunho e abertura do upload multipart
- **Status:** completed
- **Tests:** 20/20 unit (`videos.service.spec.ts`) + 5/5 integração (`videos.service.integration-spec.ts`) + 15/15 e2e (`test/videos-upload.e2e-spec.ts`, compartilhado com SI-03.7) + 1 module spec
- **Observations:**
  - O plano dizia que `source_size_bytes` só seria preenchido no `complete`, mas sem o tamanho declarado no rascunho não há como validar o intervalo de partes em `POST /videos/:id/upload/parts`. Passou a ser gravado no pré-cadastro com o valor informado pelo cliente e **sobrescrito no `complete`** com o tamanho real lido do storage — que é o valor autoritativo.
  - O `@Matches(/^video\//)` inicial no DTO fazia o content-type inválido responder `400 VALIDATION_ERROR`, contradizendo o `415 UNSUPPORTED_MEDIA_TYPE` do Error Catalog. A regra saiu do DTO e ficou no domínio; o e2e cobre os dois códigos.
  - Os DTOs foram reescritos sem `@ApiProperty` manual, seguindo `.claude/rules/nestjs-dtos.md`: o CLI plugin do Swagger infere o schema de `class-validator` + JSDoc.

### SI-03.7 — Conclusão e cancelamento do upload
- **Status:** completed
- **Tests:** coberto pelas mesmas suítes do SI-03.6 (20 unit, 5 integração, 15 e2e)
- **Observations:**
  - A idempotência do `complete` acabou vindo de duas camadas, não de uma: o `UPDATE` condicional `draft → processing` (que decide se o job é publicado) e a checagem de upload aberto (que faz o segundo `complete` responder `409 UPLOAD_NOT_OPEN`, já que a transição zera o `upload_id`). O e2e assere o efeito que importa: exatamente uma mensagem na fila.
  - Um ETag falso é recusado pelo storage no `completeMultipartUpload`; o erro é traduzido para `400 INVALID_UPLOAD_PARTS` em vez de vazar como 500.

### SI-03.8 — Adapter FFmpeg: metadados e thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Worker: entrypoint, consumo da fila e atualização de status
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Entrega: metadados públicos, streaming e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Coerência documental da fase
- **Status:** pending
- **Tests:** —
- **Observations:** none
