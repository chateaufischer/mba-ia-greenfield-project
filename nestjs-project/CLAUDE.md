# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** healthcheck `mc ready local`; console at `http://localhost:9001` (user/password `streamtube`)
- **RabbitMQ:** healthcheck `rabbitmq-diagnostics -q ping`; management UI at `http://localhost:15672` (user/password `streamtube`)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

**Exception — `video-worker`.** The worker is not the application server: it is an infrastructure consumer that must be draining the queue for uploads to ever finish processing. It starts with `docker compose up -d` like the other services (`command: npm run start:worker:dev`) and stays up.

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — consumidor da fila de processamento de vídeo; mesma imagem e mesmo código da API, sem porta publicada
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — object storage compatível com S3, API `9000`, console `9001`, user/password `streamtube`
- `rabbitmq` — broker da fila, AMQP `5672`, management `15672`, user/password `streamtube`
- `mailpit` — captura de SMTP, `1025` / UI `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run start:worker:dev                 # Video worker (watch) — já é o command do serviço video-worker
npm run start:worker                     # Video worker a partir do build em dist/

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

### Two entrypoints, one codebase

`src/main.ts` boots the HTTP API (`AppModule`). `src/worker/main.worker.ts` boots the video worker (`WorkerModule`) as a pure RMQ microservice — no HTTP listener, no guards, no Swagger. Both share entities, config namespaces, `StorageService` and the queue contract; the worker container differs only by `command`.

`WorkerModule` declares its entities **explicitly** (`[User, Channel, Video]`) instead of using `autoLoadEntities`: it only calls `forFeature([Video])`, and `Video` relates to `Channel`, which relates to `User` — without the full set, TypeORM cannot build the relation metadata and the worker fails to boot.

### Videos module (`src/videos/`)

| Path | Role |
|------|------|
| `entities/video.entity.ts` | Tabela `videos`, ligada ao canal; enum de status, chaves de storage, metadados |
| `videos.service.ts` | Handshake de upload, transições de status, URLs de entrega |
| `videos.controller.ts` | 7 endpoints: 4 de upload (autenticados, ownership) + 3 de entrega (`@Public()`) |
| `public-id.util.ts` | `public_id` de 11 chars base64url |
| `queue/` | Constantes compartilhadas do contrato de fila, publisher e topologia retry/DLQ |
| `processing/ffmpeg.service.ts` | Adapter tipado sobre `ffprobe`/`ffmpeg` (spawn direto, sem wrapper) |
| `../storage/` | `StorageService` — único ponto de contato com o object storage |
| `../worker/` | Entrypoint, módulo, controller de evento e serviço de processamento do worker |

O fluxo completo (upload → processamento → entrega) está descrito no `CLAUDE.md` da raiz, seção "Videos".

### Presigned URLs e o host que as assina

A assinatura SigV4 cobre o host, então uma URL assinada para `minio:9000` **não** vale em `localhost:9000`. `STORAGE_ENDPOINT` (interno) e `STORAGE_PUBLIC_ENDPOINT` (o que vai nas URLs entregues ao cliente) são knobs separados; em dev os dois apontam para `minio:9000`, o que faz as URLs valerem de dentro da rede do Compose — inclusive nos testes. Para abrir uma URL assinada no browser do host, mapeie `127.0.0.1 minio` no `hosts` da máquina. Em produção, `STORAGE_PUBLIC_ENDPOINT` aponta para o host público do S3/CDN.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
