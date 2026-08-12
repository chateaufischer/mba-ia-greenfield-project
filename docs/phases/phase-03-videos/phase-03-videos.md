---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-11T19:38:25-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-11T19:29:14-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-11T19:31:14-03:00"
  docs/project-plan.md: "2026-08-10T19:39:53-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o ciclo completo de vídeo do StreamTube — object storage e fila de processamento subindo no Compose, upload direto ao storage de arquivos de até 10GB sem que um único byte atravesse a API, pré-cadastro do vídeo como rascunho, processamento automático em worker separado (duração, metadados e thumbnail via FFmpeg), URL pública única por vídeo, e entrega por streaming com `Range`/`206` e download — estabelecendo a fundação de mídia sobre a qual as Fases 04 e 05 constroem.

---

## Step Implementations

### SI-03.1 — Infraestrutura de mídia no Compose e namespaces de configuração

**Description:** Subir os dois serviços novos (object storage e broker) e o container do worker junto da stack existente, instalar as dependências da fase e criar os namespaces de config correspondentes — sem nenhum código de domínio ainda.

**Technical actions:**

1. Instalar dependências de produção em `nestjs-project`: `minio@^8.0.7` (per `phase-03-videos/TD-01`), `@nestjs/microservices@^11.1.29` + `amqplib@^2.0.1` + `amqp-connection-manager@^5.0.0` (per `phase-03-videos/TD-02`). **Não** instalar `@types/amqplib`: o `amqplib@2` já publica os próprios tipos e o pacote de tipos descreve a API antiga (per `library-refs.md` → amqplib).
2. Acrescentar ao `nestjs-project/compose.yaml` os serviços `minio` (API `9000`, console `9001`, volume nomeado, healthcheck) e `rabbitmq` (AMQP `5672`, management `15672`, volume nomeado, healthcheck `rabbitmq-diagnostics -q ping`), e declarar `depends_on: { condition: service_healthy }` nos consumidores.
3. Acrescentar o serviço `video-worker` ao Compose — mesma imagem de dev e mesmo bind-mount do `nestjs-api`, `command` próprio, sem porta publicada (per `phase-03-videos/TD-04` + Revisão de 2026-08-11); e instalar `ffmpeg` no `Dockerfile.dev` (per `phase-03-videos/TD-05` + Revisão).
4. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` como factories `registerAs` (convenção herdada da Fase 01), e estender `src/config/env.validation.ts` com as novas variáveis: `STORAGE_ENDPOINT`, `STORAGE_PORT`, `STORAGE_USE_SSL`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_PUBLIC_ENDPOINT`, `UPLOAD_MAX_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_URL_EXPIRATION_SECONDS`, `DELIVERY_URL_EXPIRATION_SECONDS`, `RABBITMQ_URL`, `VIDEO_QUEUE_NAME`, `VIDEO_JOB_MAX_ATTEMPTS`, `VIDEO_JOB_RETRY_DELAY_MS`.
5. Refletir todas as variáveis novas em `.env` e `.env.example`, usando nomes de serviço do Compose como host (`STORAGE_ENDPOINT=minio`, `RABBITMQ_URL=amqp://streamtube:streamtube@rabbitmq:5672`) — nunca `localhost`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas variáveis obrigatórias rejeitam ausência, defaults aplicados, `UPLOAD_MAX_BYTES` coage string→number | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `minio`, `rabbitmq`, `nestjs-api` e `video-worker`, e `docker compose ps` mostra os seis como `running`.
- O healthcheck do `minio` e do `rabbitmq` alcança `healthy`, e o console do MinIO responde em `http://localhost:9001`.
- `ffmpeg -version` e `ffprobe -version` executam com sucesso dentro do container `nestjs-api`.
- Subir a aplicação sem `STORAGE_ACCESS_KEY` provoca erro de validação Joi no bootstrap — o processo não sobe.
- A suíte existente (Fases 01–02) continua verde após a instalação das dependências.

---

### SI-03.2 — StorageService: cliente MinIO, bootstrap de bucket e layout de chaves

**Description:** Encapsular todo o acesso ao object storage num único serviço atrás de interface — o ponto de contenção do acoplamento assumido em `phase-03-videos/TD-01` — cobrindo bootstrap idempotente do bucket, presign, multipart e leitura/escrita de objetos.

**Technical actions:**

