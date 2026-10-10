<p align="center"><img src="assets/icons/svg/teahouse-icon.svg" width="128" height="128" alt=""></p>

# Teahouse

Self-hostable AI roleplay in the style of a visual novel, with two-tier memory: Active Memory keeps long scenes in the context window, and a canon of Git-versioned Markdown files holds lasting world knowledge.

**Status:** early development, v0.3. Teahouse has worlds as Markdown plus Git, Character Card import, scenes, Active Memory, canon updates reviewed as diffs, a visual novel view with character images and backgrounds, world export, and desktop and Android apps that work offline, against any OpenAI-compatible endpoint.

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

This builds the image from the checkout. Each release is also published as a ready image for amd64 and arm64, `ghcr.io/linyeir/teahouse:latest` (or a version such as `:0.3`), which you can put in `compose.yaml` as `image:` instead of `build: .`.

Open http://localhost:8787, choose a password, then add a profile under **Profiles**. Data lives in the `teahouse-data` volume. Put Teahouse behind a reverse proxy with HTTPS or Tailscale before exposing it; [docs/https.md](docs/https.md) explains the options and what the devices need for each.

## Devices and pairing

The password signs in the first device. Further devices can be paired without it: **Settings → Pair a device** shows a QR code, a link and a typeable code. Scan the QR code with the phone's camera (it opens the link in the browser) or enter the code under **Pair with a code instead** on the sign-in screen. A code works once and expires after five minutes.

If the browser shows Teahouse as `localhost`, the pairing panel offers the server's network addresses instead, because a phone cannot reach `localhost`. Behind a reverse proxy or Tailscale, enter the address the phone uses.

Every device has its own token. **Sign out device** revokes it and disconnects the device immediately.

## Apps

The desktop apps (Windows, macOS, Linux) and the Android app are the web client in a [Tauri](https://tauri.app) shell. They connect to your server like a browser does, keep their local copy offline and start without the server.

On first start, an app asks for the server address. On Android 17 and later, the app also asks to access the local network (“Nearby devices”) before it connects to a server at home; without that, Android blocks every connection to the LAN. Paste a pairing link there (from **Settings → Pair a device** on a signed-in device) to connect and sign in in one go. The Android app can scan the QR code instead.

**Getting the apps:** download them from the latest [release](https://github.com/Linyeir/teahouse/releases). For an unreleased state, run the **Apps** workflow on GitHub (Actions → Apps → Run workflow) and download the artifact for your system: `teahouse-linux-appimage` (any Linux distribution), `teahouse-linux-deb` (Debian, Ubuntu), `teahouse-linux-rpm` (Fedora, openSUSE), `teahouse-windows` (`.msi` and `.exe`), `teahouse-macos` (`.dmg`) or one of `teahouse-android-arm64` (current phones), `teahouse-android-arm` (older phones) and `teahouse-android-x86_64` (emulators, Chromebooks). The APK is a debug build signed with the Teahouse key, so it installs directly once your phone allows apps from unknown sources, and later versions install over it. Version 0.3.0 used a different key and app ID: uninstall it before installing 0.3.1 (let it sync first). The builds are not code-signed, so Windows and macOS warn on first start.

**Building locally** needs Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system:

```sh
pnpm app:dev      # desktop app against the Vite dev server
pnpm app:build    # installers in packages/app/src-tauri/target/release/bundle/
```

For Android, also install the Android SDK and NDK, then run `pnpm --filter @teahouse/app tauri android init` once, followed by `packages/app/src-tauri/android/overlay.sh`, which adds the app's icons and its trust in CAs installed on the phone to the generated project, and build with `pnpm --filter @teahouse/app tauri android build --debug --apk`.

**Testing on Android:** `pnpm --filter @teahouse/app e2e:android <path to a debug APK>` runs the end-to-end test in `packages/app/e2e/android.ts` on an attached emulator with Android 17 or later and a `google_apis` image (it needs `adb root`). It covers the local network permission and a server with a certificate from a private CA, and starts its own server on ports 8787 and 8443. The Apps workflow runs it on every build.

**Releasing:** set the version in `packages/app/src-tauri/tauri.conf.json` and `Cargo.toml`, turn *Unreleased* in [CHANGELOG.md](CHANGELOG.md) into that version, merge, then push `main` to the `release` branch: `git push origin main:release`. The Apps workflow builds everything and creates a draft release named after the version in `tauri.conf.json`, for example `v0.3.1`, with all files attached. Further pushes with the same version update the draft. If that version is already published, the workflow fails, so bump the version first. For a hotfix to an older version, branch from its tag. The Android build needs the signing key in the repository secret `ANDROID_KEYSTORE_BASE64` (base64 of the keystore) and fails without it. Lint, typecheck, tests and the Android end-to-end test must pass too. Check the draft under Releases and publish it, which also creates the tag and starts the Docker workflow, which pushes the server image to `ghcr.io/linyeir/teahouse`.

A server on your LAN can be reached over plain HTTP. Use HTTPS (reverse proxy or Tailscale) for anything reachable from the internet. The apps trust the certificates the system trusts, including a CA of your own installed on the device (on Android too). If an app cannot connect, it says why and shows the certificate it got. See [docs/https.md](docs/https.md).

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
assets/
  icons/    icon set and the script that generates it (see its README)
```

After changing `packages/server/src/db/schema.ts`, run `pnpm --filter @teahouse/server db:generate` to create a migration.

## License

[AGPL-3.0](LICENSE)
