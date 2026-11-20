# Running the server

The Teahouse server stores your worlds and chats and serves the web client. Apps and browsers on your devices connect to it. The [Quickstart](../README.md#quickstart) starts the server with Docker, and this page covers everything after that.

## The image

Each release is published for amd64 and arm64 as `ghcr.io/linyeir/teahouse:latest`. To stay on one line of releases, use a version tag such as `:0.4`. The repository's [compose.yaml](../compose.yaml) matches the Quickstart, with `build: .` added so that you can build from a checkout. The `teahouse-data` volume holds the database and, unless you configure another place, the world folders.

## Models and profiles

Teahouse connects to a model through any OpenAI-compatible chat completion endpoint, and **Profiles** has presets for the common ones:

| Server | Address |
|---|---|
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp (`llama-server`) | `http://localhost:8080/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

> [!IMPORTANT]
> Inside Docker, `localhost` means the container, not your machine. Use `http://host.docker.internal:1234/v1` or the network address of your machine. The Quickstart's `compose.yaml` makes `host.docker.internal` work on Linux too.

Teahouse asks OpenRouter, llama.cpp or LM Studio how much text a model can read at once (its context window). You can override this number in the profile.

Teahouse uses a model for four jobs: writing replies, summarizing long scenes, updating the world after a scene, and proposing the opening of the next scene. Under **Settings**, each job can use its own profile, for example a small, fast model for summaries. A job without its own profile uses the profile for replies.

## Network and HTTPS

Teahouse uses plain HTTP. That is fine inside your home network or a VPN. If the server can be reached from the internet, put it behind a reverse proxy with HTTPS, or use Tailscale. [HTTPS](https.md) explains these setups and what your devices need for each one. At startup, the server prints a warning when other machines can reach it over plain HTTP.

## Updating

To update, pull the new image and restart:

```sh
docker compose pull && docker compose up -d
```

When a new version changes the database, the server first copies the database to `backups/teahouse-<time>.db` in the data volume and logs the path. The server keeps the last five copies. Updates never change the worlds, which are Git repositories.

To go back to the previous version, stop the server and replace `teahouse.db` with the copy. Delete `teahouse.db-wal` and `teahouse.db-shm`, and then start the previous image.

You can update the apps and the server separately. They compare their versions when they connect. If an update changed the data that they exchange, the app shows whether the app or the server needs the update. **Settings → About** shows both versions.

## Backups

To back up everything, back up the data volume. It contains the database with your chats, profiles and settings, and the world folders. Each world is also a Git repository, so you can push it to another place as an extra copy of its files and history.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TEAHOUSE_PORT` | `8787` | HTTP port |
| `TEAHOUSE_HOST` | `0.0.0.0` | Address to listen on |
| `TEAHOUSE_DATA_DIR` | `./data` | Database and, by default, worlds |
| `TEAHOUSE_WORLDS_DIR` | `<data>/worlds` | World folders |
| `TEAHOUSE_CLIENT_DIR` | `packages/client/dist` | Built web client to serve |
| `TEAHOUSE_CORS_ORIGINS` | none | Extra browser origins that may call the API, separated by commas (the apps are always allowed) |
