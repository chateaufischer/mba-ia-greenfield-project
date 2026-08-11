---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-10T19:39:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-11T19:31:14-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-10T19:39:53-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-10T19:39:53-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-10T19:39:53-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-10T19:39:53-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-10T19:39:53-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição de informações do vídeo, categorias, visibilidade público/unlisted, fluxo de publicação e painel do canal (Fase 04); página do player, contagem de visualizações e sugestões (Fase 05); comentários, likes e inscrições (Fase 06). Transcodificação para múltiplas renditions / HLS não faz parte de nenhuma fase declarada e fica fora.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API + worker de vídeo, ambos no mesmo subprojeto — ver `phase-03-videos/TD-04`).

**Deferred subprojects:** `next-frontend/` — a Fase 03 não tem nenhum bullet de tela; a interface de vídeo entra na Fase 05.

**Sequencing notes:** Depende da Fase 01 (config, TypeORM, Compose) e da Fase 02 (usuário, canal, guard JWT, filtro de exceções de domínio). O vídeo pertence a um canal, então a resolução `user → channel` é pré-requisito direto.

**Neighbors (for boundary detection only):**

- **Fase 02:** Cadastro, Login e Gerenciamento de Conta — entrega usuário, canal 1:1, guard JWT global, contrato de erro.
- **Fase 04:** Gerenciamento de Vídeos e Canal — assume a entidade `Video` desta fase e acrescenta edição, categoria, visibilidade e publicação.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Cliente de object storage e organização de buckets/chaves | decided | B (cliente `minio` oficial + um bucket privado) | minio@^8.0.7 |
| phase-03-videos/TD-02 | phase | Backend | Tecnologia da fila de processamento em segundo plano | decided | C (RabbitMQ via `@nestjs/microservices`) | @nestjs/microservices@^11.1.29, amqplib@^2.0.1, amqp-connection-manager@^5.0.0 |
| phase-03-videos/TD-03 | phase | Cross-layer | Estratégia de upload de arquivos de até 10GB | decided | C (multipart S3 pré-assinado intermediado pela API) | minio@^8.0.7 |
| phase-03-videos/TD-04 | phase | Backend | Runtime do worker de vídeo | decided | B (container separado, mesmo código, entrypoint de worker) | — |
| phase-03-videos/TD-05 | phase | Backend | Extração de metadados e geração de thumbnail | decided | B (spawn de `ffprobe`/`ffmpeg` do sistema atrás de adapter tipado) | — |
| phase-03-videos/TD-06 | phase | Backend | Como o worker lê o arquivo de origem | decided | B (FFmpeg contra URL `GET` pré-assinada) | — |
| phase-03-videos/TD-07 | phase | Backend | Estratégia de URL pública única do vídeo | decided | B (`public_id` base64url de 11 chars via `node:crypto`) | — |
| phase-03-videos/TD-08 | phase | Backend | Ciclo de status do vídeo e tratamento de falha | decided | A (`draft → processing → ready \| failed`, 3 tentativas) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Estratégia de entrega para streaming | decided | A (`302` para `GET` pré-assinado; storage serve `Range`/`206`) | minio@^8.0.7 |
| phase-03-videos/TD-10 | phase | Cross-layer | Estratégia de entrega para download | decided | A (`302` para `GET` pré-assinado com `Content-Disposition` assinado) | minio@^8.0.7 |
| phase-03-videos/TD-11 | phase | Backend | Estratégia de teste de integração com storage e fila | decided | A (MinIO real + RabbitMQ real do Compose) | — |

_Source files:_

- `phase-03-videos` — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

_Correlated ad-hoc docs considered:_ dos 4 documentos ad-hoc com `related_phases: []` no repositório, apenas `openapi-docs-nestjs` foi incluído (relevância alta — a fase expõe endpoints HTTP novos, que herdam o contrato de documentação OpenAPI). Os outros três (`next-frontend-config-base`, `next-frontend-msw-foundation`, `next-frontend-openapi-typing`) são exclusivos do subprojeto frontend, que está diferido nesta fase — relevância baixa, excluídos.

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-11 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-04, phase-03-videos/TD-11 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-08, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-08 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-10 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Um bucket privado com prefixo por vídeo, acessado via `@aws-sdk/client-s3`. Mantém um único adapter de storage que funciona sem alteração contra MinIO (dev) e S3 (prod), e mantém todo objeto privado para que as regras de visibilidade da Fase 04 continuem aplicáveis.

