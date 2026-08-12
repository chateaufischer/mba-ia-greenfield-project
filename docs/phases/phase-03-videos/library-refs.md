---
libs:
  minio:
    version: "^8.0.7"
    context7_id: null
    source: "typings publicados em node_modules/minio/dist/main/internal/client.d.ts + type.d.ts (lidos no container) + docs oficiais MinIO JS"
    fetched_at: "2026-08-11T17:40:00-03:00"
  "@nestjs/microservices":
    version: "^11.1.29"
    context7_id: null
    source: "typings publicados em node_modules/@nestjs/microservices/**/*.d.ts (lidos no container) + docs.nestjs.com (Microservices → RabbitMQ)"
    fetched_at: "2026-08-11T17:45:00-03:00"
  amqplib:
    version: "^2.0.1"
    context7_id: null
    source: "node_modules/amqplib/index.d.ts + amqp-node.github.io/amqplib/channel_api.html"
    fetched_at: "2026-08-11T17:45:00-03:00"
  amqp-connection-manager:
    version: "^5.0.0"
    context7_id: null
    source: "npm registry (peerDependencies) — dependência de conexão exigida pelo transporte RMQ do Nest"
    fetched_at: "2026-08-11T17:45:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-11T19:31:14-03:00"
---

# phase-03-videos — Library References

Docs destiladas das bibliotecas fixadas nesta fase.

**Procedência (importante).** O `.mcp.json` deste repositório registra apenas o servidor `postgres` — **não há `context7` disponível nesta sessão**, então o campo `context7_id` é `null` de propósito em vez de inventado. A substituição usada é mais forte, não mais fraca: as assinaturas abaixo foram lidas dos **arquivos `.d.ts` efetivamente instalados** dentro do container `nestjs-api`, complementadas pela documentação oficial de cada projeto. Todas as versões vieram de `npm view <pkg> version` executado no container. Se o `context7` for registrado depois, re-rodar `/plan-resolve phase-03-videos` regenera este arquivo pelo caminho canônico.

---

### minio

**Fonte:** `node_modules/minio/dist/main/internal/client.d.ts` (v8.0.7, instalado) — API pública tipada. Cobre `phase-03-videos/TD-01`, `TD-03`, `TD-09`, `TD-10`.

#### Construção do cliente

```typescript
import { Client } from 'minio';

const client = new Client({
  endPoint: 'minio',   // nome do serviço no Compose — nunca 'localhost'
  port: 9000,
  useSSL: false,
  accessKey: '...',
  secretKey: '...',
  region: 'us-east-1',
});
```

`endPoint` é **host sem esquema e sem porta**; porta e TLS são campos separados. O host usado aqui é o mesmo que entra na assinatura das URLs pré-assinadas — ver a nota sobre `STORAGE_PUBLIC_ENDPOINT` no fim desta seção.

#### Bootstrap de bucket (idempotente)

```typescript
if (!(await client.bucketExists(bucket))) {
  await client.makeBucket(bucket, region);
}
```

Assinaturas: `bucketExists(bucketName: string): Promise<boolean>` e `makeBucket(bucketName: string, region?: Region, makeOpts?: MakeBucketOpt): Promise<void>`.

#### Multipart upload com URLs pré-assinadas por parte (TD-03)

As três operações do handshake são **públicas e tipadas** no `client.d.ts`:

```typescript
initiateNewMultipartUpload(bucketName: string, objectName: string, headers: RequestHeaders): Promise<string>   // → uploadId
abortMultipartUpload(bucketName: string, objectName: string, uploadId: string): Promise<void>
completeMultipartUpload(
  bucketName: string,
  objectName: string,
  uploadId: string,
  etags: { part: number; etag?: string }[],
): Promise<{ etag: string; versionId: string | null }>
```

