# Teahouse – Concept v1

Teahouse is self-hostable open-source software for AI roleplay in the style of a visual novel. It consists of a server and clients for web, desktop and Android. It is modeled on SillyTavern, but is an independent project with no shared code.

This document records the concept decisions made so far. It is the basis for architecture and implementation.

## 1. Distinguishing features

1. **Two-tier memory.** Active Memory keeps long scenes within the context window, a canon holds lasting world knowledge as Git-versioned Markdown files.
2. **Separate presentation of narration and dialogue** in a visual-novel-style view with character images and backgrounds.
3. **Scenes as the unit of play.** The user closes scenes, and canon is derived from them. What is closed stays closed.
4. **Sync between devices** through the user's own server, with offline use of the apps.

## 2. Constraints

| Topic | Decision |
|---|---|
| License | AGPL-3.0 for Teahouse and first-party plugins. Expected, not enforced, for third-party plugins. |
| Audience | Technically minded self-hosters |
| Users | One user per instance |
| Platforms | Web, desktop (Windows, macOS, Linux), Android as an APK outside the store. No iOS. |
| Generation | External APIs only, chat completion only |
| Compatibility | LM Studio, llama.cpp (`llama-server`), OpenRouter, OpenAI-compatible endpoints in general |
| Language | i18n from the start, English and German. Default prompts in English with a template variable for the output language. |
| Feature parity with ST | Explicitly not a goal |

## 3. Technical stack

- **Server:** TypeScript on Node.js, Fastify for REST API and WebSocket (streaming, sync notifications). Fastify's hook model fits the later plugin system.
- **LLM access:** the official `openai` npm SDK against any OpenAI-compatible base URL. No home-grown HTTP/SSE client.
- **Database:** SQLite with Drizzle ORM (chats, scenes, message tree, Active Memory, settings, profiles)
- **World data:** Markdown files on disk, versioned with the `git` binary via `simple-git`
- **Client:** React web app (Vite), packaged with Tauri 2 for desktop and Android
- **Repository:** pnpm monorepo

```
packages/
  server/       API, prompt building, Git, file watcher, plugins
  client/       React app (web, Tauri)
  shared/       shared types, tag parser, sync protocol
  plugin-sdk/   types and helpers for plugin authors (later)
```

- **Operations:** Docker image with Git, data volume for SQLite, worlds and assets
- **Access:** password on first login, then one revocable token per device, pairing via QR code. HTTPS is handled by the user's reverse proxy or Tailscale.

### Schema rules from day one

Sync comes later, but the schema has to support it now:

- All IDs are client-generatable UUIDv7
- Every synced row has `updated_at` and a revision counter
- Deletion is a soft delete (tombstone)

## 4. Domain model

- **World:** A folder with canon files, assets and a Git repository. Every character belongs to a world.
- **Character:** A file in `characters/` plus character images with free-form labels (e.g. `neutral`, `amused`).
- **Chat:** Belongs to exactly one world. A linear sequence of scenes.
- **Scene:** Has a start message, a cast and a status:
  - `active` – messages form a tree (forks, swipes, edits)
  - `closing` – a canon proposal is being generated and reviewed
  - `closed` – the chosen path is frozen, all other branches are hidden and kept read-only
- **Message:** A node in the tree of the active scene. An AI message consists of several beats.
- **Beat:** A section of a message: narration, a character's line with facial expression, or a background change.
- **Active Memory node:** A summary attached to the message up to which it summarizes.
- **Profile:** A named combination of endpoint, model and parameters that is assigned to roles.

Each chat has at most one active scene at a time. Several chats in the same world are allowed and share the canon without any safeguards.

### Folder structure of a world

```
world-name/
  .git/
  .gitignore        contains assets/ and .obsidian/
  world.md          ground rules, tone, setting
  user.md           knowledge about the user's persona
  characters/       one file per character, including relationships
  places/
  events/           chronicle, one file per closed scene
  lore/             entries imported from lorebooks
  assets/           character images, backgrounds (not in Git)
```

### Frontmatter