**Decision note:** decidido **B** (cliente `minio` oficial), divergindo da recomendação. O cliente `minio@8` cobre integralmente o handshake do TD-03 com API pública e tipada (`initiateNewMultipartUpload`, `presignedUrl('PUT', ..., { uploadId, partNumber })`, `completeMultipartUpload`, `abortMultipartUpload`, `presignedGetObject(..., respHeaders)`) e elimina o atrito de checksum do AWS SDK v3 com servidores S3-compatíveis. O acoplamento é contido num único `StorageService` atrás de interface. Layout de chaves mantido: bucket privado único `streamtube-media`, com `videos/{video_id}/source{ext}` e `thumbnails/{video_id}/thumbnail.jpg`.

**Libraries:** minio@^8.0.7

### phase-03-videos/TD-02

**Recommendation:** BullMQ + Redis via `@nestjs/bullmq` — semântica de job pronta (attempts, backoff, dedup por `jobId`, progresso) com integração NestJS oficialmente documentada.

**Decision note:** decidido **C** (RabbitMQ via `@nestjs/microservices`), divergindo da recomendação. Broker de mensagens de verdade com topologia declarativa: retry com atraso e dead-letter viram configuração de fila (`x-message-ttl` + `x-dead-letter-routing-key`) em vez de comportamento de biblioteca. O custo aceito é a semântica de job na mão — contador de tentativas no envelope e idempotência por transição condicional de status (detalhado em TD-08).

**Libraries:** @nestjs/microservices@^11.1.29, amqplib@^2.0.1, amqp-connection-manager@^5.0.0

### phase-03-videos/TD-03

**Recommendation:** Multipart pré-assinado intermediado pela API — a única opção que satisfaz "10GB" e "sem travar o sistema" ao mesmo tempo, mantendo a autorização na API e sem acrescentar container. Handshake de três chamadas: `POST /videos` (pré-cadastro `draft` + `CreateMultipartUpload` + URLs de parte), `PUT` das partes direto no storage pelo cliente, `POST /videos/:id/upload/complete` com `[{part_number, etag}]`. `DELETE /videos/:id/upload` aborta. Parte de **8MiB** (10GB ⇒ 1.280 partes, teto de 10.000) e `MAX_UPLOAD_BYTES` validado antes de emitir qualquer URL.

**Libraries:** minio@^8.0.7

### phase-03-videos/TD-04

**Recommendation:** Um serviço `video-worker` no Compose, construído a partir do mesmo código de `nestjs-project/`, com entrypoint exclusivo de worker (`NestFactory.createMicroservice` sobre `WorkerModule`, sem listener HTTP). Entrega isolamento de processo mantendo exatamente uma definição da entidade `Video`, do adapter de storage e do contrato da fila.

**Libraries:** —

**Revisions:**
- 2026-08-11 — Em dev, `video-worker` e `nestjs-api` compartilham a mesma imagem (`Dockerfile.dev`, agora com `ffmpeg`), diferindo só pelo `command`; o `Dockerfile.worker` separado fica para a Fase 07 (produção/deploy). A decisão de fundo — worker como processo/container separado sobre o mesmo código — permanece.

### phase-03-videos/TD-05

**Recommendation:** Invocar o `ffprobe`/`ffmpeg` da distro atrás de um adapter pequeno e tipado, via `child_process.spawn`. Evita um pacote sem manutenção (`fluent-ffmpeg`) no caminho mais propenso a falha da fase, mantém o stderr do FFmpeg disponível para o campo `processing_error` e confina os binários à imagem do worker. Frame do thumbnail a **10% da duração** (piso de 1s), escalado para largura 1280 preservando proporção.

**Libraries:** — (binários `ffmpeg`/`ffprobe` instalados via apt na imagem)

**Revisions:**
- 2026-08-11 — Binários instalados na imagem de dev compartilhada (`Dockerfile.dev`), para que o adapter seja testado contra o FFmpeg real a partir do comando de teste canônico (`docker compose exec nestjs-api npm test`), como TD-11 exige.

### phase-03-videos/TD-06

**Recommendation:** FFmpeg contra uma URL `GET` pré-assinada. Ler um header e um frame não justifica mover 10GB nem provisionar 10GB de disco de scratch por job concorrente, e tanto S3 quanto MinIO servem ranges. A vida da URL pré-assinada é derivada do timeout do job (1h) para não expirar no meio.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Coluna `public_id` de 11 caracteres base64url a partir de `crypto.randomBytes(8)`, com índice único e gerar-e-tentar-de-novo em violação (mesmo padrão de colisão de nickname do `ChannelsService`). Curta, não adivinhável, sem dependência — e por ser opaca não precisará ser revisitada quando a Fase 04 introduzir vídeos `unlisted`.

