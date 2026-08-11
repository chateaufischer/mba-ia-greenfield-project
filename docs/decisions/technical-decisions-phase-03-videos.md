---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-10
scope_description: "Fundação de backend para upload e processamento de vídeos: organização do object storage, fila de processamento em segundo plano, handshake de upload direto ao storage para arquivos de até 10GB, runtime do worker de vídeo, extração de metadados e thumbnail com FFmpeg, URL pública única, ciclo de status, streaming e download."
---

# Decisões Técnicas — Fase 03: Upload e Processamento de Vídeos

_Subprojetos no escopo:_

- `nestjs-project/` — API que pré-cadastra o vídeo, intermedia o upload direto ao storage, publica o job de processamento e serve streaming/download; e também o worker de vídeo, que consome a fila e roda o FFmpeg. Os dois vivem neste subprojeto (o worker é um segundo entrypoint sobre o mesmo código — ver TD-04).
- `next-frontend/` — Frontend diferido: nenhuma tela pertence à Fase 03 (a fase não tem bullet de capacidade com `Tela`/`Página`; a página do player é a `Fase 05 — Página de Visualização do Vídeo`). Nenhuma decisão aberta neste documento. Os contratos do handshake de upload e da entrega que o frontend vai consumir depois são decididos aqui como TDs `Cross-layer`, para que o contrato exista antes da UI.

_Nota sobre consulta de documentação:_ a regra do projeto é confirmar as APIs das bibliotecas via servidor MCP **context7** antes de implementar. O `context7` **não** está registrado no `.mcp.json` deste repositório (só o `postgres`), então a confirmação das bibliotecas desta fase foi feita contra **fontes primárias**, em duas camadas:

1. **Documentação oficial** — `nestjs/docs.nestjs.com` (Techniques → Queues, para o transporte de fila), release notes do BullMQ, guia do AWS SDK for JavaScript v3 e docs do MinIO, usados para avaliar as opções de cada TD.
2. **Declarações de tipo instaladas** — para as bibliotecas efetivamente escolhidas, as assinaturas foram lidas dos `.d.ts` publicados, dentro do container: `node_modules/minio/dist/main/internal/client.d.ts` (multipart + presign), `node_modules/@nestjs/microservices/interfaces/microservice-configuration.interface.d.ts` (`RmqOptions`), `node_modules/@nestjs/microservices/ctx-host/rmq.context.d.ts` (`RmqContext`) e `node_modules/amqplib/index.d.ts`. É a fonte mais precisa possível: é o contrato que o compilador vai cobrar.

As versões foram lidas do registry (`npm view`) de dentro do container `nestjs-api`, não da memória do modelo. Os trechos destilados e as fontes exatas estão em `docs/phases/phase-03-videos/library-refs.md`.

---

## TD-01: Cliente de object storage e organização de buckets/chaves

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O backend de storage em si **não** é decisão aberta — a arquitetura (`docs/diagrams/software-arch.mermaid`, `ContainerDb(storage, "Object Storage", "S3 or MinIO")`) já fixa um store compatível com S3, rodando localmente como MinIO no Compose e trocável por S3 em produção. O que está aberto é *como* a API e o worker falam com ele: qual biblioteca cliente e como os objetos são organizados, de modo que o arquivo de origem de um vídeo, seu thumbnail e futuras renditions possam ser localizados, autorizados e coletados. O layout é um contrato entre componentes: a API escreve as chaves, o worker lê/escreve as chaves e o banco as guarda em colunas `storage_key`.

**Options:**

### Opção A: `@aws-sdk/client-s3` (AWS SDK v3) + um bucket privado com prefixo por vídeo
- SDK oficial da AWS, pacotes modulares, `forcePathStyle: true` + `endpoint` customizado para o MinIO. Um bucket (`streamtube-media`) com `videos/{video_id}/source{ext}` e `thumbnails/{video_id}/thumbnail.jpg`.
- **Pros:** Mesmo código de cliente para MinIO e S3 — só mudam variáveis de ambiente. O presigner vive num pacote irmão (`@aws-sdk/s3-request-presigner`), que TD-03/TD-09/TD-10 todos precisam. O prefixo por vídeo transforma "apagar um vídeo" em delete por prefixo e mantém origem e derivados juntos para regras de lifecycle.
- **Cons:** O comportamento default de checksum do SDK v3 (`requestChecksumCalculation: WHEN_SUPPORTED`) acrescenta `x-amz-sdk-checksum-algorithm` aos headers assinados, ponto de atrito conhecido com servidores S3-compatíveis; exige uma opção explícita no cliente.

### Opção B: `minio` (cliente JS oficial do MinIO) + um bucket privado
- SDK próprio do MinIO, menor e com API mais simples (`presignedPutObject`, `getObject`).
- **Pros:** Superfície bem pequena, helpers de presign de primeira classe, sem as peculiaridades de checksum.
- **Cons:** Amarra o código ao cliente do MinIO num sistema cujo alvo de produção é S3; multipart com URLs pré-assinadas por parte (TD-03) é menos diretamente exposto. Trocar para S3 depois significa reescrever o adapter de storage — o que anula o argumento "mesma API" que motivou escolher um store compatível com S3.

### Opção C: `@aws-sdk/client-s3` + buckets separados por tipo de mídia
- Dois buckets: `streamtube-videos` (privado) e `streamtube-thumbnails` (leitura pública).
- **Pros:** Thumbnails podem ser servidos direto do storage sem assinatura; políticas de lifecycle e ACL por bucket.
- **Cons:** Dois buckets para provisionar e manter em sincronia; um bucket público expõe thumbnails de vídeos `draft`/`unlisted`, o que colide com as regras de visibilidade que chegam na Fase 04. Apagar um vídeo passa a tocar dois buckets.

