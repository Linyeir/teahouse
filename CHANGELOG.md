# Changelog

What changed for people who run Teahouse, by version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each release on GitHub uses its section from this file as release notes.

## [0.3.3] - unreleased

**Updating:** apps and server can be updated in any order. A 0.3.3 app works with 0.3.1 and 0.3.2 servers. On Android 17, the app asks once for access to the local network (Android calls it "Nearby devices"); allow it if your server is at home.

### Added

- When an app cannot reach the server, it says why instead of only "Server unreachable": nothing answers at that address (with the system's reason), a reverse proxy answers but Teahouse behind it does not, a proxy blocks the app (for example by redirecting to a login page), the address does not speak HTTPS, or the device does not trust the server's certificate. For a certificate, the app names the likely cause (expired, issued for another name, self-signed, unknown CA) and shows who it is for, who issued it, how long it is valid and its SHA-256 fingerprint. ([#26](https://github.com/Linyeir/teahouse/issues/26))
- The Android app trusts CAs you installed on the phone, for example from mkcert or step-ca, as the desktop apps already do with the system's certificates. Android shows a "network may be monitored" notice for such a CA; that is expected. ([#26](https://github.com/Linyeir/teahouse/issues/26))
- [docs/https.md](docs/https.md) explains the ways to serve Teahouse over HTTPS: a publicly trusted certificate (Let's Encrypt, `tailscale serve`), your own CA with install steps for Linux, Windows, macOS and Android, or plain HTTP inside your LAN or VPN.

### Fixed

- On Android 17 the app could not reach a server on the local network at all, because Android 17 blocks it until the user allows it. The app now asks before it first connects to a server at home. If you decline, it says why it is offline and offers to allow it; once Android stops asking, it opens the app's settings. When allowed, it reconnects by itself, and without the permission requests fail at once instead of hanging for two minutes.
- The server address field no longer capitalizes the first letter on phones.

## [0.3.2] - unreleased

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

[0.3.3]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.3
[0.3.2]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.2
[0.3.1]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.1
[0.3.0]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.0
[0.2.0]: https://github.com/Linyeir/teahouse/pull/5
[0.1.0]: https://github.com/Linyeir/teahouse/pull/4
