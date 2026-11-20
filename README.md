<p align="center"><img src="assets/icons/svg/teahouse-icon.svg" width="128" height="128" alt=""></p>

# Teahouse

**AI roleplay in the style of a visual novel, with a canon you own.** What happens in your scenes becomes Markdown files in a Git repository on your own server: you review every change as a diff, edit the files with any editor, and keep the whole history.

**Status:** early development. The latest release is [0.4.0](https://github.com/Linyeir/teahouse/releases/tag/v0.4.0), with group chats; see the [changelog](CHANGELOG.md) for what changed. Teahouse runs against any OpenAI-compatible endpoint, as a server with a web client and desktop and Android apps that work offline.

## Quickstart

You need Docker and an LLM endpoint: LM Studio or llama.cpp on your machine, or an OpenRouter key.

1. Save this as `compose.yaml` in an empty folder, and run `docker compose up -d` there:

   ```yaml
   services:
     teahouse:
       image: ghcr.io/linyeir/teahouse:latest
       ports:
         - "8787:8787"
       volumes:
         - teahouse-data:/data
       # Lets the container reach LM Studio or llama.cpp on this machine (needed on Linux).
       extra_hosts:
         - "host.docker.internal:host-gateway"
       restart: unless-stopped

   volumes:
     teahouse-data:
   ```

2. Open http://localhost:8787 and choose a password.
3. Under **Profiles**, add a profile: pick a preset, enter the model (or **Load models**) and, for OpenRouter, the API key. From inside Docker, `localhost` is the container: for LM Studio or llama.cpp on the same machine, use `http://host.docker.internal:1234/v1` or `:8080/v1` (see [Endpoints](#endpoints)).
4. Under **Worlds**, **Import character card** (a PNG or JSON card, V1 to V3) into a new world, or create a **New world** and add a character file in `characters/`.
5. Pick a greeting and **Start chat**, write your first line, and **Send**. The reply streams in.

When the scene is over, **End scene** with canon: Teahouse proposes what to record in the world's files, and you accept, edit or reject each change. Before you open the server to other devices, read [Running the server](#running-the-server).

## Coming from SillyTavern

- **Character Cards** (PNG or JSON, V1 to V3) import as they are: the card becomes a Markdown file in `characters/`, each lorebook entry a file in `lore/`, the card image the character's default image, and the greetings stay greetings. Lorebook logic (secondary keys, `selective`, `constant`, depth, order, recursion) is not carried over: Teahouse picks canon files by their name, aliases and tags within a token budget instead.
- **Chats are scenes.** You end a scene yourself, and its outcome goes into the canon after your review, instead of living only in a long chat log or a summary.
- **One character per LLM call.** In a group, you pick who takes the next turn; the narrator only describes.
- **Endpoints:** OpenAI-compatible chat completion only, no text completion, no ST presets.
- **Not imported yet:** ST chat logs, presets, sprite folders and World Info outside a card ([#99](https://github.com/Linyeir/teahouse/issues/99), [#103](https://github.com/Linyeir/teahouse/issues/103)).
- **Feature parity is not a goal.** Teahouse is an independent project with no shared code; [the concept](docs/concept.md) says what it does differently and why.

## Visual novel view

The narrator answers in a small tag markup, which the view parses while it streams:

```
<bg id="tavern-night"/>
<narration>Rain drums against the windows.</narration>
<say who="mira" mood="amused">So you came after all.</say>
<leave who="tomas"/>
```

Every LLM call plays one character. Above the text field you pick who takes the next turn: a character in the scene, the narrator (who only describes), or anyone else from the world, who then joins the scene. It starts on whoever had the last turn. Leave the field empty and press **Continue** to let them go on without writing anything yourself. **Group chat…** below a world's characters starts a chat with several of them from the start, opened by the greeting you pick.

The narrator gets every character of the world with its image labels and the world's backgrounds with their descriptions. The view shows the background, the present characters in the mood of their last line (falling back to `neutral`, any image, then a placeholder) and one message at a time: the whole reply in one text box, under the name of the character whose turn it was. A long reply scrolls; click, space or Enter read on and then turn to the next message, the arrow keys step between messages. **Log** switches to the full text. If the model starts writing a line for you or for another character, Teahouse cuts the reply there.

Images are uploaded per character file in the world view, each with a label (`neutral`, `amused`, … or your own), and backgrounds on the world overview with a short description for the narrator. They are stored in `assets/` and listed in the frontmatter. Colors and fonts of the view are theme tokens a world can override; see [docs/theming.md](docs/theming.md).

## Scenes and memory

A chat is a sequence of scenes. While a scene runs, **Active Memory** summarizes it in the background once the history reaches 80 % of the budget left after template, canon and response, folding in enough to get back to about 50 %. The scene's start message and the last three turns always stay verbatim. Editing a message that a summary covers drops that summary.

The canon in the prompt gets 30 % of the context window, filled by priority: `world.md`, `user.md` and the present characters, then the last two events of the chat, then files whose tags, aliases or name appear in the recent story, then older events. Over budget, files are cut to their `summary`, then dropped; the first group is never dropped.

When you **end a scene**, you choose with or without canon. With canon, an LLM proposes structured changes (a new `events/` file plus section and frontmatter edits). It reads the files the scene mentions, can look up more where the endpoint supports tool calls, and adds names the scene used for them as aliases. You accept, edit or reject each file as a diff, and the accepted ones become one commit. Files edited in the meantime are merged three-way with `git merge-file`. The next scene starts from a short brief: Teahouse proposes an opening and a cast.

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

## Export and sharing

**Export world** on the world overview downloads a `.teahouse.tar.gz` with the world folder (images included) and its chats. **Import world** on the worlds page restores it with a fresh Git history; a world that already exists on the server is imported as a copy with new IDs. Profiles, API keys and the world's Git repository are never part of an export.

## Running the server

Each release is published as an image for amd64 and arm64: `ghcr.io/linyeir/teahouse:latest`, or a version such as `:0.4` to stay on one line of releases. The repository's [compose.yaml](compose.yaml) is the Quickstart's, with `build: .` to build from a checkout instead. Data lives in the `teahouse-data` volume.

Teahouse speaks plain HTTP. Inside your LAN or a VPN that works; for anything reachable from the internet, put it behind a reverse proxy with HTTPS or Tailscale first. [docs/https.md](docs/https.md) explains the options and what the devices need for each. The server warns at startup when other machines can reach it over plain HTTP.

**Updating:** pull the new image and restart: `docker compose pull && docker compose up -d`. When the new version changes the database, the server first copies it to `backups/teahouse-<time>.db` in the data volume and logs where. The last five copies are kept. To go back to the previous version, stop the server, replace `teahouse.db` with the copy (and delete `teahouse.db-wal` and `teahouse.db-shm`), then start the previous image. Worlds are Git repositories and are not touched by updates.

Apps and server can be updated separately. They check each other's version on connect: when an update changed what they exchange, the app says whether the app or the server has to be updated. **Settings → About** shows both versions.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TEAHOUSE_PORT` | `8787` | HTTP port |
| `TEAHOUSE_HOST` | `0.0.0.0` | Bind address |
| `TEAHOUSE_DATA_DIR` | `./data` | SQLite database and, by default, worlds |
| `TEAHOUSE_WORLDS_DIR` | `<data>/worlds` | World folders |
| `TEAHOUSE_CLIENT_DIR` | `packages/client/dist` | Built web client to serve |
| `TEAHOUSE_CORS_ORIGINS` | – | Extra browser origins allowed to call the API, comma-separated (the Tauri apps are always allowed) |

## Devices and pairing

The password signs in the first device. Further devices can be paired without it: **Settings → Pair a device** shows a QR code, a link and a typeable code. Scan the QR code with the phone's camera (it opens the link in the browser) or enter the code under **Pair with a code instead** on the sign-in screen. A code works once and expires after five minutes.

If the browser shows Teahouse as `localhost`, the pairing panel offers the server's network addresses instead, because a phone cannot reach `localhost`. Behind a reverse proxy or Tailscale, enter the address the phone uses.

Every device has its own token. **Sign out device** revokes it and disconnects the device immediately.

## Apps

The desktop apps (Windows, macOS, Linux) and the Android app are the web client in a [Tauri](https://tauri.app) shell. They connect to your server like a browser does, keep their local copy offline and start without the server.

On first start, an app asks for the server address. On Android 17 and later, the app also asks to access the local network (“Nearby devices”) before it connects to a server at home; without that, Android blocks every connection to the LAN. Paste a pairing link there (from **Settings → Pair a device** on a signed-in device) to connect and sign in in one go. The Android app can scan the QR code instead.

**Getting the apps:** download them from the latest [release](https://github.com/Linyeir/teahouse/releases). Builds of an unreleased state, and building the apps yourself, are described in [CONTRIBUTING.md](CONTRIBUTING.md#apps). The Android APK is a debug build signed with the Teahouse key, so it installs directly once your phone allows apps from unknown sources, and later versions install over it. Version 0.3.0 used a different key and app ID: uninstall it before installing 0.3.1 (let it sync first). The builds are not code-signed, so Windows and macOS warn on first start.

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

From inside Docker, `localhost` is the container. Use `http://host.docker.internal:1234/v1` (the Quickstart's `compose.yaml` sets up `host.docker.internal` on Linux too) or the host's LAN address.

The context window is detected per profile (OpenRouter model metadata, llama.cpp `/props`, LM Studio model info) and can be overridden.

## Contributing

Building, testing, the memory test run and releasing are described in [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as [SECURITY.md](SECURITY.md) describes.

## License

[AGPL-3.0](LICENSE)