1. Criar `src/storage/storage.keys.ts` — funções puras `sourceKey(videoId, ext)` → `videos/{videoId}/source{ext}` e `thumbnailKey(videoId)` → `thumbnails/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-01`).
2. Criar `src/storage/storage.service.ts` — `StorageService` injetando `storageConfig`, instanciando `new Client({ endPoint, port, useSSL, accessKey, secretKey, region })`, com `onModuleInit` fazendo `bucketExists`/`makeBucket` idempotente.
3. Implementar no mesmo serviço as operações de multipart: `createMultipartUpload(key, contentType)`, `presignPartUrl(key, uploadId, partNumber)` via `presignedUrl('PUT', ..., { uploadId, partNumber })` com valores string, `completeMultipartUpload(key, uploadId, parts)` normalizando para `{ part, etag }` ordenado, e `abortMultipartUpload(key, uploadId)` (per `library-refs.md` → minio).
4. Implementar as operações de entrega e de objeto: `presignGetUrl(key, expiresIn, respHeaders?)`, `putObject(key, buffer, contentType)`, `statObject(key)` e `removeObject(key)`.
5. Criar `src/storage/storage.module.ts` exportando `StorageService`, para consumo tanto pela API quanto pelo worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real do Compose, per `phase-03-videos/TD-11`): bootstrap idempotente, ciclo multipart completo (create → presign → PUT real da parte → complete → stat), abort, presign GET com e sem `response-content-disposition` | `src/storage/storage.service.integration-spec.ts` |
| `storage.keys.ts` | Unit: formato das chaves, extensão preservada, extensão ausente | `src/storage/storage.keys.spec.ts` |
| `StorageModule` | Unit: compilação do módulo com config carregada | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Subir a aplicação com um bucket inexistente cria o bucket; subir de novo não falha nem duplica.
- Um objeto enviado em duas partes via URLs pré-assinadas e finalizado por `completeMultipartUpload` é recuperável por `statObject` com o tamanho igual à soma das partes.
- `abortMultipartUpload` sobre um upload aberto faz o `complete` subsequente do mesmo `uploadId` falhar.
- Uma URL pré-assinada de GET gerada com `response-content-disposition` devolve o header `Content-Disposition: attachment` na resposta do storage.
- Uma requisição `Range: bytes=0-9` contra a URL pré-assinada de GET devolve `206` com `Content-Range` e exatamente 10 bytes.

---

### SI-03.3 — Entidade `Video`, migration e gerador de `public_id`

**Description:** Materializar o modelo de dados do vídeo ligado ao canal, com o identificador público curto e único, e ajustar o helper de limpeza de tabelas para que as suítes herdadas continuem verdes (fecha `DG-2` de `validation.md`).

**Technical actions:**

1. Criar `src/videos/public-id.util.ts` — `generatePublicId()` retornando 11 caracteres base64url a partir de `crypto.randomBytes(8)` (per `phase-03-videos/TD-07`).
2. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos, tipos e índices definidos em `## Technical Specifications → Data Model`, incluindo `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })` e transformer numérico em `source_size_bytes` (`bigint` chega como string no driver `pg`).
3. Criar `src/videos/video-status.enum.ts` — `VideoStatus` com `draft | processing | ready | failed` (per `phase-03-videos/TD-08`), usado pela entidade e pelos serviços.
4. Gerar a migration `CreateVideos` via `npm run migration:generate` e revisar o SQL: tipo enum, `UNIQUE` em `public_id`, índices em `channel_id` e `status`, FK para `channels`.
5. Acrescentar `DELETE FROM "videos"` como primeira instrução de `cleanAllTables()` em `src/test/create-test-data-source.ts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unicidade de `public_id`, default de `status`, nulabilidade de `thumbnail_key`/`duration_seconds`/`processing_error`, FK com `channels`, `source_size_bytes` volta como number | `src/videos/entities/video.entity.integration-spec.ts` |
| `public-id.util.ts` | Unit: comprimento 11, alfabeto URL-safe, ausência de colisão em amostra grande | `src/videos/public-id.util.spec.ts` |
| Migration `CreateVideos` | Integration: aplica e reverte de forma limpa | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum de status, o índice único de `public_id` e a FK para `channels`.
- Inserir dois vídeos com o mesmo `public_id` viola a constraint de unicidade.
- Um vídeo recém-criado tem `status = 'draft'` e `processing_attempts = 0` sem que o chamador informe.
- Apagar um canal com vídeos é rejeitado pela FK — vídeos não ficam órfãos.
- `npm run migration:revert` remove a tabela e o tipo enum sem deixar resíduo.

---

### SI-03.4 — Resolução de canal por usuário no `ChannelsModule`

**Description:** Fechar `DG-1` de `validation.md`: o vídeo pertence a um canal, mas a Fase 02 só expôs `createChannel`. A capacidade de lookup entra no módulo dono do domínio de canal, não no de vídeos.

**Technical actions:**

1. Acrescentar `findByUserId(userId: string): Promise<Channel | null>` ao `ChannelsService`, usando o repositório de `Channel` já injetado.
2. Confirmar que `ChannelsModule` exporta `ChannelsService` e registrar `ChannelsModule` nos imports do futuro `VideosModule` (o import concreto entra no SI-03.6).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário, retorna `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `findByUserId` devolve o canal criado no cadastro do usuário, com `id` e `nickname` preenchidos.
- `findByUserId` com um UUID que não pertence a nenhum usuário devolve `null` em vez de lançar.
- As suítes existentes de `channels` continuam verdes.

---

### SI-03.5 — Contrato da fila: constantes compartilhadas, publisher e topologia de retry/DLQ

