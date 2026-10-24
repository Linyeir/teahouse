# Contributing

How to build, test and release Teahouse. For what Teahouse is and how to run it, see the
[README](README.md); for where it is going, [the concept](docs/concept.md) and the
[milestones](https://github.com/Linyeir/teahouse/milestones). Security issues go through
[SECURITY.md](SECURITY.md), not the issue tracker.

## Development

Requires Node.js 24 or later (`.nvmrc`) and pnpm.

```sh
pnpm install
pnpm dev          # server on :8787, client on :5173 with API proxy
pnpm test         # all packages
pnpm lint         # Biome (pnpm format fixes what it can)
pnpm typecheck
pnpm app:dev      # desktop app, see Apps
```

`OPENROUTER_API_KEY` (or `TEAHOUSE_LIVE_TESTS=1` where a proxy injects the key) enables live adapter tests against OpenRouter (model: `TEAHOUSE_TEST_MODEL`, default `inclusionai/ling-3.1-flash`).

Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set. Set it when the server or the tests must reach endpoints through an HTTP proxy.

The server's environment variables are listed in the README under [Configuration](README.md#configuration).

Changes that people who run Teahouse notice get an entry in [CHANGELOG.md](CHANGELOG.md) under the unreleased version, with a link to the issue.

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

### Memory test run

`packages/server/eval/` holds reference scenes in YAML: a world, characters, scripted user and narrator turns, and fact questions with expected keywords. The test run plays each scene through the real Active Memory and canon code, with a context window small enough to force summaries, then asks the questions twice: once against the memory summary alone, once against the canon the next scene would get. Narrator turns are scripted, so the score measures memory, not storytelling.

```sh
NODE_USE_ENV_PROXY=1 pnpm --filter @teahouse/server eval:memory -- \
  --model inclusionai/ling-3.1-flash [--base-url http://localhost:1234/v1] [--scenario harbor-deal]
```

It prints a table and writes a Markdown and JSON report to `packages/server/eval/results/` (git-ignored). `--min-score 0.8` makes it exit non-zero below that average. The API key comes from `--api-key`, `TEAHOUSE_EVAL_API_KEY` or `OPENROUTER_API_KEY`.

## Apps

**Building locally** needs Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system:

```sh
pnpm app:dev      # desktop app against the Vite dev server
pnpm app:build    # installers in packages/app/src-tauri/target/release/bundle/
```

For Android, also install the Android SDK and NDK, then run `pnpm --filter @teahouse/app tauri android init` once, followed by `packages/app/src-tauri/android/overlay.sh`, which adds the app's icons and its trust in CAs installed on the phone to the generated project, and build with `pnpm --filter @teahouse/app tauri android build --debug --apk`.

**Testing on Android:** `pnpm --filter @teahouse/app e2e:android <path to a debug APK>` runs the end-to-end test in `packages/app/e2e/android.ts` on an attached emulator with Android 17 or later and a `google_apis` image (it needs `adb root`). It covers the local network permission and a server with a certificate from a private CA, and starts its own server on ports 8787 and 8443. The Apps workflow runs it on every build.

**Unreleased builds:** run the **Apps** workflow on GitHub (Actions → Apps → Run workflow) and download the artifact for your system: `teahouse-linux-appimage` (any Linux distribution), `teahouse-linux-deb` (Debian, Ubuntu), `teahouse-linux-rpm` (Fedora, openSUSE), `teahouse-windows` (`.msi` and `.exe`), `teahouse-macos` (`.dmg`) or one of `teahouse-android-arm64` (current phones), `teahouse-android-arm` (older phones) and `teahouse-android-x86_64` (emulators, Chromebooks).

## Releasing

Set the version with `pnpm version:set 0.3.2`, which writes it into every `package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock` (`pnpm version:check` lists them, and CI fails when they differ), and starts a section for it in [CHANGELOG.md](CHANGELOG.md). Note there what changed for people who run Teahouse as you go, especially anything they have to do when updating, and replace `unreleased` with the date before releasing.

Merge, then push `main` to the `release` branch: `git push origin main:release`. The Apps workflow builds everything and creates a draft release named after the version, for example `v0.3.2`, with all files attached and the version's section of the changelog as release notes (GitHub's generated notes if there is none). Further pushes with the same version update the draft. If that version is already published, the workflow fails, so bump the version first. For a hotfix to an older version, branch from its tag.

The Android build needs the signing key in the repository secret `ANDROID_KEYSTORE_BASE64` (base64 of the keystore) and fails without it. Lint, typecheck, tests and the Android end-to-end test must pass too. Check the draft under Releases and publish it, which also creates the tag and starts the Docker workflow, which pushes the server image to `ghcr.io/linyeir/teahouse`.

If a release changes the API, the WebSocket events or the sync format in a way older apps or servers cannot handle, also raise `API_VERSION` in `packages/shared/src/version.ts`. An app that finds a server with a different number does not connect to it and says which of the two to update. Additions that older counterparts can ignore do not need it.
