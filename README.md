# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.svg)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails, intermediação do upload de vídeos e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais, tokens de autenticação e vídeos.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Object Storage** (MinIO, compatível com S3) — arquivos de vídeo e thumbnails.
- **Message Queue** (RabbitMQ) — fila de processamento de vídeos, com filas de retry e dead-letter.
- **Video Worker** (FFmpeg) — container separado que consome a fila, extrai duração/metadados e gera o thumbnail. Mesmo código da API, com entrypoint próprio (`src/worker/`).

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit + MinIO + RabbitMQ + Worker)

```bash
cd nestjs-project

# Cria o .env a partir do exemplo (obrigatório — o schema Joi exige as
# credenciais de storage e a URL do RabbitMQ para o app subir)
cp .env.example .env

# Sobe API, banco, Mailpit, object storage, fila e o worker de vídeo
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| MinIO (console) | http://localhost:9001 (user/senha: `streamtube`) — API S3 em `localhost:9000` |
| RabbitMQ (management) | http://localhost:15672 (user/senha: `streamtube`) — AMQP em `localhost:5672` |
| Video Worker | sem porta — consome a fila `video.processing` |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

> O `video-worker` não é o servidor da aplicação: ele é um consumidor de infraestrutura e sobe junto com `docker compose up -d`. Sem ele de pé, os uploads ficam parados em `processing`.
>
> As URLs pré-assinadas são assinadas para o host `minio:9000` (a assinatura SigV4 cobre o host). Isso funciona de dentro da rede do Compose e nos testes; para abrir uma dessas URLs no navegador do host, mapeie `127.0.0.1 minio` no seu arquivo `hosts`.

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

Os testes de integração e e2e usam a **infraestrutura real do Compose** — PostgreSQL, Mailpit, MinIO e RabbitMQ —, então a stack precisa estar de pé antes de rodá-los. Nada de storage ou fila é mockado: presign, upload multipart, `Range`/`206` e serialização de mensagem só se verificam contra os serviços de verdade. Para não disputar mensagens com o `video-worker`, que fica consumindo a fila principal, a suíte publica numa fila própria (`video.processing.test`, definida em `src/test/jest-setup-env.ts`).

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base**, **Fase 02 — Autenticação** (backend + frontend) e **Fase 03 — Upload e Processamento de Vídeos** (backend) estão concluídas.

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Vídeos (Fase 03)

Upload de arquivos de até **10GB**, processamento assíncrono e entrega por streaming. A invariante que desenha todo o resto: **nenhum byte de vídeo atravessa o processo da API** — nem na entrada, nem na saída.

**Upload em 3 chamadas.** A API intermedia um multipart upload do S3 sem nunca receber o arquivo:

1. `POST /videos` pré-cadastra o vídeo como `draft` e abre o multipart; devolve `upload_id`, `part_size_bytes` (8MiB) e `total_parts`.
2. `POST /videos/:id/upload/parts` devolve URLs `PUT` pré-assinadas. O cliente envia cada parte **direto ao object storage** e guarda o `ETag`.
3. `POST /videos/:id/upload/complete` consolida as partes, muda o status para `processing` e publica o job.

**Processamento.** O `video-worker` consome a fila com ack manual, aponta o `ffprobe`/`ffmpeg` para uma **URL pré-assinada** (lê faixas de bytes em vez de baixar 10GB), extrai duração e metadados, corta o thumbnail a 10% da duração e marca o vídeo como `ready`.

**Ciclo de status:** `draft → processing → ready | failed`. Em falha, o job vai para `video.processing.retry`, que devolve a mensagem à fila principal por dead-letter após o TTL — o backoff é do broker, então sobrevive a restart do worker. Esgotadas as tentativas, o vídeo vira `failed` com o stderr do FFmpeg em `processing_error` e a mensagem fica na `video.processing.dlq`.

Endpoints da API:

| Método & Rota | Auth | Descrição |
|---------------|------|-----------|
| `POST /videos` | Dono do canal | Pré-cadastra o rascunho e abre o upload multipart |
| `POST /videos/:id/upload/parts` | Dono | Emite URLs pré-assinadas para um lote de partes |
| `POST /videos/:id/upload/complete` | Dono | Consolida as partes e enfileira o processamento |
| `DELETE /videos/:id/upload` | Dono | Aborta o upload e descarta o rascunho |
| `GET /videos/:public_id` | Público | Metadados do vídeo (o dono também vê os não-prontos) |
| `GET /videos/:public_id/stream` | Público | `302` para URL pré-assinada; o storage serve `Range`/`206` |
| `GET /videos/:public_id/download` | Público | `302` com `Content-Disposition: attachment` assinado |

**URL única:** cada vídeo carrega um `public_id` de 11 caracteres base64url (`node:crypto`, índice único, regeneração em colisão) — curto, opaco e não enumerável.

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── decisions/                       # Decisões técnicas por escopo (research)
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento de vídeos
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11) + worker de vídeo
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── videos/                      # Entidade, upload multipart, entrega, fila
│   │   │   ├── queue/                   # Contrato da fila, publisher e topologia retry/DLQ
│   │   │   └── processing/              # Adapter tipado sobre ffprobe/ffmpeg
│   │   ├── storage/                     # StorageService (MinIO/S3): presign e multipart
│   │   ├── worker/                      # Entrypoint e consumidor do video-worker
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   └── database/                    # data-source, migrations e seeds
│   ├── test/                            # Testes e2e
│   ├── compose.yaml                     # Compose (API, worker, PostgreSQL, Mailpit, MinIO, RabbitMQ)
│   └── Dockerfile.dev                   # Imagem de dev (inclui ffmpeg)
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.svg                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend; a interface de vídeo é da Fase 05) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars) |
| Banco de Dados | PostgreSQL 17 |
| Object Storage | MinIO (compatível com S3), cliente `minio` |
| Fila | RabbitMQ, `@nestjs/microservices` (Transport.RMQ) + `amqplib` |
| Processamento de vídeo | FFmpeg / ffprobe (binários de sistema, invocados via `child_process`) |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