**Description:** Estabelecer o contrato de mensageria entre API e worker num único lugar — nomes de fila, `queueOptions` e pattern — e criar o publisher e a declaração da topologia de retry/dead-letter que substitui o backoff que o BullMQ daria pronto (per `phase-03-videos/TD-02` + `TD-08`).

**Technical actions:**

1. Criar `src/videos/queue/video-queue.constants.ts` — `VIDEO_QUEUE_CLIENT`, `VIDEO_PROCESS_PATTERN = 'video.process'`, nomes das três filas e `VIDEO_QUEUE_OPTIONS` (`{ durable: true }`). Produtor e consumidor importam desta constante: `queueOptions` divergente derruba o canal com `PRECONDITION_FAILED` (per `library-refs.md` → @nestjs/microservices).
2. Criar `src/videos/queue/video-queue.module.ts` — `ClientsModule.registerAsync` com `Transport.RMQ`, `urls`, `queue`, `queueOptions` compartilhado e `persistent: true`.
3. Criar `src/videos/queue/video-queue.publisher.ts` — `publishProcessJob(videoId, attempt)` fazendo `await lastValueFrom(client.emit(...))`, já que `emit()` devolve Observable frio e sem subscribe nada é publicado.
4. Criar `src/videos/queue/video-queue.topology.ts` — `assertQueue` de `video.processing.retry` (com `x-message-ttl`, `x-dead-letter-exchange: ''` e `x-dead-letter-routing-key` apontando para a fila principal) e de `video.processing.dlq`, via conexão `amqplib` de vida curta no boot.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoQueuePublisher` | Integration (RabbitMQ real, per `phase-03-videos/TD-11`): mensagem publicada chega na fila com o envelope `{ pattern, data }` e `deliveryMode` persistente | `src/videos/queue/video-queue.publisher.integration-spec.ts` |
| `VideoQueueTopology` | Integration: filas de retry e DLQ declaradas com os argumentos esperados; declaração é idempotente | `src/videos/queue/video-queue.topology.integration-spec.ts` |
| `VideoQueueModule` | Unit: compilação do módulo | `src/videos/queue/video-queue.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Publicar um job deixa exatamente uma mensagem na fila `video.processing`, cujo corpo é `{"pattern":"video.process","data":{...}}`.
- A fila `video.processing.retry` existe com `x-message-ttl` e `x-dead-letter-routing-key` apontando para `video.processing`.
- Uma mensagem publicada na fila de retry reaparece na fila principal após o TTL, sem intervenção de código.
- Declarar a topologia duas vezes não gera erro.

---

### SI-03.6 — `POST /videos`: pré-cadastro do rascunho e abertura do upload multipart

**Description:** Primeiro passo do handshake de upload: registrar o vídeo como `draft` antes de existir qualquer byte, abrir o multipart no storage e devolver ao cliente o plano de upload (per `phase-03-videos/TD-03` + `TD-08`).

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` e `src/videos/dto/upload-parts.dto.ts` com validação `class-validator` conforme `### API Contracts → #### Validation Rules`.
2. Criar `src/videos/videos.service.ts` com `createDraft(userId, dto)`: resolve o canal via `ChannelsService.findByUserId`, valida `size_bytes` contra `UPLOAD_MAX_BYTES` e `content_type` contra o prefixo `video/`, gera `public_id` com retry em violação de unicidade (mesmo padrão de colisão de nickname da Fase 02), abre o multipart e persiste o rascunho com `upload_id` e `source_key`.
3. Implementar `issuePartUrls(userId, videoId, partNumbers)` no mesmo serviço — valida posse, exige `status = draft` com `upload_id` presente, rejeita números de parte fora de `1..total_parts` e devolve as URLs pré-assinadas.
4. Criar `src/videos/videos.controller.ts` com `POST /videos` e `POST /videos/:id/upload/parts`, decorados para OpenAPI conforme a convenção herdada (`@ApiOperation`, `@ApiResponse`, `ApiErrorEnvelope` via `getSchemaPath`).
5. Criar `src/videos/videos.module.ts` importando `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule` e `VideoQueueModule`, e registrá-lo em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: cálculo de `total_parts`, rejeição por tamanho e por content-type, retry de colisão de `public_id` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: rascunho persistido com `status='draft'`, `upload_id` e vínculo ao canal correto | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos`, `POST /videos/:id/upload/parts` | E2E: contrato de sucesso, validação, autenticação e posse | `test/videos.e2e-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `public_id` de 11 caracteres, `status: "draft"`, `upload.upload_id` e `upload.total_parts` coerente com `ceil(size_bytes / part_size_bytes)`.
- `POST /videos` com `size_bytes` acima do limite retorna `413` com `errorCode: "UPLOAD_TOO_LARGE"`, e nenhum registro é criado.
- `POST /videos` com `content_type: "application/pdf"` retorna `415` com `errorCode: "UNSUPPORTED_MEDIA_TYPE"`.
- `POST /videos` sem token retorna `401`; com token de usuário sem canal retorna `404` com `errorCode: "CHANNEL_NOT_FOUND"`.
- `POST /videos/:id/upload/parts` de um usuário que não é dono do canal do vídeo retorna `403` com `errorCode: "VIDEO_NOT_OWNED"`.
- `POST /videos/:id/upload/parts` com `part_numbers: [1]` devolve uma URL absoluta que aceita `PUT` direto no storage.

