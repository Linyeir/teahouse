# Teahouse

Self-hostable AI roleplay in the style of a visual novel, with two-tier memory: Active Memory keeps long scenes in the context window, and a canon of Git-versioned Markdown files holds lasting world knowledge.

**Status:** early development, v0.2. Teahouse has worlds as Markdown plus Git, Character Card import, scenes, Active Memory, canon updates reviewed as diffs, a visual novel view with character images and backgrounds, and world export, against any OpenAI-compatible endpoint.

## Visual novel view

The narrator answers in a small tag markup, which the view parses while it streams:

```
<bg id="tavern-night"/>
<narration>Rain drums against the windows.</narration>
<say who="mira" mood="amused">So you came after all.</say>
<leave who="tomas"/>
```

The narrator gets every character of the world with its image labels and the world's backgrounds with their descriptions. The view shows the background, the present characters in the mood of their last line (falling back to `neutral`, any image, then a placeholder) and one line at a time; click, the arrow keys or space step through. **Log** switches to the full text. If the model starts writing a line for you, Teahouse cuts the reply there.

Images are uploaded per character file in the world view, each with a label (`neutral`, `amused`, … or your own), and backgrounds on the world overview with a short description for the narrator. They are stored in `assets/` and listed in the frontmatter. Colors and fonts of the view are theme tokens a world can override; see [docs/theming.md](docs/theming.md).

## Export and sharing

**Export world** on the world overview downloads a `.teahouse.tar.gz` with the world folder (Git history and images included) and its chats. **Import world** on the worlds page restores it; a world that already exists on the server is imported as a copy with new IDs. Profiles and API keys are never part of an export.

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

## Devices and pairing

The password signs in the first device. Further devices can be paired without it: **Settings → Pair a device** shows a QR code, a link and a typeable code. Scan the QR code with the phone's camera (it opens the link in the browser) or enter the code under **Pair with a code instead** on the sign-in screen. A code works once and expires after five minutes.

If the browser shows Teahouse as `localhost`, the pairing panel offers the server's network addresses instead, because a phone cannot reach `localhost`. Behind a reverse proxy or Tailscale, enter the address the phone uses.

Every device has its own token. **Sign out device** revokes it and disconnects the device immediately.

## Apps

The desktop apps (Windows, macOS, Linux) and the Android app are the web client in a [Tauri](https://tauri.app) shell. They connect to your server like a browser does, keep their local copy offline and start without the server.

On first start, an app asks for the server address. Paste a pairing link there (from **Settings → Pair a device** on a signed-in device) to connect and sign in in one go. The Android app can scan the QR code instead.

**Getting the apps:** run the **Apps** workflow on GitHub (Actions → Apps → Run workflow, or push a `v*` tag) and download the artifacts: `.deb`, `.rpm` and AppImage for Linux, `.msi` and `.exe` for Windows, `.dmg` for macOS, and an `.apk` for Android. The APK is a debug build signed with the Android SDK's debug key, so it installs directly once your phone allows apps from unknown sources. The builds are not code-signed, so Windows and macOS warn on first start.

**Building locally** needs Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system:

```sh
pnpm app:dev      # desktop app against the Vite dev server
pnpm app:build    # installers in packages/app/src-tauri/target/release/bundle/
```

For Android, also install the Android SDK and NDK, then run `pnpm --filter @teahouse/app tauri android init` once and `pnpm --filter @teahouse/app tauri android build --debug --apk`.

A server on your LAN can be reached over plain HTTP (the Android debug build allows it explicitly). Use HTTPS (reverse proxy or Tailscale) for anything reachable from the internet.

## Offline and sync

Each device keeps a local copy of the 30 most recent chats in IndexedDB, refreshed whenever it connects. Without the server you can:

- read those chats,
- edit messages of the current scene,
- write one message, which is sent and answered when the server is back (also after closing the app).

Generation, scene changes and switching between versions need the server.

Conflicts are resolved without losing anything. A message written while the chat moved on elsewhere starts a new branch; the other turn stays one swipe away. If two devices edit the same message, the later edit wins and the device that made it shows a warning. A message written for a scene that was closed in the meantime is not sent; its text goes back into the message field.

In a browser, opening Teahouse without the server needs a service worker, which browsers only allow over HTTPS or on `localhost`. The apps work offline either way.

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
pnpm app:dev      # desktop app, see Apps
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
| `TEAHOUSE_CORS_ORIGINS` | – | Extra browser origins allowed to call the API, comma-separated (the Tauri apps are always allowed) |

### Memory test run

`packages/server/eval/` holds reference scenes in YAML: a world, characters, scripted user and narrator turns, and fact questions with expected keywords. The test run plays each scene through the real Active Memory and canon code, with a context window small enough to force summaries, then asks the questions twice: once against the memory summary alone, once against the canon the next scene would get. Narrator turns are scripted, so the score measures memory, not storytelling.

```sh
NODE_USE_ENV_PROXY=1 pnpm --filter @teahouse/server eval:memory -- \
  --model inclusionai/ling-3.1-flash [--base-url http://localhost:1234/v1] [--scenario harbor-deal]
```

It prints a table and writes a Markdown and JSON report to `packages/server/eval/results/` (git-ignored). `--min-score 0.8` makes it exit non-zero below that average. The API key comes from `--api-key`, `TEAHOUSE_EVAL_API_KEY` or `OPENROUTER_API_KEY`.

### Layout

```
packages/
  shared/   API schemas (zod), WebSocket event types, template rendering
  server/   Fastify API, SQLite via Drizzle, OpenAI-compatible adapter (openai SDK),
            worlds (simple-git, chokidar, yaml), card import
  client/   React web app (Vite, TanStack Query, i18next), local copy in IndexedDB
  app/      Tauri 2 shell for desktop and Android around the client
```

After changing `packages/server/src/db/schema.ts`, run `pnpm --filter @teahouse/server db:generate` to create a migration.

## License

[AGPL-3.0](LICENSE)