⚠️ **Cuidado documentado:** `initiateNewMultipartUpload` está anotado com `@internal` no docstring, embora seja `public` na classe e apareça no `.d.ts`. É utilizável, mas é o ponto mais frágil da escolha do TD-01 Opção B. Mitigação já decidida: todo o acesso passa por um único `StorageService` atrás de interface — se uma versão futura do `minio-js` reclassificar o método, só esse arquivo muda.

⚠️ **Formato de `etags`:** é `{ part, etag }` — **não** `{ PartNumber, ETag }` (que é a forma do AWS SDK). O `part` é 1-based. Ordenar por `part` crescente antes de chamar.

URL pré-assinada de uma parte — usar o presigner genérico com os query params do multipart:

```typescript
presignedUrl(
  method: string,                                   // 'PUT'
  bucketName: string,
  objectName: string,
  expires?: number | PreSignRequestParams,          // segundos
  reqParams?: PreSignRequestParams,                 // { uploadId, partNumber }
  requestDate?: Date,
): Promise<string>
```

`PreSignRequestParams` é `Record<string, string>` — os valores precisam ser **string** (`String(partNumber)`), não number.

#### GET pré-assinado, com override de headers de resposta (TD-09 / TD-10)

```typescript
presignedGetObject(
  bucketName: string,
  objectName: string,
  expires?: number,
  respHeaders?: PreSignRequestParams,
  requestDate?: Date,
): Promise<string>
```

Para o download (TD-10), os overrides seguem os nomes de query param do S3 e vão **assinados** na URL (não podem ser adulterados pelo cliente):

```typescript
await client.presignedGetObject(bucket, key, 3600, {
  'response-content-disposition': `attachment; filename="${safeName}"`,
  'response-content-type': contentType,
});
```

Para o streaming (TD-09) a URL é gerada sem `respHeaders` — o storage responde `Accept-Ranges: bytes` e, diante de um header `Range`, `206 Partial Content` com `Content-Range`. Não há nada a configurar: o suporte a range é do próprio servidor S3/MinIO.

#### Demais métodos usados

```typescript
putObject(bucketName, objectName, stream: Readable | Buffer | string, size?: number, metaData?: ItemBucketMetadata): Promise<UploadedObjectInfo>
statObject(bucketName, objectName, statOpts?): Promise<BucketItemStat>   // → { size, etag, lastModified, metaData }
getObject(bucketName, objectName, getOpts?): Promise<stream.Readable>
removeObject(bucketName, objectName, removeOpts?): Promise<void>
```

`putObject` é o caminho do worker para gravar o thumbnail (buffer pequeno); `statObject` confirma o tamanho real do objeto depois do `complete`.

#### Nota de ambiente — host das URLs pré-assinadas

A assinatura SigV4 inclui o host, então uma URL assinada para `minio:9000` **não** é válida em `localhost:9000` e vice-versa. Consequência prática:

- `STORAGE_ENDPOINT=minio` (nome do serviço no Compose) é o que a API e o worker usam — regra de Docker networking do `CLAUDE.md`.
- `STORAGE_PUBLIC_ENDPOINT` existe como knob separado para produção (host público do S3/CDN). Em desenvolvimento ele aponta para o mesmo `minio:9000`, o que faz as URLs assinadas funcionarem de dentro da rede do Compose — inclusive nos testes de integração e e2e, que rodam dentro do container. Para abrir uma URL assinada no browser do host, mapear `127.0.0.1 minio` no `hosts` da máquina (documentado no `nestjs-project/CLAUDE.md`).

---

### @nestjs/microservices

**Fonte:** `node_modules/@nestjs/microservices/interfaces/microservice-configuration.interface.d.ts` e `ctx-host/rmq.context.d.ts` (v11.1.29, instalado) + `docs.nestjs.com`. Cobre `phase-03-videos/TD-02`, `TD-04`, `TD-08`.

#### Produtor (API) — `ClientsModule.registerAsync`