---

### SI-03.7 — Conclusão e cancelamento do upload

**Description:** Fechar o handshake: consolidar as partes no storage, transicionar `draft → processing` de forma idempotente e publicar o job de processamento; e permitir abortar um upload em andamento (per `phase-03-videos/TD-03` + `TD-08`).

**Technical actions:**

1. Implementar `completeUpload(userId, videoId, parts)` em `VideosService`: valida posse e estado, rejeita lista vazia/duplicada/fora de intervalo, chama `completeMultipartUpload`, lê o tamanho real com `statObject` e grava `source_size_bytes`.
2. Fazer a transição `draft → processing` por `UPDATE` condicional (`WHERE id = :id AND status = 'draft'`) e só publicar o job quando o update afetar uma linha — é o mecanismo de idempotência que substitui o `jobId` do BullMQ (per `phase-03-videos/TD-08`).
3. Implementar `abortUpload(userId, videoId)`: valida posse e estado, chama `abortMultipartUpload` e remove o rascunho.
4. Expor `POST /videos/:id/upload/complete` e `DELETE /videos/:id/upload` no controller, com os decorators OpenAPI.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: validação de partes (vazia, duplicada, fora de intervalo), publicação condicionada ao update | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: `complete` real (MinIO + RabbitMQ) transiciona para `processing`, grava `source_size_bytes` e enfileira exatamente uma mensagem; segunda chamada não enfileira de novo | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:id/upload/complete`, `DELETE /videos/:id/upload` | E2E: fluxo completo de upload em duas partes, abort, e códigos de erro | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Enviar duas partes via URLs pré-assinadas e chamar `complete` retorna `200` com `status: "processing"` e persiste `source_size_bytes` igual ao tamanho real do objeto.
- Chamar `complete` duas vezes com a mesma lista de partes retorna `200` nas duas, mas deixa exatamente **uma** mensagem na fila.
- `complete` com `parts: []` retorna `400` com `errorCode: "INVALID_UPLOAD_PARTS"`.
- `complete` sobre um vídeo que já está em `processing` sem `upload_id` retorna `409` com `errorCode: "UPLOAD_NOT_OPEN"`.
- `DELETE /videos/:id/upload` retorna `204`, remove o registro e faz um `complete` posterior do mesmo `upload_id` falhar no storage.

---

### SI-03.8 — Adapter FFmpeg: metadados e thumbnail

**Description:** Encapsular as duas invocações de FFmpeg num adapter tipado, sem wrapper de terceiros, aceitando tanto caminho local quanto URL HTTP como entrada (per `phase-03-videos/TD-05` + `TD-06`).

**Technical actions:**

1. Criar `src/videos/processing/ffmpeg.types.ts` — tipos do JSON do `ffprobe` (`format`, `streams`) e o tipo de saída `ProbedMetadata { duration_seconds, format_name, bit_rate, width, height, video_codec, audio_codec }`.
2. Criar `src/videos/processing/ffmpeg.service.ts` com `probe(input)`: `spawn('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', input])`, com timeout, coleta de stdout/stderr e erro contendo o stderr quando o exit code não é zero.
3. Implementar `extractThumbnail(input, atSeconds)`: `spawn('ffmpeg', ['-nostdin','-ss',String(atSeconds),'-i',input,'-frames:v','1','-vf','scale=1280:-2','-f','image2','-y',tmpPath])`, devolvendo o buffer do JPEG e removendo o arquivo temporário no `finally`.
4. Implementar `thumbnailTimestamp(durationSeconds)` — 10% da duração com piso de 1s (per `phase-03-videos/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `thumbnailTimestamp` | Unit: 10% da duração, piso de 1s, duração ausente | `src/videos/processing/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration (binários reais): `probe` de um arquivo gerado por `ffmpeg` devolve duração/dimensões corretas; `extractThumbnail` devolve JPEG válido; input inexistente rejeita com o stderr do FFmpeg | `src/videos/processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `probe` de um MP4 de 3 segundos e 320x240 devolve `duration_seconds ≈ 3`, `width = 320`, `height = 240` e `video_codec` preenchido.
- `extractThumbnail` devolve um buffer cujos dois primeiros bytes são a assinatura JPEG (`0xFF 0xD8`).
- `probe` de um caminho inexistente rejeita com uma mensagem que contém o texto de erro emitido pelo `ffprobe`.
- `thumbnailTimestamp(60)` é `6`; `thumbnailTimestamp(2)` é `1`.

---

