# Security

Teahouse is a self-hosted server with a password, device tokens and pairing codes, and it is
often reachable from more than the machine it runs on. If you find a way around any of that,
please report it privately first.

## Supported versions

Fixes go into the latest release: the server image `ghcr.io/linyeir/teahouse:latest` and the
apps on the [releases page](https://github.com/Linyeir/teahouse/releases). Older versions get
no backports. A security release says so at the top of its notes and in
[CHANGELOG.md](CHANGELOG.md), with what to check if you were affected.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on the repository, or
[this link](https://github.com/Linyeir/teahouse/security/advisories/new). Only the maintainers
see the report. Please don't open a public issue or discussion for it.

Helpful to include: the version, how the server runs (Docker, from source, the apps), the
steps to reproduce, and what an attacker gains.

## What to expect

- A first answer within a week.
- Once confirmed, a fix in a release as soon as it is ready, and a GitHub security advisory
  that credits you unless you prefer otherwise.
- Disclosure after the release, agreed with you.

## Scope

In scope: the server, the web client, the apps and the Docker image. For example, reaching the
API without signing in, pairing a device without a code, reading another device's token,
running code on the server through an import, or escaping a world's folder.

Out of scope:

- Running Teahouse on plain HTTP beyond your own LAN or VPN. The server warns about it at
  startup, and [docs/https.md](docs/https.md) explains why and how to add HTTPS.
- Anyone who knows the password: there is one owner, and a signed-in device may do everything.
- What an LLM endpoint does with the prompts it receives, or text a model writes into a chat.
