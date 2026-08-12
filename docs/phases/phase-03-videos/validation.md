---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-11T19:38:25-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-11T19:31:14-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-10T19:39:53-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Arquitetura e CLAUDE.md declaram a fila como TBD; TD-02 fecha em RabbitMQ"
    resolved_by: clarification
  - id: IC-2
    status: resolved
    summary: "Testing guide prescreve filesystem local para storage; TD-11 exige MinIO real"
    resolved_by: phase-03-videos/TD-11
  - id: AMB-1
    status: resolved
    summary: "Bullet de download não diz se exige autenticação"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "'sem impacto na performance' não é verificável como escrito"
    resolved_by: clarification
  - id: DG-1
    status: resolved
    summary: "ChannelsService não expõe lookup por user_id, exigido para vincular vídeo ao canal"
    resolved_by: clarification
  - id: DG-2
    status: resolved
    summary: "Helper cleanAllTables não conhece a tabela videos — quebra suítes por FK"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pendente — cliente de object storage e layout de chaves"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pendente — tecnologia da fila (principal decisão de stack)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pendente — estratégia de upload de até 10GB"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pendente — runtime do worker de vídeo"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pendente — extração de metadados e thumbnail"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pendente — como o worker lê o arquivo de origem"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pendente — estratégia de URL pública única"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pendente — ciclo de status e tratamento de falha"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pendente — estratégia de streaming"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pendente — estratégia de download"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pendente — teste de integração com storage e fila reais"
    resolved_by: phase-03-videos/TD-11
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ — a fase não tem escopo de UI (nenhum bullet de `Tela`/`Página`), então `## UI Inventory` não é emitido em `context.md` e a checagem não se aplica.

## Resolved Issues

- **IC-1** _(resolved_by clarification)_ — `docs/diagrams/software-arch.mermaid` declara `ContainerQueue(queue, "Message Queue", "TBD")` e o `CLAUDE.md` raiz repete "**Message Queue** (TBD) → video processing job queue", enquanto `phase-03-videos/TD-02` fecha a decisão em RabbitMQ. Resolução: nenhuma decisão nova é necessária — o `TBD` era exatamente o que esta fase existia para resolver; a incoerência é documental. Atualizar o diagrama (`"TBD"` → `"RabbitMQ"`), o `CLAUDE.md` raiz e o `nestjs-project/CLAUDE.md` faz parte dos entregáveis desta fase, alocado a um SI de fechamento em vez de ficar como dívida.
- **IC-2** _(resolved_by phase-03-videos/TD-11)_ — `testing-guide-nestjs-project/references/external-systems.md` prescreve *Object Storage — Local Filesystem* para testes ("S3 em produção"), enquanto o escopo da fase exige exercitar upload multipart pré-assinado e `Range`/`206`, que não têm análogo em filesystem. Resolução: `TD-11` decide explicitamente MinIO real do Compose e registra que **supera** aquela orientação a partir desta fase; a orientação de fila da mesma guia (broker real em Docker) é adotada sem alteração. Nenhuma edição na skill é feita por esta fase — a superação está registrada no TD, que é a fonte canônica de decisão.
- **AMB-1** _(resolved_by clarification)_ — o bullet "Download do vídeo pelo usuário" não diz se exige autenticação, e a fronteira com a Fase 05 ("Acesso anônimo à visualização de vídeos", "Botão de download do vídeo") deixava a leitura em aberto. Resolução: nesta fase, `GET /videos/:public_id/stream` e `GET /videos/:public_id/download` são públicos (`@Public()`) para vídeos com status `ready`; endpoints de gestão do upload continuam autenticados e restritos ao dono do canal. Regras de visibilidade por vídeo (público/unlisted) são explicitamente da Fase 04 e não são antecipadas.
- **AMB-2** _(resolved_by clarification)_ — "sem impacto na performance" não é verificável como está escrito. Resolução: operacionalizado em três critérios objetivos, todos observáveis: (i) nenhum byte do arquivo de vídeo atravessa o processo da API — o upload vai direto do cliente ao storage por URL pré-assinada, e stream/download são `302`; (ii) `MAX_UPLOAD_BYTES` = 10GiB validado no pré-cadastro, antes de emitir qualquer URL; (iii) tamanho de parte 8MiB, mantendo 10GB em 1.280 partes (teto do S3: 10.000).
- **DG-1** _(resolved_by clarification)_ — a Fase 03 vincula o vídeo a um canal, mas o `ChannelsService` entregue pela Fase 02 só expõe `createChannel(userId, email)`; não há como resolver `JwtPayload.sub → channel_id`. Resolução: a capacidade de lookup é acrescentada ao `ChannelsModule` (dono do domínio de canal), não ao módulo de vídeos — coerente com o princípio de Single Responsibility do `CLAUDE.md`, que manda extrair para o módulo correto em vez de um módulo criar/consultar entidade de outro domínio. Alocado como ação explícita de SI.
- **DG-2** _(resolved_by clarification)_ — `src/test/create-test-data-source.ts` expõe `cleanAllTables()` com uma lista fixa de tabelas em ordem reversa de FK; ela não conhece `videos`. Como `videos` referencia `channels`, as suítes herdadas passariam a falhar por violação de FK ao limpar `channels` com vídeos presentes. Resolução: incluir `DELETE FROM "videos"` como primeira linha do helper, alocado ao SI que cria a entidade.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 estava `_[pending]_`. Decidido **B** (cliente `minio` oficial + bucket privado único com prefixo por vídeo), divergindo da recomendação (`@aws-sdk/client-s3`); a divergência está registrada como `**Note:**` no próprio TD.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 estava `_[pending]_`. Decidido **C** (RabbitMQ via `@nestjs/microservices`), divergindo da recomendação (BullMQ + Redis); a divergência e o custo aceito (semântica de job na mão) estão registrados como `**Note:**` no TD e detalhados em TD-08.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 estava `_[pending]_`. Decidido **C** (multipart S3 pré-assinado intermediado pela API), conforme recomendação.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 estava `_[pending]_`. Decidido **B** (container separado, mesmo código, entrypoint de worker), conforme recomendação.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 estava `_[pending]_`. Decidido **B** (spawn de `ffprobe`/`ffmpeg` do sistema atrás de adapter tipado), conforme recomendação.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 estava `_[pending]_`. Decidido **B** (FFmpeg contra URL `GET` pré-assinada), conforme recomendação.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 estava `_[pending]_`. Decidido **B** (`public_id` base64url de 11 chars via `node:crypto`, índice único + retry), conforme recomendação.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 estava `_[pending]_`. Decidido **A** (`draft → processing → ready | failed`, 3 tentativas, `processing_error`), conforme recomendação; a nota do TD detalha como retentativa e idempotência são materializadas sobre RabbitMQ.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 estava `_[pending]_`. Decidido **A** (`302` para `GET` pré-assinado; storage serve `Range`/`206`), conforme recomendação.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 estava `_[pending]_`. Decidido **A** (`302` para `GET` pré-assinado com `Content-Disposition` assinado), conforme recomendação.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 estava `_[pending]_`. Decidido **A** (MinIO real + RabbitMQ real do Compose), conforme recomendação; é também o que fecha IC-2.