### SI-03.9 — Worker: entrypoint, consumo da fila e atualização de status

**Description:** Colocar o worker de pé como processo separado, consumindo a fila com ack manual, processando o vídeo via FFmpeg contra URL pré-assinada e materializando o ciclo de status, incluindo retry com atraso e falha terminal (per `phase-03-videos/TD-04`, `TD-06`, `TD-08`).

**Technical actions:**

1. Criar `src/worker/worker.module.ts` — importa `ConfigModule` global, `TypeOrmModule.forRootAsync` (mesma factory da API), `TypeOrmModule.forFeature([Video])`, `StorageModule` e os providers de processamento; sem controllers HTTP.
2. Criar `src/worker/main.worker.ts` — `NestFactory.createMicroservice<MicroserviceOptions>(WorkerModule, { transport: Transport.RMQ, options: { urls, queue, queueOptions: VIDEO_QUEUE_OPTIONS, noAck: false, prefetchCount: 1 } })`, declarando a topologia de retry/DLQ antes do `listen()`; e o script `start:worker` no `package.json`.
3. Criar `src/worker/video-processing.controller.ts` — `@EventPattern(VIDEO_PROCESS_PATTERN)` com `@Payload()` e `@Ctx() RmqContext`, fazendo `ack` em todos os caminhos e delegando ao serviço de processamento.
4. Criar `src/worker/video-processing.service.ts` — ignora vídeo fora de `processing` (idempotência), gera URL pré-assinada de GET, chama `probe` + `extractThumbnail`, sobe o thumbnail via `putObject` e grava `duration_seconds`, `metadata`, `thumbnail_key` e `status = 'ready'`.
5. Implementar a política de falha no mesmo serviço: incrementa `processing_attempts`; com `attempt < VIDEO_JOB_MAX_ATTEMPTS` republica o envelope incrementado na fila de retry; esgotadas as tentativas, grava `status = 'failed'` + `processing_error` e publica na DLQ.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: ignora vídeo fora de `processing`; escolhe retry vs. falha terminal conforme o número da tentativa | `src/worker/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (MinIO + FFmpeg reais): vídeo em `processing` vira `ready` com duração, metadados e `thumbnail_key`, e o thumbnail existe no storage | `src/worker/video-processing.service.integration-spec.ts` |
| Política de falha | Integration (RabbitMQ real): objeto corrompido esgota as tentativas, deixa o vídeo em `failed` com `processing_error` e a mensagem na DLQ | `src/worker/video-processing.retry.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.5, SI-03.7, SI-03.8

**Acceptance criteria:**

- Concluir o upload de um MP4 válido leva o vídeo de `processing` para `ready` com `duration_seconds`, `metadata` e `thumbnail_key` preenchidos, sem intervenção manual.
- O objeto de thumbnail existe no storage na chave `thumbnails/{video_id}/thumbnail.jpg` e é um JPEG válido.
- Um vídeo cujo objeto de origem não é decodificável termina em `status = 'failed'` com `processing_error` não vazio, depois de exatamente `VIDEO_JOB_MAX_ATTEMPTS` tentativas.
- Após a falha terminal, existe uma mensagem em `video.processing.dlq` e nenhuma em `video.processing`.
- Entregar duas vezes a mesma mensagem para um vídeo já `ready` não altera o registro nem gera novo thumbnail.

---

### SI-03.10 — Entrega: metadados públicos, streaming e download

**Description:** Expor a URL única do vídeo e as duas rotas de entrega, ambas por redirecionamento para URL pré-assinada de vida curta, mantendo os bytes fora da API (per `phase-03-videos/TD-07`, `TD-09`, `TD-10`).

**Technical actions:**

1. Implementar `findPublicByPublicId(publicId, requesterUserId?)` em `VideosService` — devolve o vídeo `ready` para qualquer um; para o dono do canal devolve qualquer status, incluindo `processing_error`; caso contrário `VIDEO_NOT_FOUND`.
2. Criar `src/videos/dto/video-response.dto.ts` — projeção pública com `public_id`, `title`, `status`, `duration_seconds`, `metadata`, `thumbnail_url` (GET pré-assinado de vida curta) e as URLs de `stream`/`download` da própria API.
3. Implementar `getStreamRedirect(publicId)` e `getDownloadRedirect(publicId)` — geram o GET pré-assinado, o segundo com `response-content-disposition: attachment; filename="<título sanitizado>.<ext>"` assinado na URL.
4. Expor `GET /videos/:public_id`, `GET /videos/:public_id/stream` e `GET /videos/:public_id/download` no controller, os três com `@Public()`, respondendo `302` com `Location` nas duas rotas de entrega.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findPublicByPublicId` | Unit: visibilidade por status e por requisitante (anônimo, autenticado não-dono, dono) | `src/videos/videos.service.spec.ts` |
| Rotas de entrega | E2E: `302` com `Location`; requisição `Range` contra o `Location` devolve `206` + `Content-Range`; download devolve `Content-Disposition: attachment` | `test/videos-delivery.e2e-spec.ts` |
| `GET /videos/:public_id` | E2E: `404` para vídeo não-`ready` visto por anônimo; corpo completo para o dono | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `GET /videos/:public_id` de um vídeo `ready` retorna `200` com `duration_seconds`, `thumbnail_url` e as URLs de stream e download, sem exigir autenticação.
- `GET /videos/:public_id` de um vídeo `processing` retorna `404` para anônimo e `200` com `status: "processing"` para o dono do canal.
- `GET /videos/:public_id/stream` retorna `302` com `Location` apontando para o storage, e a API não transfere nenhum byte do vídeo.
- Uma requisição `Range: bytes=0-1023` contra esse `Location` retorna `206` com `Content-Range` e exatamente 1024 bytes — reprodução começa sem download completo.
- `GET /videos/:public_id/download` retorna `302`, e o alvo responde com `Content-Disposition: attachment` contendo o título do vídeo no nome do arquivo.
- Dois vídeos distintos nunca compartilham `public_id`, e um `public_id` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`.

