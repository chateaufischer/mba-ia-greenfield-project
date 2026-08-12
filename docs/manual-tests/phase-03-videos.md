# Teste manual — Fase 03: Upload e Processamento de Vídeos

Roteiro para exercitar o ciclo completo de vídeo pela API, e o registro de uma execução real.

O que este teste comprova, além de "funciona": que **nenhum byte do arquivo atravessa a API**. O upload vai do cliente direto ao object storage por URL pré-assinada, e a reprodução e o download são `302` para o storage — a API só intermedia o handshake e a autorização.

---

## Pré-requisitos

```bash
cd nestjs-project
cp .env.example .env          # apenas na primeira vez
docker compose up -d          # API, worker, PostgreSQL, MinIO, RabbitMQ, Mailpit
docker compose exec nestjs-api npm install
docker compose exec nestjs-api npm run migration:run
docker compose exec -d nestjs-api npm run start:dev
```

Para usar o Swagger em `http://localhost:3000/api/docs`, defina `SWAGGER_ENABLED=true` no `.env` **antes** de subir o servidor.

Para abrir as URLs pré-assinadas no navegador do host, aponte `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000` no `.env`. A assinatura SigV4 cobre o host, então uma URL assinada para `minio:9000` só vale de dentro da rede do Compose. A suíte de testes fixa o host interno por conta própria (`src/test/jest-setup-env.ts`), então as duas coisas convivem.

> ⚠️ **Não rode `npm test` / `npm run test:e2e` durante o teste manual.** As suítes de integração compartilham o banco de desenvolvimento e executam `DELETE FROM users` a cada teste — seu usuário e seus vídeos desaparecem no meio do caminho.

### Usuário

O caminho real, sem tocar no banco:

1. `POST /auth/register` com e-mail e senha.
2. Abrir **http://localhost:8025** (Mailpit) e clicar no link de confirmação.
3. `POST /auth/login` → guarde o `access_token` (validade de 15 min).

O cadastro cria automaticamente o canal do usuário a partir do prefixo do e-mail — é a esse canal que os vídeos ficam ligados.

---

## Roteiro

### 1. Pré-cadastrar o vídeo e abrir o upload

```http
POST /videos
Authorization: Bearer <access_token>

{
  "title": "ejemplo",
  "filename": "ejemplo.mp4",
  "content_type": "video/mp4",
  "size_bytes": 37691416
}
```

O vídeo nasce como `draft` e a resposta traz o plano de upload. Guarde `id` e `public_id`.

### 2. Pedir as URLs pré-assinadas das partes

```http
POST /videos/{id}/upload/parts
Authorization: Bearer <access_token>

{ "part_numbers": [1] }
```

### 3. Enviar o arquivo direto ao storage

Este passo **não passa pela API** — o `PUT` vai para o MinIO:

```powershell
curl.exe -X PUT --upload-file "C:\caminho\ejemplo.mp4" "<url-da-parte>" -D -
```

Anote o `ETag` do cabeçalho de resposta.

### 4. Concluir o upload

```http
POST /videos/{id}/upload/complete
Authorization: Bearer <access_token>

{ "parts": [ { "part_number": 1, "etag": "\"<etag>\"" } ] }
```

A API consolida as partes, muda o status para `processing` e publica o job na fila. Reenviar a mesma conclusão não enfileira um segundo job.

### 5. Acompanhar o processamento

```http
GET /videos/{public_id}
```

Em poucos segundos o worker devolve `status: "ready"` com `duration_seconds`, `metadata` e `thumbnail_url`.

### 6. Reproduzir (streaming)

```powershell
curl.exe -L -H "Range: bytes=0-1023" "http://localhost:3000/videos/<public_id>/stream" -D - -o NUL
```

A API responde `302`; o storage responde `206 Partial Content` com `Content-Range`.

### 7. Baixar

```http
GET /videos/{public_id}/download
```

`302` para uma URL com `Content-Disposition: attachment` assinado.

---

## Execução registrada — 12/08/2026

Arquivo: `ejemplo.mp4`, 37.691.416 bytes (~35,9 MB), 1min50s.

### 1. `POST /videos`

