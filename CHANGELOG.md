# Changelog

What changed for people who run Teahouse, by version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each release on GitHub uses its section from this file as release notes.

## [0.4.0] - unreleased

**Updating:** apps and server can be updated in any order, but picking who talks needs a 0.4.0 server; with an older one the narrator still plays the whole cast. The server migrates its database (replies get a speaker) and backs it up first. Replies written before keep no speaker; regenerating one plays whoever had the last turn.

### Changed

- Every LLM call now plays one character instead of the whole cast. Above the text field you pick who takes the next turn: a character in the scene, the narrator (who only describes the scene), or another character of the world, who then joins. The choice starts on whoever had the last turn. With the field empty, **Continue** lets that character go on without your input, so several characters can answer in a row. Regenerating a reply keeps its character. ([#40](https://github.com/Linyeir/teahouse/issues/40))
- **Group chat…** below a world's characters, on the chats page and in the world view, starts a chat with several characters present from the start. You pick who is there and whose greeting opens it; the chat is named after them. Others can still join later through the picker.
- The log view shows above each reply whose turn it was.
- The novel view shows a whole message in one text box instead of one line at a time, under the name of the character whose turn it was. Sprites and background show how the message leaves the stage. A long reply scrolls in the box: click, space or Enter read on, then turn to the next message; the arrow keys step between messages. ([#41](https://github.com/Linyeir/teahouse/issues/41))
- If the model starts writing a line for another character, Teahouse cuts the reply there, as it already did for lines written for you.
- At the end of a scene, the canon update reads the full file of every character who had a turn, not only of the cast the scene started with.
- The canon update also reads the files the scene mentions by name, alias or tag, in full or by their summary as far as they fit. Before, it saw them only as one line in an index and could add things that were already there or contradicted them. Files it has not seen in full it only extends, never rewrites. ([#38](https://github.com/Linyeir/teahouse/issues/38))
- When a scene calls a character, place or thing by another name, nickname or title, the canon update suggests it as an alias, so later scenes that use that name bring the file into the prompt. ([#38](https://github.com/Linyeir/teahouse/issues/38))
### Fixed

- A greeting that names its character as `{{char}}` showed the placeholder in the chat. New chats fill in the name when they start, which also keeps the greeting about its own character once others take turns.

## [0.3.4] - 2026-10-11

**Updating:** apps and server can be updated in any order. A 0.3.4 app works with servers from 0.3.0 on; the server itself does not change.

### Added

- The apps can connect to a server through themselves instead of through their web view. Some web views ignore CAs you installed (LineageOS's does, although Android itself trusts them), so the Android app could not reach a server with a certificate from your own CA. When the device trusts a certificate and the web view does not, the app says so and offers "Connect through the app", with the same check Android uses for other apps. Requests, live updates and world images then go through the app. ([#27](https://github.com/Linyeir/teahouse/issues/27))
- A server with a self-signed certificate can be trusted in the apps by its fingerprint: the app shows the fingerprint and the command that prints it on the server, and trusts exactly that certificate once you confirm that they match. Pairing links and QR codes from a device that trusts it carry the fingerprint along. If the server later presents another certificate, the app refuses it and shows both fingerprints; you forget the old one and check the new one. ([#27](https://github.com/Linyeir/teahouse/issues/27))
- Settings → Connection shows whether the app connects through itself or its web view, can switch between them, and lists the certificates you trusted, each with a button to forget it.

### Changed

- On phones, a tab bar at the bottom (Chats, Worlds, Profiles, Settings) replaces the sidebar, which took up to 40% of the screen on every page. Chats lists your chats first, then the characters to start a new one with. A chat fills the whole screen, with a back arrow in its header.
- Character rows on narrow screens show the name and summary on top, and the greeting choice and **Start chat** below. The summary is cut at three lines there.

### Fixed

- The Android app drew under the status bar and the gesture bar (Android 15 and later draw apps edge to edge): the clock sat on top of the title. The app now keeps clear of both, also in landscape. ([#29](https://github.com/Linyeir/teahouse/issues/29))
- On narrow screens the World view squeezed the file list and the overview into the window's height, so they overlapped or were cramped. The page scrolls as a whole again. In a long file list on any screen, the entries no longer shrink. ([#28](https://github.com/Linyeir/teahouse/issues/28))

## [0.3.3] - 2026-10-10

**Updating:** apps and server can be updated in any order. A 0.3.3 app works with 0.3.1 and 0.3.2 servers. On Android 17, the app asks once for access to the local network (Android calls it "Nearby devices"); allow it if your server is at home.

### Added

- When an app cannot reach the server, it says why instead of only "Server unreachable": nothing answers at that address (with the system's reason), a reverse proxy answers but Teahouse behind it does not, a proxy blocks the app (for example by redirecting to a login page), the address does not speak HTTPS, or the device does not trust the server's certificate. For a certificate, the app names the likely cause (expired, issued for another name, self-signed, unknown CA) and shows who it is for, who issued it, how long it is valid and its SHA-256 fingerprint. ([#26](https://github.com/Linyeir/teahouse/issues/26))
- The Android app trusts CAs you installed on the phone, for example from mkcert or step-ca, as the desktop apps already do with the system's certificates. Android shows a "network may be monitored" notice for such a CA; that is expected. ([#26](https://github.com/Linyeir/teahouse/issues/26))
- [docs/https.md](docs/https.md) explains the ways to serve Teahouse over HTTPS: a publicly trusted certificate (Let's Encrypt, `tailscale serve`), your own CA with install steps for Linux, Windows, macOS and Android, or plain HTTP inside your LAN or VPN.

### Fixed

- On Android 17 the app could not reach a server on the local network at all, because Android 17 blocks it until the user allows it. The app now asks before it first connects to a server at home. If you decline, it says why it is offline and offers to allow it; once Android stops asking, it opens the app's settings. When allowed, it reconnects by itself, and without the permission requests fail at once instead of hanging for two minutes.
- The server address field no longer capitalizes the first letter on phones.

## [0.3.2] - 2026-10-09

**Updating:** apps and server can be updated in any order. A 0.3.2 app works with a 0.3.1 server.

### Added

- Apps and server check each other's version when they connect. When an update changed what they exchange, the app says whether the app or the server needs updating. **Settings → About** shows both versions.
- Before the server changes the database during an update, it copies it to `backups/teahouse-<time>.db` in the data folder. The last five copies are kept. The README explains how to go back to the previous version with one.

### Changed

- A server address entered without `http://` or `https://` gets `https://` for a domain (a server behind a reverse proxy) and `http://` for an IP address, `localhost` or an address with a port (a server on the LAN).
- The version is set in one place for all packages and apps (`pnpm version:set`), and CI fails when the files disagree.
- CI uses current versions of all GitHub Actions and runs on Ubuntu 24.04.

### Fixed

- Signing in from an app no longer stalls without a message when the app had marked the server as unreachable.
- Pages longer than the window, such as Settings, were cut off at the bottom. They scroll now.

## [0.3.1] - 2026-10-09

**Android:** 0.3.0 was signed with a different key and had a different app ID, so 0.3.1 cannot be installed over it. Open 0.3.0 once while connected to the server so it syncs, uninstall it, then install 0.3.1. From 0.3.1 on, new versions install over the old one.

### Added

- The server is published as a Docker image for amd64 and arm64 with each release: `ghcr.io/linyeir/teahouse:latest`, or a version such as `:0.3`.
- Teahouse can be installed from the browser as an app (PWA), with its own icon.

### Changed

- New icon in Art déco style: an emerald tea bowl with a gold band, whose surface is a speech bubble. It replaces the old icon in the apps, the browser tab, the sign-in screen and the sidebar.
- Android APKs are signed with a fixed Teahouse key, and the app ID no longer has the `.debug` suffix.
- Releases are built from the `release` branch and only after lint, typecheck and tests pass.

## [0.3.0] - 2026-10-08

The first release with ready-made apps, and the first with files to download.

### Added

- Desktop apps for Windows (`.msi`, `.exe`), macOS (`.dmg`) and Linux (AppImage, `.deb`, `.rpm`), and an Android app with one APK per architecture (arm64, arm, x86_64). The apps are the web client in a Tauri shell and connect to your server.
- Pairing: **Settings → Pair a device** shows a QR code, a link and a typeable code that sign in another device without the password. Each code works once and expires after five minutes. The Android app can scan the QR code.
- The apps ask for the server address on first start. A pasted pairing link connects and signs in at once.
- Offline use: each device keeps the 30 most recent chats. Without the server you can read them, edit messages of the current scene and write one message, which is sent once the server is back.
- Conflicts between devices are resolved without losing text. A message written while the chat moved on elsewhere starts a new branch. When two devices edit the same message, the later edit wins and the device that made it shows a warning.
- In a browser served over HTTPS or from `localhost`, Teahouse opens without the server too.

### Changed

- After **Load models** in a profile, the model is chosen from a dropdown. The profile list shows which roles each profile serves and has **Use for narrator**.
- The server log records the outcome of every reply.

### Fixed

- A reply that failed (rate limit, wrong API key, unreachable endpoint) showed nothing in the visual novel view. It now shows the error with the profile and model it came from, next to **Regenerate**.
- Replies appear while the WebSocket is blocked or reconnecting, by polling.
- Signing out a device disconnects it at once instead of on its next reconnect. A wrong password or pairing code no longer signs out a browser that is already signed in.

## [0.2.0] - 2026-10-06

Not released as a build. Run from source or with `docker compose`.

### Added

- Visual novel view: background, character images by mood and a text box that steps through the reply line by line. **Log** switches to the full text.
- The narrator writes in a small tag markup (`<narration>`, `<say who mood>`, `<bg/>`, `<leave/>`). If the model starts writing a line for your persona, the reply is cut there.
- Character images with labels such as `neutral` or `amused`, and world backgrounds with descriptions for the narrator.
- Theme tokens for colors and fonts of the view, which a world can override (see [docs/theming.md](docs/theming.md)).
- World export and import as `.teahouse.tar.gz`, with Git history, images and chats, but never profiles or API keys.

## [0.1.0] - 2026-10-06

Not released as a build. Run from source or with `docker compose`.

### Added

- Self-hosted server with password sign-in and one token per device, a web client in English and German, and a Docker setup.
- Profiles for any OpenAI-compatible endpoint (LM Studio, llama.cpp, OpenRouter and others), with model list and context window detection.
- Worlds as folders of Markdown files, each with its own Git repository. Every save is a commit, and so is every edit made directly in the folder.
- Character Card import (PNG or JSON, V1 to V3), lorebooks included.
- Chats as message trees with regenerate, swipes, stop and editing.
- Scenes with Active Memory, which summarizes long scenes in the background to keep them in the context window.
- A canon budget that fills the prompt with world files by priority.
- Canon updates when a scene ends, proposed by the model and reviewed per file as a diff.
- A memory test run with reference scenes (`pnpm --filter @teahouse/server eval:memory`).

[0.4.0]: https://github.com/Linyeir/teahouse/releases/tag/v0.4.0
[0.3.4]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.4
[0.3.3]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.3
[0.3.2]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.2
[0.3.1]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.1
[0.3.0]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.0
[0.2.0]: https://github.com/Linyeir/teahouse/pull/5
[0.1.0]: https://github.com/Linyeir/teahouse/pull/4