---

### SI-03.11 — Coerência documental da fase

**Description:** Fechar `IC-1` de `validation.md`: a fila deixou de ser `TBD`, e o repositório ganhou storage, broker e um segundo processo. A documentação de IA e o diagrama precisam refletir o código real.

**Technical actions:**

1. Atualizar `docs/diagrams/software-arch.mermaid` — `ContainerQueue(queue, "Message Queue", "TBD")` passa a nomear RabbitMQ.
2. Atualizar o `CLAUDE.md` da raiz — seção de arquitetura (fila resolvida, worker e storage reais) e uma seção de vídeos descrevendo o fluxo de upload, processamento e entrega.
3. Atualizar `nestjs-project/CLAUDE.md` — novos serviços do Compose, comandos do worker, variáveis de ambiente novas, nota sobre o host das URLs pré-assinadas e o módulo `videos/`.
4. Reexportar `openapi.json` com `npm run openapi:export`, incorporando os endpoints de vídeo (convenção herdada de `openapi-docs-nestjs/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` | Integration: o documento gerado contém os paths de vídeo e o schema de erro | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- Nenhum arquivo de documentação menciona a fila como `TBD`.
- O `CLAUDE.md` da raiz descreve o fluxo de vídeo em termos que batem com os endpoints e os nomes de arquivo realmente existentes.
- `openapi.json` inclui os sete endpoints de vídeo com seus códigos de resposta.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(16) | unique, not null — 11 chars base64url (per `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → `channels(id)`, not null, indexed |
| title | varchar(150) | not null |
| status | enum `videos_status_enum` | not null, default `'draft'` — `draft \| processing \| ready \| failed` (per `phase-03-videos/TD-08`) |
| source_key | varchar(512) | not null — `videos/{id}/source{ext}` (per `phase-03-videos/TD-01`) |
| source_content_type | varchar(150) | not null |
| source_size_bytes | bigint | nullable — preenchido no `complete`; transformer numérico (driver `pg` devolve `bigint` como string) |
| upload_id | varchar(255) | nullable — `uploadId` do multipart enquanto o upload está aberto |
| thumbnail_key | varchar(512) | nullable — `thumbnails/{id}/thumbnail.jpg` |
| duration_seconds | double precision | nullable — preenchido pelo worker |
| metadata | jsonb | nullable — saída destilada do `ffprobe` |
| processing_error | text | nullable — stderr do FFmpeg na falha terminal |
| processing_attempts | smallint | not null, default `0` |
| created_at | timestamp | `@CreateDateColumn` |
| updated_at | timestamp | `@UpdateDateColumn` |

**Relations:** `Channel` has many `Video` (`@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`)
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status`

---

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- title: string, required — 3..150 caracteres
- filename: string, required — usado apenas para derivar a extensão da chave de origem
- content_type: string, required — precisa começar com `video/`
- size_bytes: integer, required — 1..`UPLOAD_MAX_BYTES` (10GiB)

**Response 201:**
- id: string (uuid)
- public_id: string (11 chars)
- status: `"draft"`
- upload: `{ upload_id: string, part_size_bytes: number, total_parts: number }`

**Error responses:**
- 401: token ausente ou inválido
- 404 CHANNEL_NOT_FOUND: usuário autenticado não tem canal
- 413 UPLOAD_TOO_LARGE: `size_bytes` acima do limite
- 415 UNSUPPORTED_MEDIA_TYPE: `content_type` não é de vídeo
- 400 VALIDATION_ERROR: corpo inválido

---

#### POST /videos/:id/upload/parts (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- part_numbers: number[], required — 1..100 itens, cada um em `1..total_parts`

**Response 200:**
- parts: `[{ part_number: number, url: string, expires_in: number }]`

**Error responses:**
- 403 VIDEO_NOT_OWNED: o vídeo não pertence ao canal do requisitante
- 404 VIDEO_NOT_FOUND: `id` inexistente
- 409 UPLOAD_NOT_OPEN: vídeo não está em `draft` com `upload_id`
- 400 INVALID_UPLOAD_PARTS: número de parte fora do intervalo
- 400 VALIDATION_ERROR: corpo inválido

---

#### POST /videos/:id/upload/complete (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- parts: `[{ part_number: number, etag: string }]`, required — não vazio, sem duplicatas

**Response 200:**
- id: string (uuid)
- public_id: string
- status: `"processing"`

**Error responses:**
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_NOT_OPEN: não há multipart aberto para este vídeo
- 400 INVALID_UPLOAD_PARTS: lista vazia, duplicada, fora de intervalo, ou rejeitada pelo storage
- 400 VALIDATION_ERROR

---

#### DELETE /videos/:id/upload (SI-03.7)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 204:** No content.

**Error responses:**
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_NOT_OPEN

---

#### GET /videos/:public_id (SI-03.10)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt; _(opcional — muda a visibilidade, não o acesso)_

**Response 200:**
- public_id: string
- title: string
- status: string
- duration_seconds: number \| null
- metadata: object \| null
- thumbnail_url: string \| null — GET pré-assinado de vida curta
- stream_url: string — `/videos/{public_id}/stream`
- download_url: string — `/videos/{public_id}/download`
- processing_error: string \| null — **apenas** quando o requisitante é o dono do canal

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente, ou vídeo não-`ready` visto por quem não é o dono

---

#### GET /videos/:public_id/stream (SI-03.10)

**Response 302:** `Location` com a URL `GET` pré-assinada do objeto de origem. O storage responde `Accept-Ranges: bytes` e, com header `Range`, `206 Partial Content` + `Content-Range` (per `phase-03-videos/TD-09`). Nenhum byte de vídeo atravessa a API.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente, ou vídeo não-`ready` para quem não é o dono
- 409 VIDEO_NOT_READY: o dono pede stream de um vídeo ainda não processado

---

#### GET /videos/:public_id/download (SI-03.10)

**Response 302:** `Location` com a URL `GET` pré-assinada gerada com `response-content-disposition: attachment; filename="<título sanitizado>.<ext>"` e `response-content-type` (per `phase-03-videos/TD-10`).

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — criação e upload

| Field | Rule | Error message |
|-------|------|---------------|
| title | obrigatório, 3..150 caracteres | title must be longer than or equal to 3 characters |
| filename | obrigatório, não vazio | filename should not be empty |
| content_type | obrigatório, precisa casar `^video/` | content_type must match /^video\// |
| size_bytes | inteiro, mínimo 1, máximo `UPLOAD_MAX_BYTES` | size_bytes must not be greater than 10737418240 |
| part_numbers | array de inteiros, 1..100 itens, cada um ≥ 1 | part_numbers must contain at least 1 elements |
| parts | array não vazio de `{ part_number, etag }` | parts should not be empty |
| parts[].etag | string não vazia | etag should not be empty |

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner (dono do canal) |
|----------|-----------|---------------|------------------------|
| POST /videos | ✗ | ✓ (cria sempre no próprio canal) | ✓ |
| POST /videos/:id/upload/parts | ✗ | ✗ | ✓ |
| POST /videos/:id/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:id/upload | ✗ | ✗ | ✓ |
| GET /videos/:public_id | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (qualquer status) |
| GET /videos/:public_id/stream | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`; senão `409`) |
| GET /videos/:public_id/download | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`; senão `409`) |

As três rotas de entrega usam `@Public()`; as quatro de upload herdam o `JwtAuthGuard` global e verificam posse via `ChannelsService.findByUserId`. Visibilidade por vídeo (público/unlisted) é escopo da Fase 04 e não é antecipada aqui (per `AMB-1` em `validation.md`).

---

### Error Catalog

Formato de resposta herdado da Fase 02 (`phase-02-auth/TD-07`): `{ statusCode, error, message }`, onde `error` carrega o código de domínio.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| CHANNEL_NOT_FOUND | 404 | `POST /videos` de usuário autenticado que não possui canal |
| VIDEO_NOT_FOUND | 404 | `id`/`public_id` inexistente, ou vídeo não-`ready` acessado por quem não é o dono |
| VIDEO_NOT_OWNED | 403 | Operação de upload sobre vídeo de outro canal |
| UPLOAD_TOO_LARGE | 413 | `size_bytes` acima de `UPLOAD_MAX_BYTES` |
| UNSUPPORTED_MEDIA_TYPE | 415 | `content_type` fora do prefixo `video/` |
| UPLOAD_NOT_OPEN | 409 | `parts`/`complete`/`abort` sobre vídeo sem multipart aberto |
| INVALID_UPLOAD_PARTS | 400 | Lista de partes vazia, duplicada, fora de intervalo, ou recusada pelo storage |
| VIDEO_NOT_READY | 409 | Dono pede stream/download de vídeo ainda não processado |
| PUBLIC_ID_GENERATION_FAILED | 500 | Colisão de `public_id` não resolvida após as tentativas |

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "video_id": "uuid", "attempt": 1 }
```

Transportado no envelope do `@nestjs/microservices`: `{ "pattern": "video.process", "data": { ... } }`.

**Producer:** `VideoQueuePublisher` (API, SI-03.5) — `client.emit(VIDEO_PROCESS_PATTERN, payload)` com `await lastValueFrom(...)` (per `phase-03-videos/TD-02`)
**Consumer:** `VideoProcessingController` (worker, SI-03.9) — `@EventPattern` com `noAck: false` e `prefetchCount: 1` (per `phase-03-videos/TD-04`)
**Trigger:** transição `draft → processing` confirmada pelo `UPDATE` condicional em `POST /videos/:id/upload/complete` (per `phase-03-videos/TD-08`)
**Delivery semantics:** at-least-once com ack manual. Idempotência é do consumidor: o handler ignora vídeo que não esteja em `processing` — não há `jobId` para deduplicar no broker (per `phase-03-videos/TD-08`)

**Topologia (SI-03.5):**

| Fila | Argumentos | Papel |
|------|-----------|-------|
| `video.processing` | `durable: true` | Fila principal, asserida pelos dois lados com `VIDEO_QUEUE_OPTIONS` idêntico |
| `video.processing.retry` | `durable: true`, `x-message-ttl: VIDEO_JOB_RETRY_DELAY_MS`, `x-dead-letter-exchange: ''`, `x-dead-letter-routing-key: 'video.processing'` | Backoff pelo broker: a mensagem expira e volta para a fila principal |
| `video.processing.dlq` | `durable: true` | Falha terminal após `VIDEO_JOB_MAX_ATTEMPTS`, para inspeção |

**Retry:** em falha com `attempt < VIDEO_JOB_MAX_ATTEMPTS`, o handler republica o envelope com `attempt + 1` na fila de retry e faz `ack` do original; esgotadas as tentativas, grava `status = 'failed'` + `processing_error`, publica na DLQ e faz `ack`. O atraso é do broker, então sobrevive a restart do worker (per `phase-03-videos/TD-08` e `library-refs.md` → amqplib).

---

## Dependency Map

```
SI-03.1 (root — infra + config)
├── SI-03.2 (StorageService)
├── SI-03.3 (entidade Video + migration)
├── SI-03.5 (contrato da fila)
└── SI-03.8 (adapter FFmpeg)