**Recommendation:** Opção A — um bucket privado com prefixo por vídeo, acessado via `@aws-sdk/client-s3`. Mantém um único adapter de storage que funciona sem alteração contra MinIO (dev) e S3 (prod), que é exatamente o objetivo de escolher um store compatível com S3, e mantém todo objeto privado para que as regras de visibilidade da Fase 04 continuem aplicáveis. A ressalva de checksum é uma opção de uma linha no cliente (`requestChecksumCalculation: 'WHEN_REQUIRED'`), verificada contra o container MinIO real por um teste de integração.

**Decision:** B (cliente `minio` oficial + um bucket privado)
**Libraries:** minio@^8.0.7

**Note:** Decisão divergiu deliberadamente da Recommendation. O cliente `minio@8` cobre integralmente o handshake do TD-03 com API pública e tipada (`initiateNewMultipartUpload`, `presignedUrl('PUT', ..., { uploadId, partNumber })`, `completeMultipartUpload`, `abortMultipartUpload`, `presignedGetObject(..., respHeaders)`), o que remove o principal contra levantado na análise, e elimina de vez o atrito de checksum do AWS SDK v3 com servidores S3-compatíveis. O risco residual — trocar para S3 exige reescrever o adapter — é contido por um único `StorageService` atrás de uma interface, que é o único arquivo a mudar nesse cenário.

---

## TD-02: Tecnologia da fila de processamento em segundo plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O `docs/project-plan.md` e o diagrama de arquitetura deixam a fila explicitamente como `TBD` — esta é a principal decisão de stack da fase. A fila carrega um job por vídeo enviado, da API para o worker (TD-04). Requisitos: um broker real subindo no Compose, retentativa com backoff e um sinal de falha terminal (TD-08), deduplicação de job para que um "upload complete" reenviado não processe duas vezes, e integração de primeira classe com NestJS para que o worker seja um módulo Nest comum.

**Options:**

### Opção A: BullMQ + Redis, via `@nestjs/bullmq`
- Fila baseada em Redis. `BullModule.forRootAsync({ connection })` + `registerQueue({ name })`; o producer injeta `Queue` com `@InjectQueue`, o consumer é uma classe `@Processor('...')` que estende `WorkerHost`.
- **Pros:** Integração NestJS oficialmente documentada (`docs.nestjs.com` → Techniques → Queues usa `@nestjs/bullmq`). `attempts` + `backoff` exponencial embutidos, deduplicação por `jobId`, `job.updateProgress()`, inspeção de jobs atrasados/falhos. Redis é um container pequeno. O consumer roda igual dentro de um processo worker dedicado.
- **Cons:** Acrescenta o Redis como nova dependência de infraestrutura (um container e uma coisa a mais para operar). A persistência do Redis precisa ser configurada (AOF) se perder jobs enfileirados no restart for inaceitável.

### Opção B: `pg-boss` (fila em PostgreSQL)
- Fila de jobs implementada como tabelas na instância PostgreSQL que já existe.
- **Pros:** Zero infraestrutura nova — reaproveita o serviço `db` que já está no Compose. Jobs ficam transacionais com as escritas de domínio (enfileirar na mesma transação que muda o status do vídeo).
- **Cons:** Não tem módulo NestJS oficial (provider e ciclo de vida na mão). Jobs longos de vídeo prendem conexões do banco e somam carga de escrita no banco OLTP principal. O diagrama de arquitetura modela a fila como um **container separado** (`ContainerQueue`), o que uma fila embutida no banco não satisfaz — e o critério de aceite da própria fase exige um serviço de fila real no Compose.

### Opção C: RabbitMQ via `@nestjs/microservices`
- Broker AMQP; o worker é um microservice Nest com handlers `@EventPattern`.
- **Pros:** Broker maduro, roteamento rico, DLQ natural via dead-letter exchanges. A camada de transporte do Nest é oficial.
- **Cons:** A opção mais pesada de operar para uma única fila. `@nestjs/microservices` entrega transporte, não semântica de job — retry/backoff/contagem de tentativas e progresso teriam que ser construídos na mão. Exagerado para um único tipo de job sem fan-out.

**Recommendation:** Opção A (BullMQ + Redis via `@nestjs/bullmq`) — é a única opção que entrega semântica de job (attempts, backoff, dedup por `jobId`, progresso) *e* integração NestJS oficialmente documentada, e satisfaz o "fila como container próprio" da arquitetura. O `pg-boss` é atraente pela história de zero infra, mas colocaria jobs de minutos no banco OLTP e contradiz a topologia modelada. Fixar **`bullmq@^5.81`** em vez de `6.x`: a v6 é um major recente que tornou o backend plugável (Redis *ou* Postgres) e transformou `ioredis` em peer opcional, e a documentação do NestJS e os exemplos do `@nestjs/bullmq` ainda apontam para a API da v5 — a v5 é a versão cujos padrões documentados podem ser seguidos literalmente. O `@nestjs/bullmq@^11.0.5` aceita `bullmq ^3 || ^4 || ^5 || ^6`, então esse pin é suportado.

**Decision:** C (RabbitMQ via `@nestjs/microservices`)
**Libraries:** @nestjs/microservices@^11.1.29, amqplib@^2.0.1, amqp-connection-manager@^5.0.0