Every Markdown file has YAML frontmatter:

| Field | Required | Purpose |
|---|---|---|
| `type` | yes | `world`, `user`, `character`, `place`, `event`, `lore` |
| `tags` | yes | Keywords for context selection |
| `aliases` | yes | Alternative names, also for context selection |
| `summary` | yes | 1–3 sentence short form, used instead of the full text when the budget is tight |
| `images` | no | Stable image IDs with labels (characters, places) |
| `chat`, `scene`, `order` | for `event` | Origin and position in the chronicle |

Links use wikilinks (`[[mira]]`) so the folder also works in Obsidian.

## 5. Prompt system

### Roles

Each role has its own prompt template and an assignable profile. By default one profile is used for everything.

1. **Narrator** – generates the whole turn: narration, dialogue of all characters, facial expressions, background changes
2. **Scene start** – proposes start message and cast of a new scene
3. **Active Memory summary**
4. **Canon update**

### Templates

- Template language with placeholders such as `{{char}}`, `{{user}}`, `{{memory}}`, `{{scene}}`
- Layers: global, world, character, chat. Later layers override earlier ones.
- `{{user}}` is always the name of the user's persona.
- `{{char}}` is ST-compatible and, inside a character file or character template, refers to that character. In role templates without a character reference `{{char}}` is empty and the template editor shows a warning.
- No import of ST presets in v0.1

### Context selection and budget

The prompt is built in a fixed order, static parts first, so local servers can reuse their KV cache:

1. Role template (global → world → chat)
2. Canon
3. World character list (name, `summary`, available labels) and background list with short descriptions
4. Active Memory of the scene
5. Start message of the scene
6. Scene history

The canon has its own budget, 30 % of the context window by default, configurable per world. It is filled by priority:

1. `world.md`, `user.md`, files of all present characters
2. The last two `events/` files of this chat
3. Further files matched by tags and aliases in the frontmatter
4. Older `events/` files

If the budget does not suffice, entries are downgraded to their `summary` from the bottom up, then dropped. Priority 1 is downgraded last and never dropped.

Later, optionally: embedding search for large worlds.

There is no knowledge separation between characters.

### Token counting

- Where the endpoint can tokenize (llama.cpp `/tokenize`), tokens are counted.
- Otherwise they are estimated, with a safety margin configurable per profile.
- The context window is read automatically per profile (OpenRouter metadata, llama.cpp `/props`, LM Studio model info) and can be overridden. What counts is the loaded context, not the model's maximum.

## 6. Flow of a turn

1. The user writes an input. `*Asterisks*` mark action, the rest is speech. A normalizer turns this into tags, then the input runs through the same parser as AI replies.
2. **One narrator call** generates the whole turn and is streamed. The model decides which characters act and speak. Not every character has to appear in every turn.
3. The output uses a tag markup that is parsed immediately while streaming:

```
<bg id="tavern-night"/>
<narration>Rain drums against the windows. Mira looks up from her glass.</narration>
<say who="mira" mood="amused">So you came after all.</say>
<leave who="tomas"/>
```

| Tag | Meaning |
|---|---|
| `<narration>` | Narrative text |
| `<say who mood>` | A character's line. `mood` is a label from their image list. |
| `<bg id/>` | Background change, `id` from the world's background list |
| `<leave who/>` | Character leaves the scene, their image disappears |

A character enters the scene implicitly with their first `<say>`.

### Parser robustness

- Text outside tags is treated as narration
- Unclosed tags are closed at the end of the stream
- An unknown `who` is shown as narration with a speaker name and flagged
- An unknown `mood` or `bg` falls back to the default image or the current background
- The narrator prompt forbids speaking for `{{user}}`. In addition, the parser stops as soon as `<say who="{{user}}">` appears.

### Swipes and edits

Only within the active scene:

- **Swipe:** the whole AI message is regenerated
- **Edits:** every message of the active scene is editable, including the user's and the start message
- **Forks:** possible at any message of the active scene

Swiping a single beat (regenerating from a beat via assistant prefill) is postponed because not all endpoints support prefill.

