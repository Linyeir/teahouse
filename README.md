# Teahouse

Self-hostable AI roleplay in the style of a visual novel, with two-tier memory: Active Memory keeps long scenes in the context window, and a canon of Git-versioned Markdown files holds lasting world knowledge.

**Status:** early development, v0.1 step 3 of 4. Teahouse has worlds as Markdown plus Git, Character Card import, scenes, Active Memory and canon updates reviewed as diffs, against any OpenAI-compatible endpoint. The memory test run follows.

## Scenes and memory

A chat is a sequence of scenes. While a scene runs, **Active Memory** summarizes it in the background once the history reaches 80 % of the budget left after template, canon and response, folding in enough to get back to about 50 %. The scene's start message and the last three turns always stay verbatim. Editing a message that a summary covers drops that summary.

The canon in the prompt gets 30 % of the context window, filled by priority: `world.md`, `user.md` and the present characters, then the last two events of the chat, then files whose tags, aliases or name appear in the recent story, then older events. Over budget, files are cut to their `summary`, then dropped; the first group is never dropped.

When you **end a scene**, you choose with or without canon. With canon, an LLM proposes structured changes (a new `events/` file plus section and frontmatter edits); you accept, edit or reject each file as a diff, and the accepted ones become one commit. Files edited in the meantime are merged three-way with `git merge-file`. The next scene starts from a short brief: Teahouse proposes an opening and a cast.

Each role (narrator, summary, canon, scene start) can use its own profile under **Settings**.

## Worlds

A world is a folder of Markdown files with its own Git repository, under `<data>/worlds/`:

```
rain-port/
  world.md        ground rules, tone, setting
  user.md         what the world knows about your persona
  characters/     one file per character
  places/  events/  lore/
  assets/         images (not in Git)
```

Every save in Teahouse is a commit, and so is every edit made directly in the folder, e.g. with Obsidian. Teahouse watches the folders and commits changes after two quiet seconds. Each file has YAML frontmatter (`type`, `name`, `tags`, `aliases`, `summary`; characters also `greetings` and `images`).

Character Cards (PNG or JSON, V1 to V3) import into a new or an existing world: one file in `characters/`, one file in `lore/` per lorebook entry, and the card image as the character's default image. See [the concept](docs/concept.md) for where this is going.

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

`OPENROUTER_API_KEY` (or `TEAHOUSE_LIVE_TESTS=1` where a proxy injects the key) enables live adapter tests against OpenRouter (model: `TEAHOUSE_TEST_MODEL`, default `inclusionai/ling-3.1-flash`).

Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set. Set it when the server or the tests must reach endpoints through an HTTP proxy.

| Variable | Default | Purpose |
|---|---|---|
| `TEAHOUSE_PORT` | `8787` | HTTP port |
| `TEAHOUSE_HOST` | `0.0.0.0` | Bind address |
| `TEAHOUSE_DATA_DIR` | `./data` | SQLite database and, by default, worlds |
| `TEAHOUSE_WORLDS_DIR` | `<data>/worlds` | World folders |
| `TEAHOUSE_CLIENT_DIR` | `packages/client/dist` | Built web client to serve |

### Layout

```
packages/
  shared/   API schemas (zod), WebSocket event types, template rendering
  server/   Fastify API, SQLite via Drizzle, OpenAI-compatible adapter (openai SDK),
            worlds (simple-git, chokidar, yaml), card import
  client/   React web app (Vite, TanStack Query, i18next)
```

After changing `packages/server/src/db/schema.ts`, run `pnpm --filter @teahouse/server db:generate` to create a migration.

## License

[AGPL-3.0](LICENSE)