SI-03.4 (root, independente — lookup de canal)

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6 (POST /videos + part URLs)
    └── SI-03.7 (complete + abort)

SI-03.5 + SI-03.7 + SI-03.8
└── SI-03.9 (worker)
    └── SI-03.10 (entrega: metadados, stream, download)
        └── SI-03.11 (coerência documental)
```

Ordem linearizada de implementação: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.5, SI-03.8 (independentes entre si) → SI-03.6 → SI-03.7 → SI-03.9 → SI-03.10 → SI-03.11

---

## Deliverables

- [ ] SI-03.1 — Infraestrutura de mídia no Compose e namespaces de configuração
- [ ] SI-03.2 — StorageService: cliente MinIO, bootstrap de bucket e layout de chaves
- [ ] SI-03.3 — Entidade `Video`, migration e gerador de `public_id`
- [ ] SI-03.4 — Resolução de canal por usuário no `ChannelsModule`
- [ ] SI-03.5 — Contrato da fila: constantes compartilhadas, publisher e topologia de retry/DLQ
- [ ] SI-03.6 — `POST /videos`: pré-cadastro do rascunho e abertura do upload multipart
- [ ] SI-03.7 — Conclusão e cancelamento do upload
- [ ] SI-03.8 — Adapter FFmpeg: metadados e thumbnail
- [ ] SI-03.9 — Worker: entrypoint, consumo da fila e atualização de status
- [ ] SI-03.10 — Entrega: metadados públicos, streaming e download
- [ ] SI-03.11 — Coerência documental da fase

**Capacidades da fase (rastreadas a `docs/project-plan.md`):**

- [ ] Object storage (MinIO) e broker (RabbitMQ) subindo via `docker compose up -d` junto do backend
- [ ] Worker de vídeo rodando como container separado, consumindo a fila
- [ ] Upload de até 10GB direto ao storage, sem nenhum byte atravessando a API
- [ ] Vídeo pré-cadastrado como `draft` ao iniciar o upload
- [ ] Processamento automático após o upload: duração e metadados extraídos
- [ ] Thumbnail gerado automaticamente a partir de um frame do vídeo
- [ ] `public_id` único por vídeo, com índice único no banco
- [ ] Streaming sem download completo: `302` da API e `206 Partial Content` do storage sob `Range`
- [ ] Download disponível com `Content-Disposition: attachment`
- [ ] Ciclo `draft → processing → ready | failed` refletido no banco, com `processing_error` na falha terminal

**Suítes completas:**

- [ ] Testes de unidade e integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes e2e passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`, código 0)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