**Note:** Decisão divergiu deliberadamente da Recommendation. RabbitMQ é um broker de mensagens de verdade (não um Redis reaproveitado como fila), com topologia declarativa — o que torna retry com atraso e dead-letter uma questão de configuração de fila em vez de mágica de biblioteca — e o transporte é oficial no Nest (`Transport.RMQ`). O contra documentado (semântica de job na mão) é aceito e materializado explicitamente: fila principal + fila de retry com `x-message-ttl` e `x-dead-letter-routing-key` apontando de volta para a principal + DLQ terminal, com o contador de tentativas no envelope da mensagem (ver TD-08). Sem `jobId`, a idempotência passa a ser garantida no handler pela transição condicional de status, não pelo broker.

---

## TD-03: Estratégia de upload de arquivos de até 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Um arquivo de 10GB precisa chegar ao storage sem que a API o segure — os bytes não podem atravessar o processo Node.js, e uma conexão interrompida não pode obrigar a recomeçar do zero. O handshake escolhido é um contrato entre quem faz o upload (o futuro frontend, ou `curl` hoje) e a API, então é decidido uma vez, aqui, como `Cross-layer`.

**Options:**

### Opção A: `multipart/form-data` pela API (Multer / repasse em stream)
- O cliente faz POST do arquivo para a API; a API repassa em stream para o storage.
- **Pros:** Uma única request, cliente trivial. Validação server-side dos bytes reais antes de eles chegarem ao storage.
- **Cons:** Eliminatório. Todo byte atravessa a API: um upload de 10GB ocupa uma instância da API durante toda a transferência, buffer de memória/disco tem que ser calibrado, timeouts de request e limites de body no proxy brigam com a transferência, e uma conexão caída recomeça do zero. É exatamente o modo de falha que a fase existe para evitar.

### Opção B: `PUT` pré-assinado único direto ao storage
- A API devolve uma URL `PUT` pré-assinada; o cliente envia o objeto inteiro numa request.
- **Pros:** A forma mais simples de upload direto. A API não toca em nenhum byte. Dois endpoints no total (emitir URL, confirmar).
- **Cons:** O S3 limita um `PUT` único a 5GB — não consegue nem expressar o requisito de 10GB. Sem retomada: uma falha de TCP em 9GB significa reenviar 9GB.

### Opção C: Multipart upload do S3 com URLs pré-assinadas por parte, intermediado pela API
- `POST /videos` pré-cadastra o vídeo como `draft` e abre um multipart upload (`CreateMultipartUpload`), devolvendo `upload_id` e um lote de URLs `UploadPart` pré-assinadas. O cliente faz `PUT` das partes (5MiB–5GiB cada) direto no storage e coleta o `ETag` de cada parte. `POST /videos/:id/upload/complete` envia `[{part_number, etag}]`; a API chama `CompleteMultipartUpload`, muda o status e enfileira o job de processamento. `DELETE /videos/:id/upload` aborta (`AbortMultipartUpload`).
- **Pros:** Bytes nunca tocam a API. Suporta até 10.000 partes → 10GB sobra. Retentativa por parte dá retomada de graça, e as partes podem ir em paralelo. `AbortMultipartUpload` limpa partes órfãs. A API mantém controle total de autorização (só ela pode emitir URLs de parte).
- **Cons:** Handshake de três chamadas, então o cliente fica mais complexo (fatiar partes, coletar ETags, ordenar). Uploads incompletos deixam partes no storage até serem abortados ou expirados por regra de lifecycle.

### Opção D: Protocolo `tus` de upload retomável (`@tus/server`)
- Protocolo padronizado de retomada; um endpoint tus termina os uploads e empurra para o storage via seu S3 store.
- **Pros:** A melhor semântica de retomada da categoria, negociação de offset, clientes de browser maduros (Uppy).
- **Cons:** Os bytes passam pelo endpoint tus — isto é, pelo nosso próprio processo — a menos que se implante um serviço tus separado, o que é um container inteiro fora da arquitetura modelada. Acrescenta um protocolo (e uma dependência) que o resto da stack não fala.

**Recommendation:** Opção C (multipart pré-assinado intermediado pela API) — a única opção que satisfaz "10GB" e "sem travar o sistema" ao mesmo tempo, mantendo a autorização na API e sem acrescentar container. A complexidade extra no cliente é o custo honesto do upload direto ao storage, e é o mesmo handshake de três chamadas que o frontend vai implementar numa fase futura. O tamanho de parte é fixado em **8MiB** (10GB ⇒ 1.280 partes, bem dentro do teto de 10.000) e o `MAX_UPLOAD_BYTES` é validado no `POST /videos`, antes de qualquer URL ser emitida.

**Decision:** C (multipart S3 pré-assinado intermediado pela API)
**Libraries:** minio@^8.0.7

---

## TD-04: Runtime do worker de vídeo

**Scope:** Backend

