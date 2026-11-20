# Running the server

Teahouse is one server that holds your worlds and chats, and serves the web client. The apps and browsers on your devices connect to it. The [Quickstart](../README.md#quickstart) gets it running with Docker; this page covers the rest.

## The image

Each release is published for amd64 and arm64 as `ghcr.io/linyeir/teahouse:latest`, or with a version such as `:0.4` to stay on one line of releases. The repository's [compose.yaml](../compose.yaml) is the Quickstart's, with `build: .` to build from a checkout instead. Your data lives in the `teahouse-data` volume: the database and, unless you configure otherwise, the world folders.

## Models and profiles

Teahouse doesn't run a model itself. It talks to any OpenAI-compatible chat completion endpoint. **Profiles** has presets for:

| Server | Address |
|---|---|
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp (`llama-server`) | `http://localhost:8080/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

> [!IMPORTANT]
> Inside Docker, `localhost` is the container, not your machine. Use `http://host.docker.internal:1234/v1` (the Quickstart's `compose.yaml` makes that name work on Linux too) or your machine's network address.

Teahouse detects how much text a model can read at once (its context window) from OpenRouter, llama.cpp or LM Studio. You can override it in the profile.

Teahouse uses a model for four jobs: writing replies, summarizing long scenes, updating the world after a scene, and proposing the opening of the next scene. Under **Settings** each job can use its own profile, for example a small, fast model for summaries. Without a choice, every job uses the reply profile.

## Network and HTTPS

Teahouse speaks plain HTTP. Inside your home network or a VPN that's fine. For anything reachable from the internet, put it behind a reverse proxy with HTTPS, or use Tailscale. [HTTPS](https.md) explains the options and what your devices need for each. The server warns at startup when other machines can reach it over plain HTTP.

## Updating

Pull the new image and restart:

```sh
docker compose pull && docker compose up -d
```

When a new version changes the database, the server first copies it to `backups/teahouse-<time>.db` in the data volume and logs where. The last five copies are kept. Worlds are Git repositories and are never touched by updates.

To go back to the previous version: stop the server, replace `teahouse.db` with the copy (and delete `teahouse.db-wal` and `teahouse.db-shm`), then start the previous image.

Apps and server can be updated separately. They check each other's version when they connect, and if an update changed what they exchange, the app says which of the two to update. **Settings → About** shows both versions.

## Backups

Back up the data volume. It holds everything: the database with chats, profiles and settings, and the world folders. Each world is also a Git repository, so you can push it somewhere as an extra copy of its files and history.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TEAHOUSE_PORT` | `8787` | HTTP port |
| `TEAHOUSE_HOST` | `0.0.0.0` | Address to listen on |
| `TEAHOUSE_DATA_DIR` | `./data` | Database and, by default, worlds |
| `TEAHOUSE_WORLDS_DIR` | `<data>/worlds` | World folders |
| `TEAHOUSE_CLIENT_DIR` | `packages/client/dist` | Built web client to serve |
| `TEAHOUSE_CORS_ORIGINS` | – | Extra browser origins allowed to call the API, comma-separated (the apps are always allowed) |