**Libraries:** — (`node:crypto`, nativo)

### phase-03-videos/TD-08

**Recommendation:** Enum de quatro estados `draft → processing → ready | failed`, espelhando o vocabulário do plano, com 3 tentativas e backoff, e estado terminal `failed` carregando `processing_error`. `uploading` é deliberadamente omitido: a API não consegue observá-lo de forma confiável (as partes vão direto ao storage), então seria um estado que mente.

**Decision note:** com RabbitMQ (TD-02) no lugar do BullMQ, retentativa e idempotência ficam explícitas: (a) o contador `attempt` viaja no envelope; em falha com `attempt < 3` o handler publica o envelope incrementado em `video.processing.retry` (`x-message-ttl` + dead-letter de volta para a fila principal) e faz `ack` do original; esgotadas as tentativas, marca `failed` com `processing_error` e publica em `video.processing.dlq`; (b) sem `jobId` para deduplicar, o `complete` só enfileira quando o `UPDATE` condicional `draft → processing` afeta uma linha, e o handler ignora vídeo fora de `processing`.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** `302` para um `GET` pré-assinado de vida curta, com `Range`/`206` servidos pelo storage — é o que `Rel(frontend, storage, "Streams")` do diagrama de containers modela, e a única opção em que um vídeo de 10GB não passa pela API. Verificação: o endpoint retorna `302` com `Location`, e uma request `Range: bytes=0-N` contra esse `Location` retorna `206` com `Content-Range` — ambos assertados contra o MinIO real.

**Libraries:** minio@^8.0.7

### phase-03-videos/TD-10

**Recommendation:** `302` para um `GET` pré-assinado com `response-content-disposition` assinado na URL. Downloads são transferências do objeto inteiro, então mantê-los fora da API importa ainda mais que no streaming; reaproveitar o mesmo presigner mantém um único mecanismo de entrega. Nome do arquivo derivado do título (sanitizado) mais a extensão de origem.

**Libraries:** minio@^8.0.7

### phase-03-videos/TD-11

**Recommendation:** MinIO real e RabbitMQ real do Compose para integração e e2e; mocks apenas no nível de unidade. **Supera** a orientação `Object Storage — Local Filesystem` de `testing-guide-nestjs-project/references/external-systems.md`, que antecede a fase e não consegue exercitar multipart pré-assinado nem range requests. Isolamento: prefixo de chave por execução no bucket mais limpeza de objetos no `afterAll`, e purge da fila de teste no `beforeEach`.

**Libraries:** —

## Inherited Decisions Detail

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Decisão: Runtime UI + `openapi.json` exportado e commitado.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida na fase 02 e não compromete consumidores legítimos, já que o `openapi.json` commitado cumpre o papel de spec consultável fora da UI. Exposição controlada por env flag (`SWAGGER_ENABLED`).

**Libraries:** —

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — códigos de erro legíveis por máquina no formato `{ statusCode, error, message }`, com o filtro mapeando exceções de domínio para HTTP. É o contrato de erro herdado por todas as fases seguintes.

**Libraries:** —

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — abordagem documentada do NestJS, alinhada ao uso extensivo de decorators no projeto. DTOs validados por `ValidationPipe` global.

**Libraries:** class-validator@^0.14.x, class-transformer@^0.5.x

### phase-02-auth/TD-02

**Recommendation:** Guards customizados com `@nestjs/jwt` (decisão B, divergente da recomendação original) — `JwtAuthGuard` registrado como `APP_GUARD` global, com opt-out via `@Public()`.

**Libraries:** @nestjs/jwt@^11.0.0

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — fronteiras claras por domínio, injeção tipada via `ConfigType<typeof xxxConfig>`, escalabilidade natural. O roadmap já previa storage como um dos namespaces futuros.

**Libraries:** —

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — integração de primeira classe com `@nestjs/config` via `validationSchema`, coerção nativa de string para número.

**Libraries:** joi@^17.x

## Inherited Conventions