**Capability:** Transversal — covers: `Serviço de processamento em segundo plano (filas)`, `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** A arquitetura modela o worker como um container próprio (`Container(worker, "Video Worker", "FFmpeg")`). Trabalho de FFmpeg é intenso em CPU e I/O e não pode competir com o atendimento HTTP. O que está aberto é *onde o código do worker vive* e *como ele sobe* — isso determina se entidades, configuração e o adapter de storage são compartilhados ou duplicados, e como fica a topologia do Compose.

**Options:**

### Opção A: Consumer registrado dentro do processo da API
- A classe `@Processor` é provider do `VideosModule` da API; o mesmo processo serve HTTP e drena a fila.
- **Pros:** Nenhuma unidade de deploy extra. Nada a duplicar.
- **Cons:** O FFmpeg saturaa a máquina que hospeda o event loop e compete com o atendimento de requests; escalar o worker significa escalar a API. Contradiz a topologia modelada, e o critério de aceite da fase exige um serviço worker no Compose.

### Opção B: Container separado, mesmo código, entrypoint dedicado
- Um segundo serviço no Compose (`video-worker`), construído a partir de uma imagem com `ffmpeg` instalado, subindo `src/worker/main.worker.ts` via `NestFactory.createApplicationContext(WorkerModule)` — sem listener HTTP. O `WorkerModule` importa os mesmos providers de config, TypeORM e storage que a API.
- **Pros:** Isolamento real de processo com zero duplicação de código: entidades, `StorageService`, namespaces de config e o nome da fila são literalmente os mesmos módulos. Escalável e reiniciável de forma independente. `createApplicationContext` evita subir controllers/guards que o worker não precisa. Só a imagem do worker carrega a camada do FFmpeg.
- **Cons:** Um segundo Dockerfile/target e um segundo entrypoint para manter; um erro de wiring de módulo só aparece no boot do worker (mitigado por um teste de compilação de módulo).

### Opção C: Projeto standalone separado (`video-worker/`)
- Um terceiro subprojeto com `package.json` próprio, entidades TypeORM próprias e cliente de storage próprio.
- **Pros:** Independência máxima; poderia ser escrito em outra linguagem.
- **Cons:** Duplica entidades, ciência das migrations, configuração e código de storage — duas fontes de verdade para o formato da tabela `videos`. O maior risco de divergência pelo menor benefício nesta escala, e fragmenta o layout de monorepo que o projeto já estabeleceu.

**Recommendation:** Opção B — um serviço `video-worker` no Compose, construído a partir do mesmo código de `nestjs-project/`, com entrypoint exclusivo de worker. Entrega o isolamento de processo que a arquitetura pede mantendo exatamente uma definição da entidade `Video`, do adapter de storage e do contrato da fila. O FFmpeg é instalado apenas na imagem do worker (`Dockerfile.worker`), mantendo a imagem da API enxuta.

**Decision:** B (container separado, mesmo código, entrypoint de worker)
**Libraries:** —

**Revisions:**
- 2026-08-11 — Em desenvolvimento, `video-worker` e `nestjs-api` compartilham a mesma imagem (`Dockerfile.dev`, que passa a incluir `ffmpeg`), diferindo apenas pelo `command`. O `Dockerfile.worker` separado fica adiado. Rationale: o repositório não tem nenhuma imagem de produção hoje (`Dockerfile.dev` é a única, e "ambiente de produção e deploy" é escopo declarado da Fase 07), então uma segunda imagem só de dev seria peso morto; e o comando canônico de teste do projeto roda em `nestjs-api`, que precisa dos binários para exercitar o adapter FFmpeg contra o real (TD-11) em vez de mocá-lo. A decisão de fundo — worker como **processo/container separado**, com o mesmo código e sem listener HTTP — permanece intacta; o que mudou foi de qual Dockerfile a imagem dele vem em dev.

---

## TD-05: Extração de metadados e geração de thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** O worker precisa ler a duração e metadados técnicos (container/format, largura, altura, codecs, bitrate, tamanho) e extrair um frame como thumbnail JPEG. O FFmpeg é fixado pelo diagrama de arquitetura; o que está aberto é como o Node o aciona e de onde vêm os binários.

**Options:**

### Opção A: Wrapper `fluent-ffmpeg`
- API JS encadeável sobre o CLI do FFmpeg (`.screenshots()`, `.ffprobe()`).
- **Pros:** API ergonômica, receitas conhecidas para thumbnail, converter callback em promise é fácil.
- **Cons:** O pacote está praticamente sem manutenção há anos (releases paradas, issues abertas sobre flags modernas do FFmpeg); ele ainda invoca os mesmos binários, então compra sintaxe ao preço de uma dependência abandonada no caminho crítico. As superfícies de erro vêm embrulhadas, dificultando logar o stderr do próprio FFmpeg.

### Opção B: `child_process.spawn` direto de `ffprobe`/`ffmpeg` do sistema, atrás de um adapter fino e tipado
- `ffprobe -v error -print_format json -show_format -show_streams <input>` parseado num tipo; `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale=... -f image2 <out.jpg>` para o frame. Binários instalados via `apt-get install ffmpeg` na imagem do worker.
- **Pros:** Nenhuma dependência abandonada. Controle total sobre as flags e sobre o stderr para diagnóstico. A saída JSON do `ffprobe` é um contrato estável e documentado, que mapeia direto na coluna de metadados da entidade. Trivialmente testável em unidade fingindo a fronteira do spawn, e testável em integração contra os binários reais no container do worker.
- **Cons:** Arrays de argumento, exit codes, timeouts e parsing de saída escritos à mão (~100 linhas). Exige que os binários existam na imagem — binário ausente é falha em runtime (coberta por um smoke test do worker).

### Opção C: `ffmpeg-static` + `ffprobe-static` como pacotes npm
- Binários entregues como pacotes npm; nada instalado no SO.
- **Pros:** A imagem não precisa de camada apt; versões fixadas no `package.json`.
- **Cons:** Acrescenta ~80MB ao `node_modules` de toda instalação, incluindo a da API; downloads específicos por plataforma complicam o build; e os builds empacotados podem não ter codecs/filtros que o build da distro tem. A imagem da API carregaria binários que nunca usa.

**Recommendation:** Opção B — invocar o `ffprobe`/`ffmpeg` da distro atrás de um adapter pequeno e tipado. Evita trazer um pacote sem manutenção para o caminho mais propenso a falha da fase, mantém o stderr do FFmpeg disponível para o campo `processing_error` (TD-08) e confina os binários à imagem do worker. O frame do thumbnail é tirado a **10% da duração detectada** (piso de 1s), para ser representativo em vez de um primeiro frame preto, e escalado para largura 1280 preservando a proporção.

**Decision:** B (spawn de `ffprobe`/`ffmpeg` do sistema atrás de adapter tipado)
**Libraries:** — (binários `ffmpeg`/`ffprobe` instalados via apt na imagem)

**Revisions:**
- 2026-08-11 — Os binários passam a ser instalados na imagem de desenvolvimento compartilhada (`Dockerfile.dev`), não só numa imagem exclusiva do worker. Rationale: consequência direta da revisão de TD-04 — em dev há uma imagem só, e o adapter FFmpeg precisa ser testado contra os binários reais a partir do comando de teste canônico (`docker compose exec nestjs-api npm test`), o que TD-11 exige. O argumento original de "manter a imagem da API enxuta" continua válido para as imagens de produção, que a Fase 07 vai definir.

---

## TD-06: Como o worker lê o arquivo de origem

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** O objeto de origem vive no storage e pode ter 10GB. O `ffprobe` precisa do header do container (início do arquivo) e o `ffmpeg -ss` precisa de um ponto de seek. Como o worker alcança esses bytes decide a pegada de disco do container do worker e quanto tempo um job dura — e é uma bifurcação genuína, não detalhe de implementação: as duas opções têm modos de falha e requisitos de infraestrutura diferentes.

**Options:**

### Opção A: Baixar o objeto inteiro para arquivo temporário e rodar o FFmpeg local
- `GetObject` em stream para `os.tmpdir()`, FFmpeg lê o caminho local, temporário removido num `finally`.
- **Pros:** Mais simples e mais robusto — o FFmpeg recebe um arquivo real e seekável, então todo demuxer e filtro se comporta normalmente. Sem dependência de suporte a range no storage.
- **Cons:** Exige até 10GB de disco livre por job concorrente (uma restrição rígida de capacidade no container do worker), e o arquivo inteiro é transferido mesmo que só alguns MB sejam lidos. O tempo total do job passa a ser dominado pelo download.

### Opção B: Rodar o FFmpeg direto contra uma URL `GET` pré-assinada
- O worker emite um `GET` pré-assinado de vida curta e passa a URL como input do FFmpeg; o protocolo HTTP do FFmpeg faz range requests e busca apenas os bytes de que precisa.
- **Pros:** Nenhum requisito de disco local e transferência drasticamente menor — ler um header e um keyframe de um arquivo de 10GB move megabytes, não gigabytes. O tempo do job desaba.
- **Cons:** Depende do store honrar range requests (S3 e MinIO honram). O tempo de vida da URL pré-assinada precisa exceder a duração do job. Alguns containers exóticos forçam o FFmpeg a varrer fundo no arquivo, então no pior caso a transferência se aproxima do objeto inteiro. Soluços de rede aparecem como erro de I/O do FFmpeg em vez de falha limpa de download.

### Opção C: Híbrido — URL com range, caindo para download completo em caso de falha
- Tenta a B; em falha de I/O do FFmpeg, cai para a A dentro da mesma tentativa do job.
- **Pros:** O melhor dos dois, com pior caso limitado.
- **Cons:** Dois caminhos de código e duas taxonomias de erro para testar, por causa de um fallback que deveria ser raro; o requisito de capacidade de disco da A volta de qualquer forma, então a restrição não é removida de fato.

**Recommendation:** Opção B — FFmpeg contra uma URL `GET` pré-assinada. Ler um header e um frame não justifica mover 10GB nem provisionar 10GB de disco de scratch por job concorrente, e tanto S3 quanto MinIO servem ranges. A vida da URL pré-assinada é derivada do timeout do job (1h) para que não expire no meio, e o modo de falha já está coberto pelas retentativas do BullMQ mais o status terminal `failed` do TD-08. A Opção C fica documentada como escape se algum formato real de container forçar.

**Decision:** B (FFmpeg contra URL `GET` pré-assinada)
**Libraries:** —

---

## TD-07: Estratégia de URL pública única do vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador público curto e sem colisão, usado em URLs do tipo `/videos/{id}` (`docs/project-plan.md` → Pontos de Atenção: "cada vídeo precisa de uma URL curta e única que nunca conflite com outro"). O identificador aparece no banco (coluna única), em toda rota de entrega e no que o frontend vai linkar — um contrato entre componentes.

**Options:**

### Opção A: Usar o UUID v4 da chave primária na URL
- `/videos/9f8c1e2a-....`
- **Pros:** Zero coluna extra, zero código extra, colisão impossível.
- **Cons:** 36 caracteres — não é a "URL curta" que o plano pede. Expõe a chave primária em URLs públicas, acoplando identidade interna e identidade pública para sempre.

### Opção B: Coluna `public_id` curta e aleatória (11 chars, alfabeto base64url), índice único, retry em colisão
- Gerado com `crypto.randomBytes(8).toString('base64url')` → 11 caracteres URL-safe ≈ 64 bits de entropia. Índice único; na (astronomicamente rara) violação de unicidade, regenera e tenta de novo, espelhando o padrão de retry de nickname que já existe no `ChannelsService`.
- **Pros:** Curto, opaco e não adivinhável (à prova de enumeração, o que importa para a visibilidade `unlisted` da Fase 04). Desacoplado da PK, então a identidade interna pode mudar sem quebrar links. Sem dependência nova: `crypto` é nativo.
- **Cons:** Uma coluna extra, um índice extra e algumas linhas de lógica de retry.

### Opção C: `nanoid`
- Mesma ideia, entregue por biblioteca.
- **Pros:** Alfabeto e gerador conhecidos e auditados.
- **Cons:** O `nanoid@5` é ESM-only e este projeto compila para CommonJS (`tsconfig` com `module: nodenext`, sem `"type": "module"`), então exigiria fixar a linha legada `3.x` ou um shim de import dinâmico — uma dependência e um risco de build por ~3 linhas de `crypto`.

### Opção D: Sqids / Hashids — codificação reversível de uma PK numérica
- Codifica um id inteiro sequencial numa string curta.
- **Pros:** Curto, sem coluna extra armazenada (derivável nos dois sentidos).
- **Cons:** Reversível e portanto enumerável — conhecido o alfabeto, ids vizinhos são adivinháveis, o que quebra `unlisted` na Fase 04. Também exige uma chave surrogate numérica, que o projeto não usa (PKs UUID em tudo).

**Recommendation:** Opção B — uma coluna `public_id` de 11 caracteres base64url a partir de `crypto.randomBytes(8)`, com índice único e gerar-e-tentar-de-novo em violação. É curta, não adivinhável, sem dependência e consistente com o padrão de colisão de nickname já existente; e por ser opaca não precisará ser revisitada quando a Fase 04 introduzir vídeos `unlisted`.

**Decision:** B (`public_id` base64url de 11 chars via `node:crypto`, índice único + retry)
**Libraries:** — (`node:crypto`, nativo)

---

## TD-08: Ciclo de status do vídeo e tratamento de falha no processamento

**Scope:** Backend

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** A linha do vídeo é criada antes de seus bytes existirem e é mutada por dois atores diferentes (a API nos eventos de upload, o worker nos eventos de processamento). O conjunto de estados, quem pode transicioná-los e o que acontece quando o FFmpeg falha são um contrato compartilhado entre a entidade, a migration, os guards de entrega e a configuração de retry da fila.

**Options:**

### Opção A: Quatro estados — `draft → processing → ready | failed` — com retentativas e registro de falha terminal
- `draft` no `POST /videos` (pré-cadastro, sem bytes ainda); `processing` quando o multipart upload é completado e o job é enfileirado; `ready` quando o worker persistiu duração, metadados e chave do thumbnail; `failed` depois que o BullMQ esgota `attempts` (3, backoff exponencial), guardando o erro do FFmpeg em `processing_error`. Os endpoints de entrega só servem `ready`.
- **Pros:** Corresponde ao texto do próprio plano ("rascunho → processando → pronto/erro") com o mínimo de estados. Todo estado é observável no banco, então o ciclo é diretamente testável. Um vídeo `failed` mantém sua linha e seu diagnóstico, então pode ser reprocessado ou reportado em vez de desaparecer.
- **Cons:** Não distingue "enviando" de "cadastrado mas intocado", então um upload abandonado fica `draft` para sempre até um job de limpeza (fora do escopo aqui) recolhê-lo.

### Opção B: Cinco estados — acrescentar um `uploading` explícito entre `draft` e `processing`
- `draft` no pré-cadastro, `uploading` quando a primeira URL de parte é emitida.
- **Pros:** Distingue abandonado-antes-de-começar de abandonado-no-meio, o que um futuro coletor poderia usar com timeouts diferentes.
- **Cons:** Um estado que nenhum consumidor lê nesta fase, e a transição não é observável de forma confiável (a API não vê os `PUT` das partes indo direto ao storage), então `uploading` estaria frequentemente errado. Um valor de enum a mais para migrar depois.

### Opção C: Flags booleanas em vez de enum (`is_processed`, `has_error`)
- Duas colunas em vez de uma coluna de estado.
- **Pros:** Nenhum tipo enum para migrar quando estados forem acrescentados.
- **Cons:** Combinações representáveis mas inválidas (`is_processed && has_error`), e nenhum lugar para `draft`. Toda query precisa de predicado composto. Estritamente pior que um enum para um ciclo linear.

**Recommendation:** Opção A — o enum de quatro estados, espelhando o vocabulário do próprio plano, com `attempts: 3` + backoff exponencial no BullMQ e um estado terminal `failed` carregando `processing_error`. O `uploading` é deliberadamente omitido: nada nesta fase o lê e a API não consegue observá-lo de forma confiável, então seria um estado que mente. O `jobId` do job é o UUID do vídeo, o que torna uma chamada duplicada de "complete" idempotente no nível da fila.

**Decision:** A (`draft → processing → ready | failed`, 3 tentativas, `processing_error`)
**Libraries:** —

**Note:** Com RabbitMQ escolhido no TD-02 em vez do BullMQ, os dois mecanismos que o BullMQ daria de graça passam a ser explícitos: (a) **retentativa** — o contador `attempt` viaja no envelope da mensagem; em falha com `attempt < 3` o handler publica o envelope incrementado na fila `video.processing.retry` (`x-message-ttl` + dead-letter de volta para a fila principal, dando backoff sem `setTimeout` em processo) e faz `ack` do original; esgotadas as tentativas, marca o vídeo como `failed` com `processing_error` e publica na `video.processing.dlq`; (b) **idempotência** — sem `jobId` para deduplicar, o `POST /videos/:id/upload/complete` só enfileira quando o `UPDATE` condicional `draft → processing` realmente afeta uma linha, e o handler ignora vídeo que não esteja em `processing`.

---

## TD-09: Estratégia de entrega para streaming

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** A reprodução precisa começar sem baixar o arquivo inteiro, isto é: a fonte dos bytes tem que honrar `Range` HTTP e responder `206 Partial Content`. A pergunta aberta é quem serve esses ranges. O diagrama de arquitetura já contém `Rel(frontend, storage, "Streams", "HTTPS")` — o caminho de dados modelado para os bytes de reprodução vai do cliente **direto ao object storage**, não pela API — então a decisão é honrar esse modelo ou sobrepô-lo.

**Options:**

### Opção A: `302` da API para uma URL `GET` pré-assinada de vida curta; o storage serve os ranges
- `GET /videos/:public_id/stream` autoriza e então redireciona para uma URL pré-assinada (TTL ~1h). O player segue o redirect e emite `Range` requests contra o storage, que responde `206` com `Content-Range`/`Accept-Ranges`.
- **Pros:** Corresponde exatamente à arquitetura modelada. Zero byte de vídeo pela API — uma instância da API atende reprodução concorrente ilimitada. Range/206, requests condicionais e cache vêm de graça do S3/MinIO (e de um CDN em produção, sem mudança). A autorização continua rodando a cada início de reprodução, e a URL expira.
- **Cons:** A API responde `302`, não `206` — a resposta de conteúdo parcial vem do storage, então verificar que "o streaming funciona" significa seguir o redirect. A URL pré-assinada tem forma de bearer: dentro do TTL ela funciona sem access token (mitigado por TTL curto). O endpoint do storage precisa ser alcançável pelo cliente, então o host pré-assinado é uma questão de ambiente (`STORAGE_PUBLIC_ENDPOINT`).

### Opção B: A API faz proxy do range para o storage e reemite `206`
- A API parseia `Range`, emite um `GetObject` com range equivalente e devolve o corpo com `206` + `Content-Range`.
- **Pros:** Origem única (sem CORS, sem URL expirando), autorização por request, e a própria API retorna `206` — a coisa mais simples de asserir num teste HTTP.
- **Cons:** Todo byte reproduzido atravessa a API, dobrando o egress e ocupando um processo Node pela duração da reprodução — a mesma falha de escalabilidade que a fase rejeita para upload, só do lado da leitura. Contradiz `Rel(frontend, storage, "Streams")`. Um CDN na frente cachearia respostas da API em vez de objetos do storage.

### Opção C: HLS/DASH — transcodificar em segmentos + manifest e servir a playlist
- O worker segmenta o vídeo em renditions; o cliente busca um manifest e os segmentos.
- **Pros:** Padrão da indústria para bitrate adaptativo; requests de segmento são pequenos e cacheáveis.
- **Cons:** Exige um pipeline completo de transcodificação (múltiplas renditions, empacotamento, multiplicação de storage), muito além desta fase — o escopo de processamento da Fase 03 é duração/metadados mais um thumbnail. A reprodução progressiva do arquivo original já satisfaz "sem download completo".

**Recommendation:** Opção A — `302` para um `GET` pré-assinado de vida curta, com `Range`/`206` servidos pelo storage. É o que o diagrama de containers do próprio projeto modela, e é a única opção em que um vídeo de 10GB não passa pela API. O trade-off fica explícito nos critérios de aceite do plano: o endpoint retorna `302` com `Location`, e uma request `Range: bytes=0-N` contra esse `Location` retorna `206` com `Content-Range` — ambos assertados ponta a ponta contra o container MinIO real, então "o streaming funciona" é verificado, não presumido. A Opção B fica documentada como alternativa para um deploy que precise manter origem única.

**Decision:** A (`302` para `GET` pré-assinado; storage serve `Range`/`206`)
**Libraries:** minio@^8.0.7

---

## TD-10: Estratégia de entrega para download

**Scope:** Cross-layer

**Capability:** Download do vídeo pelo usuário

**Context:** O usuário precisa poder baixar o arquivo original. Diferente do streaming, um download é por definição a transferência do objeto inteiro, de até 10GB, então o caminho de entrega importa ainda mais. A resposta também precisa fazer o browser salvar o arquivo com um nome sensato em vez de navegar para ele.

**Options:**

### Opção A: `302` para um `GET` pré-assinado carregando overrides de header de resposta
- `GET /videos/:public_id/download` autoriza e então redireciona para uma URL pré-assinada gerada com `ResponseContentDisposition: attachment; filename="<title>.<ext>"` (e `ResponseContentType`), de forma que o próprio storage devolve os headers de anexo.
- **Pros:** Nenhum byte pela API — a única opção em que um download de 10GB custa à API um único `302` pequeno. Retomável e capaz de range porque o storage serve. Reaproveita o caminho do presigner do TD-09, então existe um mecanismo de entrega, não dois. O `Content-Disposition` é assinado dentro da URL e não pode ser adulterado.
- **Cons:** As mesmas considerações de `302`/TTL/`STORAGE_PUBLIC_ENDPOINT` do TD-09; o host do storage aparece na lista de downloads do browser.

### Opção B: A API devolve o objeto em stream com `Content-Disposition: attachment`
- A API repassa o `GetObject` para a resposta.
- **Pros:** Origem única, nome do arquivo definido diretamente, autorização por request para toda a transferência.
- **Cons:** 10GB inteiros passando pelo Node por download — a pior versão do problema de que esta fase trata. Um download concorrente pode inanir a API.

**Recommendation:** Opção A — `302` para um `GET` pré-assinado com `ResponseContentDisposition` assinado. Downloads são inerentemente transferências do objeto inteiro, então mantê-los fora da API é ainda mais importante que no streaming, e reaproveitar o mesmo presigner mantém exatamente um mecanismo de entrega no código. O nome do arquivo é derivado do título do vídeo (sanitizado) mais a extensão de origem.

**Decision:** A (`302` para `GET` pré-assinado com `Content-Disposition` assinado)
**Libraries:** minio@^8.0.7

---

## TD-11: Estratégia de teste de integração com storage e fila

**Scope:** Backend

**Capability:** Transversal — covers: `Serviço de armazenamento de arquivos (vídeos e thumbnails)`, `Serviço de processamento em segundo plano (filas)`, `Processamento automático do vídeo após upload (extração de duração e metadados)`

**Context:** Dois sistemas externos novos entram no projeto nesta fase (object storage e broker de fila). Como eles são representados nos testes é um contrato entre componentes: define o que o `compose.yaml` precisa expor, o que o setup de teste constrói, e se um endpoint/credencial/nome-de-fila errado é pego por teste ou só em produção. Também precisa de decisão explícita porque a skill herdada `testing-guide-nestjs-project` (`references/external-systems.md`) hoje prescreve **filesystem local** para object storage em testes — escrito antes desta fase existir — enquanto a mesma guia prescreve **broker real em Docker** para a fila.

**Options:**

### Opção A: MinIO real + Redis real do Compose nos testes de integração e e2e
- Testes de integração falam com `minio:9000` e `redis:6379` dentro da rede do Compose; prefixos de chave por suíte e `queue.obliterate()`/`drain()` dão isolamento. Testes de unidade continuam mockando na fronteira `StorageService`/`Queue`.
- **Pros:** Exercita de fato o que produção usa: assinatura/path-style/checksum, validade de URL pré-assinada, comportamento de `Range`/`206`, conclusão real de multipart, serialização real de job. São exatamente as classes de bug que um fake não pega — e a justificativa da própria guia para dependências configuradas ("os testes da lib não conseguem verificar a SUA config") se aplica literalmente. Os dois serviços já são exigidos no Compose.
- **Cons:** Testes de integração precisam da stack completa de pé (já é verdade para PostgreSQL e Mailpit). Mais lento que um fake; exige limpeza disciplinada para não haver interferência entre suítes.

### Opção B: Adapter de storage em filesystem local nos testes (como diz a guia herdada) + Redis real
- Uma segunda implementação de `StorageService` escrevendo em `os.tmpdir()`.
- **Pros:** Nenhum container de storage necessário para testes; rápido.
- **Cons:** URLs pré-assinadas, multipart upload e `Range`/`206` — os três mecanismos sobre os quais esta fase é construída — não têm análogo em filesystem, então o adapter ou os fingiria (não provando nada) ou os deixaria sem teste. Também significa manter um segundo adapter cujo único consumidor é a suíte de testes.

### Opção C: Storage e fila em memória/mockados em todos os níveis
- Mocks de Jest para os dois.
- **Pros:** O mais rápido, sem infraestrutura.
- **Cons:** Verifica apenas que nosso código chama nossos mocks. Explicitamente um anti-padrão pela política de testes do projeto ("Não mocke o que dá para testar de verdade com a infra do Compose").

**Recommendation:** Opção A — MinIO real e Redis real do Compose para integração e e2e, mocks apenas no nível de unidade. Isso **supera** a orientação `Object Storage — Local Filesystem` de `testing-guide-nestjs-project/references/external-systems.md`: essa orientação antecede a fase e não consegue exercitar multipart pré-assinado nem range requests, que são os mecanismos centrais da fase. A orientação de fila da guia ("broker real em Docker, asserir jobs enfileirados, submeter um job e asserir o resultado") é adotada como escrita. Isolamento: prefixo de chave por execução no bucket de teste mais limpeza explícita de objetos no `afterAll`, e `drain`/`obliterate` na fila de teste no `beforeEach`.

**Decision:** A (MinIO real + RabbitMQ real do Compose)
**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Cliente de object storage e organização de buckets/chaves | Opção A (`@aws-sdk/client-s3`, um bucket privado, prefixo por vídeo) | B |
| TD-02 | Backend | Tecnologia da fila de processamento em segundo plano | Opção A (BullMQ + Redis via `@nestjs/bullmq`, `bullmq@^5.81`) | C |
| TD-03 | Cross-layer | Estratégia de upload de arquivos de até 10GB | Opção C (multipart S3 pré-assinado intermediado pela API) | C |
| TD-04 | Backend | Runtime do worker de vídeo | Opção B (container separado, mesmo código, entrypoint de worker) | B |
| TD-05 | Backend | Extração de metadados e geração de thumbnail | Opção B (spawn de `ffprobe`/`ffmpeg` do sistema atrás de adapter tipado) | B |
| TD-06 | Backend | Como o worker lê o arquivo de origem | Opção B (FFmpeg contra URL `GET` pré-assinada) | B |
| TD-07 | Backend | Estratégia de URL pública única do vídeo | Opção B (`public_id` base64url de 11 chars via `crypto`, índice único + retry) | B |
| TD-08 | Backend | Ciclo de status do vídeo e tratamento de falha | Opção A (`draft → processing → ready \| failed`, 3 tentativas, `processing_error`) | A |
| TD-09 | Cross-layer | Estratégia de entrega para streaming | Opção A (`302` para `GET` pré-assinado; storage serve `Range`/`206`) | A |
| TD-10 | Cross-layer | Estratégia de entrega para download | Opção A (`302` para `GET` pré-assinado com `Content-Disposition` assinado) | A |
| TD-11 | Backend | Estratégia de teste de integração com storage e fila | Opção A (MinIO real + Redis real do Compose) | A |