```json
{
  "id": "a281b827-166c-4dd6-a2ba-8897b4367549",
  "public_id": "Mj97630B234",
  "status": "draft",
  "upload": {
    "upload_id": "Njg3ODA0MjYtM2NlMS00YWQ3LTgwOGItMjc4OTFkZTRhZDM5LjViOTQzMTFjLWM2NGQtNDFjMi1iN2ZmLTIyMThhMWE4YTM3OXgxNzg2NTAxNjM2NDg5NTYwMzQz",
    "part_size_bytes": 8388608,
    "total_parts": 5
  }
}
```

### 2-3. `PUT` da parte direto no MinIO

```
PUT http://localhost:9000/streamtube-media/videos/a281b827-.../source.mp4?partNumber=1&uploadId=...&X-Amz-Signature=...

HTTP/1.1 100 Continue
HTTP/1.1 200 OK
ETag: "aadf55396fd57f5e4d0040918cadcffb"
Server: MinIO
```

O destino do `PUT` é o storage (`localhost:9000`), não a API (`localhost:3000`).

### 4. `POST /videos/{id}/upload/complete`

```json
{
  "id": "a281b827-166c-4dd6-a2ba-8897b4367549",
  "public_id": "Mj97630B234",
  "status": "processing"
}
```

### 5. `GET /videos/Mj97630B234` — depois do worker

```json
{
  "public_id": "Mj97630B234",
  "title": "ejemplo",
  "status": "ready",
  "duration_seconds": 109.916467,
  "metadata": {
    "width": 1280,
    "height": 1006,
    "bit_rate": 2743277,
    "video_codec": "h264",
    "audio_codec": "aac",
    "format_name": "mov,mp4,m4a,3gp,3g2,mj2"
  },
  "thumbnail_url": "http://localhost:9000/streamtube-media/thumbnails/a281b827-.../thumbnail.jpg?X-Amz-Signature=...",
  "stream_url": "/videos/Mj97630B234/stream",
  "download_url": "/videos/Mj97630B234/download"
}
```

Linha correspondente no banco:

| Campo | Valor |
|---|---|
| `status` | `ready` |
| `duration_seconds` | `109.916467` |
| `source_size_bytes` | `37691416` |
| `thumbnail_key` | `thumbnails/a281b827-.../thumbnail.jpg` |
| `processing_attempts` | `1` |
| `processing_error` | *(vazio)* |

Processou na primeira tentativa, sem retry.

### 6. Streaming

```
GET http://localhost:3000/videos/Mj97630B234/stream
HTTP/1.1 302 Found
Location: http://localhost:9000/streamtube-media/videos/a281b827-.../source.mp4?X-Amz-Signature=...

GET <Location>  com  Range: bytes=0-1023
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Length: 1024
Content-Range: bytes 0-1023/37691416
```

1.024 bytes recebidos de um arquivo de 37.691.416 — a reprodução começa sem download completo.

### 7. Download

```
GET <Location do 302 de /download>
HTTP/1.1 200 OK
Content-Disposition: attachment; filename="ejemplo.mp4"
Content-Length: 37691416
```

---

## Observações da execução

- **`total_parts` é um plano, não uma obrigação.** O `POST /videos` calculou 5 partes a partir do tamanho declarado (37,7 MB ÷ 8 MiB), mas o arquivo foi enviado inteiro como parte 1 e a conclusão listou só essa parte. O protocolo multipart do S3 aceita: o objeto final é composto pelas partes que você de fato declarar no `complete`. Para arquivos grandes de verdade, fatiar em várias partes é o que dá paralelismo e retomada.

- **O tamanho gravado é o real, não o declarado.** No `complete` a API lê o tamanho do objeto com `statObject` e sobrescreve o valor informado pelo cliente — por isso `source_size_bytes` bate exatamente com o `Content-Length` do download.

- **Nenhum byte de vídeo passou pela API** em nenhum momento: o upload foi direto para `localhost:9000`, e stream e download são `302` para o mesmo host. A API só emitiu URLs assinadas e mudou status.

- **Thumbnail extraído a 10% da duração** (≈11s de 1min50s), redimensionado para 1280px de largura preservando a proporção.
