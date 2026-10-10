# Changelog

What changed in each version of Teahouse, newest first. Server and apps share one version
number.

## Unreleased (0.3.3)

This release is about getting the apps connected to your own server: they now say why a
connection fails instead of just "Server unreachable", trust a CA of your own on Android, and
work on Android 17. Pinning self-signed certificates without a CA
([#27](https://github.com/Linyeir/teahouse/issues/27)) is planned for this release too.

### Added

- **The apps explain connection problems.** When the server can't be reached, the apps
  find out why and say so, in English and German:
  - nothing answers at that address (with the system's reason, e.g. "connection refused");
  - a reverse proxy answers, but Teahouse behind it doesn't;
  - the server answers, but a proxy blocks the app (a redirect to a login page, missing
    CORS headers);
  - the address speaks no HTTPS;
  - the device doesn't trust the server's certificate. The app then names the likely
    cause (expired, wrong name, self-signed, unknown CA), shows who the certificate is for,
    who issued it, how long it is valid and its SHA-256 fingerprint, and links to the HTTPS
    guide. ([#26](https://github.com/Linyeir/teahouse/issues/26))
- **Your own CA works on Android.** The Android app now trusts CAs installed on the phone
  (for example from mkcert or step-ca), as the desktop apps already did with the system's
  certificate store. Android shows a "network may be monitored" notice for such CAs; that
  is expected. ([#26](https://github.com/Linyeir/teahouse/issues/26))
- **HTTPS guide**, [docs/https.md](docs/https.md): a publicly trusted certificate (Let's
  Encrypt, `tailscale serve`), your own CA with install steps for Linux, Windows, macOS and
  Android, or plain HTTP inside your LAN or VPN.

### Fixed

- **Android 17 could not reach a server at home.** Android 17 blocks the local network for
  apps until the user allows "Nearby devices". The app now asks before it first connects to
  a server on the local network. If you refuse, it says why it is offline and offers to
  allow it; if Android no longer asks, it opens the app's settings. Once allowed, it
  reconnects by itself. Requests without the permission fail at once instead of hanging for
  two minutes.
- **Signing in to the apps could hang.** While the app considered itself offline, connecting,
  signing in and pairing waited for the server instead of trying; they now always try and
  show what went wrong.
- An address without `http://` or `https://` gets HTTPS for a domain (a server behind a
  reverse proxy) and HTTP for an IP address, `localhost` or `host:port` (a server on the
  LAN).
- The server address field no longer capitalizes the first letter on phones.

### Compatibility

- Works with 0.3.1 servers: the server is unchanged since 0.3.1, so you can update the apps
  first.
- The Android app installs over 0.3.1 and keeps its local copy.

### For developers

- The apps' native side has a `probe_server` command (rustls, diagnosis only: it accepts
  any certificate to look at it and sends no data).
- `packages/app/src-tauri/plugins/local-network`: a small Tauri plugin for Android 17's
  `ACCESS_LOCAL_NETWORK` permission.
- `packages/app/src-tauri/android/overlay.sh` applies Teahouse's changes (icons, network
  security config) to the Android project that `tauri android init` generates. Run it after
  every init.
- Tests: the certificate probe against real TLS servers, the diagnosis and permission logic,
  and an end-to-end test of the Android app on an Android 17 emulator
  (`pnpm --filter @teahouse/app e2e:android <apk>`). CI now also runs clippy and the Rust
  tests; the Apps workflow runs the end-to-end test, and a release needs it to pass.

## [0.3.1] (2026-10-09)

- **New icons** for the desktop apps and an adaptive icon for Android.
- **Docker image** for every release, for amd64 and arm64:
  `ghcr.io/linyeir/teahouse:latest` or a version such as `:0.3`.
- **Updates install over each other on Android**: every APK is signed with the same
  Teahouse key. 0.3.0 used a different key and app ID, so uninstall it first (let it sync
  before).
- Lint, typecheck and tests run on every pull request and before a release is drafted.
- Releases are drafted from the `release` branch, named after the version in
  `tauri.conf.json`.

## [0.3.0] (2026-10-08)

Teahouse leaves the browser tab: apps, pairing and offline use.

- **Apps** for Linux (AppImage, .deb, .rpm), Windows, macOS and Android, built around the
  web client. They connect to your server like a browser does and start without it.
- **Pairing**: a signed-in device shows a QR code, a link and a typeable code that sign in
  another device without the password. Codes work once and expire after five minutes. The
  Android app scans the QR code; a pasted pairing link connects and signs in at once.
- **Offline use**: each device keeps a local copy of the 30 newest chats. Without the
  server you can read them, edit messages of the current scene and write one message,
  which is sent when the server is back, also after closing the app.
- **Sync conflicts lose nothing**: a message written while the chat moved on elsewhere
  starts a new branch; of two edits to the same message the later one wins, with a warning;
  a message for a scene that was closed meanwhile goes back into the message field.
- Clients can use a server on another origin (`TEAHOUSE_CORS_ORIGINS`); the apps are always
  allowed. Signing out a device disconnects it immediately.
- One APK per architecture (arm64, arm, x86_64) instead of one large universal APK.

## Before 0.3

Untagged development versions:

- **0.2**: tag markup, the visual novel view, character images and backgrounds, theme tokens
  per world, world export.
- **0.1**: the server with OpenAI-compatible endpoint profiles, worlds as Markdown files
  under Git, Character Card import, scenes with Active Memory, and canon proposals reviewed
  as diffs.

[0.3.1]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.1
[0.3.0]: https://github.com/Linyeir/teahouse/releases/tag/v0.3.0