```typescript
ClientsModule.registerAsync([
  {
    name: VIDEO_QUEUE_CLIENT,
    inject: [queueConfig.KEY],
    useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
      transport: Transport.RMQ,
      options: {
        urls: [cfg.url],
        queue: cfg.queue,
        queueOptions: VIDEO_QUEUE_OPTIONS,
        persistent: true,
      },
    }),
  },
]),
```

Publicação fire-and-forget de evento:

```typescript
this.client.emit(VIDEO_PROCESS_PATTERN, payload);   // retorna Observable — precisa de subscribe/lastValueFrom
```

⚠️ `emit()` devolve um `Observable` frio: **sem `await lastValueFrom(...)` (ou `.subscribe()`) nada é publicado**. É o erro silencioso mais comum desse transporte.

⚠️ `persistent: true` (default é `false`) é o que marca a mensagem como durável; sem isso a mensagem some no restart do broker mesmo com a fila `durable: true`.

#### Consumidor (worker) — microservice standalone

```typescript
const app = await NestFactory.createMicroservice<MicroserviceOptions>(WorkerModule, {
  transport: Transport.RMQ,
  options: {
    urls: [url],
    queue,
    queueOptions: VIDEO_QUEUE_OPTIONS,
    noAck: false,        // ack manual — obrigatório para a política de retry do TD-08
    prefetchCount: 1,    // um vídeo por vez por worker
  },
});
await app.listen();
```

Campos de `RmqOptions.options` conferidos no `.d.ts` instalado: `urls`, `queue`, `prefetchCount`, `isGlobalPrefetchCount`, `queueOptions`, `socketOptions`, `noAck`, `consumerTag`, `serializer`, `deserializer`, `replyQueue`, `persistent`, `headers`, `noAssert`, `exchange`, `exchangeType`, `exchangeArguments`, `wildcards`.

⚠️ **`queueOptions` tem que ser idêntico nos dois lados.** Produtor e consumidor asseguram a mesma fila; se os argumentos divergirem, o RabbitMQ derruba o canal com `PRECONDITION_FAILED`. Por isso as opções vivem numa constante compartilhada (`VIDEO_QUEUE_OPTIONS`) importada pela API e pelo worker, em vez de literais duplicados.

#### Handler e ack manual

```typescript
@EventPattern(VIDEO_PROCESS_PATTERN)
async handle(@Payload() data: VideoProcessJob, @Ctx() context: RmqContext): Promise<void> {
  const channel = context.getChannelRef();      // canal amqplib (tipo any no .d.ts)
  const message = context.getMessage();         // mensagem original, com content/properties/fields
  // ...
  channel.ack(message);
}
```

`RmqContext` expõe exatamente três métodos: `getMessage()`, `getChannelRef()`, `getPattern()`.

⚠️ `getChannelRef()` é tipado como `any`. Tipar localmente como `Channel` do `amqplib` para não perder checagem — é o padrão adotado no worker.

⚠️ Com `noAck: false`, **toda** saída do handler precisa terminar em `ack`/`nack`. Uma exceção não tratada deixa a mensagem em *unacked* até o canal cair, e aí ela é reentregue em loop. O handler do worker envolve tudo em `try/catch/finally` com ack explícito em todos os caminhos.

#### Envelope da mensagem

O transporte serializa `{ pattern, data }` em JSON. Ao republicar manualmente na fila de retry (TD-08), o envelope precisa ser preservado — senão o servidor Nest não consegue rotear a mensagem que volta pelo dead-letter:

```typescript
const envelope = JSON.parse(message.content.toString());     // { pattern, data }
envelope.data.attempt = attempt + 1;
channel.sendToQueue(retryQueue, Buffer.from(JSON.stringify(envelope)), { persistent: true });
```

---

### amqplib

**Fonte:** `node_modules/amqplib/index.d.ts` (v2.0.1, instalado) + `amqp-node.github.io/amqplib/channel_api.html`. Usado diretamente só para **declarar a topologia** de retry/DLQ; o tráfego normal passa pelo transporte do Nest.