## 7. Scenes

- A chat is a sequence of scenes.
- **Only the user ends a scene**, with a button.
- When ending, the user picks the path if the scene has forks. All other branches are hidden, not deleted.
- A scene can be closed **with or without canon**. Without canon (e.g. for side scenes) no `events/` file and no commit is created, and the scene is closed immediately.
- **Start message and cast** of a new scene are proposed by the scene start role, based on a short brief from the user. The user can edit both. For the first chat with an imported card, its `first_mes` is the start message and `alternate_greetings` are offered as alternatives.
- A new scene sees the canon and its start message. The event priority (section 5) guarantees that the previous scene is in context.

## 8. Memory

### Tier 1: Active Memory

- Short summary of the running scene that goes into the prompt
- Stored as a node in the message tree in SQLite, not as a file and not in Git
- Forks and swipes automatically inherit only summaries that lie before their branch point
- **Trigger:** in the background after a turn, when the history reaches 80 % of the remaining budget. Remaining budget = context window − reserved response length − template − canon.
- **Target:** enough is summarized that the history ends up at about 50 %. This keeps the summary from firing on every turn.
- **Fallback:** if the summary is not ready by the next turn and the budget is full, the turn waits for it.
- **Incremental:** the call receives the previous summary and the section that is newly falling out, never the whole history
- **Always verbatim in context:** the scene's start message and the last three turns. If these alone do not fit the budget, the oldest of the three turns is truncated.
- **Edits:** if a message before a summary node is edited, the node is marked stale and recomputed in the background.

### Tier 2: Canon

- Markdown files of the world; the file system is the source of truth
- A single Git branch `main` per world
- **Created when a scene is closed**, unless the user chooses "close without canon". An LLM proposes changes, at least one new `events/` file with `summary`.
- **Proposal format:** structured operations instead of free text, so the LLM cannot silently lose content:
  - `create(path, frontmatter, body)`
  - `append_section(path, heading, text)`
  - `replace_section(path, heading, text)`
  - `set_summary(path, text)`
  - `add_alias(path, alias)` / `add_tag(path, tag)`

  The frontmatter is managed by code. The diff view is generated from the result of the operations.
- **Review as a per-file diff:** accept, edit, discard. Can be turned off, in which case proposals are applied automatically.
- After review, one commit whose message references chat and scene. Only then is the scene closed and the next one can start.
- If the canon is changed externally before review (editor, file watcher), the proposal is reconciled by a three-way merge against its base commit. Conflicts are shown in the diff view.
- **Later maintenance:** the user can edit the canon by hand at any time. If that creates continuity gaps, it is the user's decision.
- **Editing:** in the apps through a Markdown editor against the server API (online only). Every save is a commit. A file watcher detects direct changes on disk and commits them as well (debounced, ignoring temporary editor files).
- **Git queue:** all Git operations of a world run serially through a queue, so API, watcher and canon commits do not collide.
- **Why Git:** traceability and undo, not branching. Above all, canon changes by the LLM that only show up as wrong scenes later can be reverted per scene. On top of that: diff view, three-way merge with manual edits, backup via `git push`, and sharing worlds as repositories. A later "fork world" feature may use branches.

## 9. Sync and offline

- The server is authoritative. Clients keep a local copy.
- **Only chats and Active Memory** are synced, no canon files
- **Possible offline:** reading chats, drafting one message (sent and generated on reconnect), editing messages of the active scene
- **Conflicts:** new messages from several devices become forks in the tree, nothing is lost. For edits of the same message the last change wins, with a warning. No CRDTs.
- Generation is not possible offline, because keys and prompt building live on the server

## 10. Presentation

- Visual-novel-style view with layers for background, character images and text
- Speaker attribution, character images with facial expressions from `mood`, background changes from `<bg>`
- **No music, no animation**
- Free-form labels per character and world; a default set is suggested on upload. The narrator receives the label list per character and the world's background list with short descriptions.
- If no matching image exists, a default image is used
- Images are uploaded or imported (ST cards, sprite packs). Image generation exists only as a plugin.
- Conceivable later: an extra call that derives poses or image choice from the action when `mood` alone is not enough

