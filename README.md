# Teahouse

Self-hostable AI roleplay in the style of a visual novel, with two-tier memory: Active Memory keeps long scenes in the context window, and a canon of Git-versioned Markdown files holds lasting world knowledge.

**Status:** early development, v0.1 step 1 of 4. Today Teahouse is a plain chat with one character against any OpenAI-compatible endpoint. Worlds, scenes and memory follow. See [the concept](docs/concept.md) for where this is going.

## Run with Docker

```sh
docker compose up -d
```

Open http://localhost:8787, choose a password, then add a profile under **Profiles**. Data lives in the `teahouse-data` volume. Put Teahouse behind a reverse proxy with HTTPS or Tailscale before exposing it.

## Endpoints

Any OpenAI-compatible chat completion endpoint works. Presets exist for:

| Server | Base URL |
|---|---|
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp (`llama-server`) | `http://localhost:8080/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

From inside Docker, `localhost` is the container. Use `http://host.docker.internal:1234/v1` (add `extra_hosts: ["host.docker.internal:host-gateway"]` on Linux) or the host's LAN address.

The context window is detected per profile (OpenRouter model metadata, llama.cpp `/props`, LM Studio model info) and can be overridden.

## Development

Requires Node.js 22.18+ (24 recommended) and pnpm.

```sh
pnpm install
pnpm dev          # server on :8787, client on :5173 with API proxy
pnpm test         # all packages
pnpm lint         # Biome
pnpm typecheck
```

`OPENROUTER_API_KEY` enables live adapter tests against OpenRouter (model: `TEAHOUSE_TEST_MODEL`, default `inclusionai/ling-3.1-flash`).

| Variable | Default | Purpose |
|---|---|---|
| `TEAHOUSE_PORT` | `8787` | HTTP port |
| `TEAHOUSE_HOST` | `0.0.0.0` | Bind address |
| `TEAHOUSE_DATA_DIR` | `./data` | SQLite database (later also worlds and assets) |
| `TEAHOUSE_CLIENT_DIR` | `packages/client/dist` | Built web client to serve |

### Layout

```
packages/
  shared/   API schemas (zod), WebSocket event types, template rendering
  server/   Fastify API, SQLite via Drizzle, OpenAI-compatible adapter (openai SDK)
  client/   React web app (Vite, TanStack Query, i18next)
```

After changing `packages/server/src/db/schema.ts`, run `pnpm --filter @teahouse/server db:generate` to create a migration.

## License

[AGPL-3.0](LICENSE)