⚠️ **Versão:** a linha atual é `2.x` (o histórico `0.10.x` ficou para trás). A v2 **já traz os próprios tipos** (`"types": "./index.d.ts"` no `package.json`) — **não instalar `@types/amqplib`**, que ainda descreve a API antiga e conflitaria.

```typescript
import { connect, type ChannelModel, type Channel } from 'amqplib';

const connection: ChannelModel = await connect(url);
const channel: Channel = await connection.createChannel();

await channel.assertQueue('video.processing.retry', {
  durable: true,
  arguments: {
    'x-message-ttl': RETRY_DELAY_MS,
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': 'video.processing',
  },
});
await channel.assertQueue('video.processing.dlq', { durable: true });

await channel.close();
await connection.close();
```

Assinaturas conferidas no `.d.ts`: `connect(url, socketOptions?): Promise<ChannelModel>`, `assertQueue(queue?, options?): Promise<Replies.AssertQueue>`, `sendToQueue(queue, content: Buffer, options?): boolean`, `ack(message, allUpTo?): void`, `nack(message, allUpTo?, requeue?): void`, `prefetch(count, global?): Promise<Replies.Empty>`.

**Como o backoff funciona sem timer em processo:** a mensagem publicada na fila de retry não tem consumidor; ela expira por `x-message-ttl` e o broker a encaminha para o `x-dead-letter-exchange` com a routing key configurada — que é a fila principal. O atraso é do broker, então sobrevive a restart do worker. É esse mecanismo que substitui o `backoff` que o BullMQ daria pronto (ver a nota de TD-02/TD-08).

---

### amqp-connection-manager

**Fonte:** registro npm (v5.0.0). `peerDependencies: { amqplib: '*' }`.

Não é usada diretamente pelo código do projeto: é **peer dependency obrigatória** do transporte RMQ do `@nestjs/microservices`, que a usa para reconexão automática. Precisa estar declarada no `package.json` — sem ela o `Transport.RMQ` falha no boot com erro de módulo ausente.

---

### FFmpeg / ffprobe _(binários de sistema — sem pacote npm)_

Não há entrada em `libs:` porque `phase-03-videos/TD-05` decidiu explicitamente **não** usar wrapper npm (`fluent-ffmpeg` está sem manutenção; `ffmpeg-static` inflaria também a imagem da API). Os binários vêm da distro, instalados só na imagem do worker (`Dockerfile.worker`, `apt-get install -y ffmpeg`).

Contratos de CLI usados (documentados em ffmpeg.org):

```bash
# metadados — saída JSON estável, é o contrato consumido pelo adapter
ffprobe -v error -print_format json -show_format -show_streams <input>

# thumbnail — -ss ANTES de -i faz seek rápido por keyframe (input seeking)
ffmpeg -nostdin -ss <seconds> -i <input> -frames:v 1 -vf scale=1280:-2 -f image2 -y <out.jpg>
```

- `-show_format` traz `format.duration` (segundos, string), `format.format_name`, `format.bit_rate`, `format.size`; `-show_streams` traz por stream `codec_type` (`video`/`audio`), `codec_name`, `width`, `height`.
- `-vf scale=1280:-2` preserva a proporção e força altura par (exigência de encoders com subsampling de croma).
- `-nostdin` evita que o FFmpeg tente consumir stdin do processo Node e trave.
- `<input>` pode ser um caminho local **ou uma URL HTTP(S)** — é o que viabiliza `TD-06`: o protocolo HTTP do FFmpeg faz range requests e lê só o necessário. O `-ss` antes do `-i` é o que torna isso barato; depois do `-i` ele decodificaria desde o início.
- Exit code diferente de zero + stderr é o sinal de falha; o stderr capturado alimenta `processing_error` (TD-08).