### Themes

- From v0.2 the app defines a token layer of CSS variables (colors, typography, text box style of the VN view)
- Themes are plugins that provide these variables and optionally fonts and layout variants (later)
- A theme can be preset per world

## 11. Plugins (later)

- **Full access** to server and UI. No sandboxing, no permission declarations.
- Server-side plugins run in the server process and attach to hooks (prompt building, providers, memory steps, import formats)
- Client-side plugins are ordinary code in the React app
- A plugin package optionally contains a server part and a client part
- **Installation** via Git URL or zip in the server UI. The server loads its part and serves the client bundle to all apps, which load it at startup.
- **Security model, stated explicitly:** an installed plugin has access to API keys and runs in every connected app, in Tauri including the exposed IPC commands. Users install only what they would run themselves.
- **Versioned plugin API field**, so old plugins do not silently break after updates

## 12. Import and export

### Character Card V2 and V3

On import, Teahouse asks whether the character goes into an existing or a new world.

| Card field | Target in Teahouse |
|---|---|
| `name` | File name and title in `characters/` |
| `description`, `personality` | Body of the character file |
| `scenario` | Section in `world.md` (for a new world) or a note in the character file |
| `first_mes` | Start message of the first scene |
| `alternate_greetings` | Alternative start messages |
| `mes_example` | "Example dialogue" section in the character file |
| `system_prompt`, `post_history_instructions` | Character template layer |
| `creator_notes` | Not in the prompt, only shown in the UI |
| `tags` | `tags` in the frontmatter |
| Embedded lorebook | One file per entry in `lore/`, `keys` become `tags`/`aliases`. The user can move entries to `characters/` or `places/` afterwards. |

Lorebook logic such as secondary keys, `selective`, `constant`, depth, order and recursion is not carried over. Cards describing several characters or a whole scenario are imported as one file. Splitting them is up to the user.

### Other

- **ST chat logs:** imported as one closed scene, optionally with a canon proposal
- **World export:** archive of the Git repository, assets and related chats. This is also the exchange format for sharing worlds.
- **Server backup:** back up the data volume

## 13. Versions

Each version ends with something that is actually usable.

| Version | Content | Result |
|---|---|---|
| **v0.1** | Server, profiles, OpenAI-compatible adapter, worlds as Markdown plus Git, card import, template layers, scenes, Active Memory, canon with diff review, memory test run, plain web chat | The core memory promise is testable |
| **v0.2** | Tag markup and parser, VN view with character images and backgrounds, theme token layer, world export | It feels like a visual novel |
| **v0.3** | Tauri apps for desktop and Android, sync, offline use, device pairing via QR code | Playing across devices |
| **v0.4** | Plugins and themes as plugins, ST chat import, beat swipes, possibly a call for poses and image choice | Extensibility |
| **later** | Embeddings, fork world, text completion, ST preset import | — |

### Order within v0.1

1. Server skeleton, profiles, OpenAI-compatible adapter, plain chat with one character
2. Worlds as Markdown plus Git, card import
3. Scenes, Active Memory, canon proposal with diff review
4. **Memory test run:** a few reference chats with fact questions ("What is Mira's brother called?") that are checked automatically after summarization and canon update. The basis for any later prompt tuning.

In v0.1 the narrator writes plain prose without tags. The web chat shows it as is.

## 14. Related projects

- **SillyTavern:** the model. Building Teahouse as an ST extension was rejected because the scene model and sync would work against the ST architecture.
- **Marinara Engine:** independent TypeScript codebase (AGPL-3.0) with sprites, backgrounds and AI agents. Apps are PWA or WebView shells, no sync with a remote server. Reference for the sprite implementation.
- **Basic Memory:** Markdown files as LLM memory with an SQLite index (AGPL-3.0). Reference for file format and indexing.
- **ST extensions Memory Books, Qvink MessageSummarize:** references for scene-based memories and summaries.