- Config do backend usa `@nestjs/config` com factories nomeadas `registerAs(name, () => ({...}))` — um arquivo por domínio em `src/config/`. _(from phase 01)_
- Variáveis de ambiente são validadas por schema Joi em `src/config/env.validation.ts`, passado a `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config é injetada via `ConfigType<typeof xxxConfig>` e `@Inject(xxxConfig.KEY)`; a mesma factory é importável como função pura fora do DI (ex.: `data-source.ts`). _(from phase 01)_
- Parâmetros de conexão do banco vêm de uma única factory `databaseConfig` — nunca duplicados entre `AppModule` e `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` com `autoLoadEntities: true` e `synchronize: false`; schema evolui só por migration versionada em `src/database/migrations/`. _(from phase 01)_
- Serviços lançam exceções de domínio (`DomainException`) — nunca exceções HTTP do Nest; o `DomainExceptionFilter` global mapeia para `{ statusCode, error, message }`. _(from phase 02)_
- Todo erro de validação sai como `{ statusCode: 400, error: 'VALIDATION_ERROR', message: string[] }` via `ValidationExceptionFilter`. _(from phase 02)_
- `JwtAuthGuard` é `APP_GUARD` global: toda rota é autenticada por padrão e o opt-out é explícito via `@Public()`. O usuário autenticado chega ao controller por `@CurrentUser()` como `JwtPayload { sub, email }`. _(from phase 02)_
- Um módulo por domínio (`src/{domain}/`), com `entities/` e `dto/` como subpastas; o módulo exporta `TypeOrmModule` quando outro módulo precisa dos repositórios. _(from phase 02)_
- Colisão de valor único gerado (nickname) é resolvida com pré-checagem + retry com sufixo aleatório dentro de transação — padrão reaproveitável para o `public_id` do vídeo. _(from phase 02)_
- Sufixos de teste são contrato: `*.spec.ts` (unit, sem I/O), `*.integration-spec.ts` (banco/serviços reais, ao lado do fonte), `*.e2e-spec.ts` (HTTP via supertest, em `test/`). Suítes de integração e e2e rodam com `--runInBand`. _(from phase 02)_
- Todo endpoint é decorado com `@ApiOperation`/`@ApiResponse` e os erros referenciam `ApiErrorEnvelope` via `getSchemaPath`; o `openapi.json` é reexportado e commitado. _(from openapi-docs-nestjs, ad-hoc correlacionado)_
- Convenções exclusivas do slice `phase-02-auth-frontend` (BFF, iron-session, React Hook Form) não são herdadas aqui — `next-frontend/` está diferido nesta fase.

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` não estava inicializado na Fase 01. Resolvido depois no slice `phase-02-auth-frontend`. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | Entregues no slice `phase-02-auth-frontend`. Sem impacto na Fase 03. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _(nenhuma — todos os 9 bullets da Fase 03 são de backend e são entregues nesta fase)_ | — | — | — |

## Testing Requirements

### nestjs-project

Da skill `testing-guide-nestjs-project` (§3 Feature Implementation Checklist), para os tipos de artefato que esta fase produz:

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service com ramificação + DB | Unit (branch logic, repo mockado) + Integration (contrato de DB) |
| Service com dependência de efeito colateral (storage, fila) | Integration com o serviço real capturando (MinIO/RabbitMQ do Compose, per `phase-03-videos/TD-11`) |
| Module com imports configurados | Unit: teste de compilação do módulo |
| Controller | Somente E2E — não escrever unit test |
| DTO | E2E: um teste de wiring de validação por endpoint |
| Guard com lógica interna (ownership) | Unit + E2E |
| Exception Filter | Unit + E2E |

Pontos da guia que esta fase precisa observar explicitamente:

- **Não mockar libs configuradas** — o cliente MinIO e o transporte RMQ são dependências *configuradas*; mocká-las esconde exatamente os bugs (endpoint, credencial, path-style, nome de fila, `queueOptions` divergentes) que esta fase pode introduzir. Ver `phase-03-videos/TD-11`.
- **A orientação `Object Storage — Local Filesystem` de `references/external-systems.md` está superada** por `phase-03-videos/TD-11` para esta fase e as seguintes: presign, multipart e `Range`/`206` não têm análogo em filesystem.
- **Race conditions são "worth testing"** pela própria guia — aqui isso significa: colisão de `public_id`, `complete` duplicado (idempotência) e entrega duplicada de mensagem.
- Isolamento de banco continua por `dataSource.query('DELETE FROM ...')` em ordem reversa de FK; `videos` passa a entrar nessa lista antes de `channels`.
