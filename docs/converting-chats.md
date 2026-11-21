# Converting chats into a world

Teahouse can't import chat logs yet ([#103](https://github.com/Linyeir/teahouse/issues/103)).
Until it can, you can bring a story over with the help of an AI agent: give it this page and
your chats (plain text or Markdown transcripts and notes), and it writes a world folder that
Teahouse picks up. [Putting the folder in place](#putting-the-folder-in-place) at the end says
what to do with the result.

Everything below is written for the agent.

## Goal

Read the source chats and write a **world folder**: Markdown files with YAML frontmatter that
describe the setting, the user's persona, the characters, places, lore and the story so far.
Do not copy the transcripts. Extract and condense them. Teahouse puts these files into the
prompt as canon, so every sentence costs context budget. Write facts, not retellings.

## Output layout

```
<world-slug>/
  world.md          ground rules, tone, setting, story so far
  user.md           what the world knows about the user's persona
  characters/       one file per recurring character
  places/           one file per recurring location
  events/           chronicle of the past, one file per scene or story arc
  lore/             factions, items, magic, history, customs, anything else
```

- Create only these folders. Do **not** create `.git/`, `assets/` or `.gitignore`; Teahouse
  sets those up when it picks up the folder.
- File names are slugs: lowercase ASCII, words joined by `-`, no spaces, ending in `.md`
  (`characters/mira-voss.md`, `places/the-salt-lantern.md`).
- **A character's file name is their ID.** The narrator refers to characters by it
  (`<say who="mira">`), so keep it short and stable: usually the first name (`mira.md`).
  Use a longer slug only when two characters share a name.

## File format

Every file starts with a YAML frontmatter block between `---` lines, then a blank line, then
a Markdown body that starts with a `# Heading`:

```markdown
---
type: character
name: Mira Voss
tags:
  - smuggler
  - harbour
aliases:
  - Mira
  - the Captain
summary: Smuggler captain of the Gull who owes {{user}} a favour she would rather forget.
---

# Mira Voss

Body text …
```

Rules for the frontmatter:

- Valid YAML. Quote strings containing `:`, `#`, `*` or starting with `"`, `[`, `{`.
- Lists in block style as shown above; empty lists as `[]`.
- No fields beyond the ones listed below.

### Fields

| Field | Files | Content |
|---|---|---|
| `type` | all | `world`, `user`, `character`, `place`, `event` or `lore` (must match the folder) |
| `name` | all | Display name. For `user.md` leave it out. |
| `tags` | all | Keywords that should pull this file into the prompt when they appear in the story |
| `aliases` | all | Other names, nicknames, titles the file's subject is called by |
| `summary` | all | 1–3 sentences. Used instead of the body when the context budget is tight, so it must stand on its own. |
| `greetings` | `character` | Possible opening messages for a new scene with this character. Use `[]` if the sources have none. |
| `order` | `event` | Integer, chronological position (1, 2, 3 …) |
| `enabled` | `lore` | Only write `enabled: false` for entries that should never be pulled in automatically |

Leave out `id`, `images`, `chat`, `scene`, `color`, `theme`, `themePreset` and
`defaultBackground`. Teahouse adds IDs itself, `chat`/`scene` only exist for scenes played in
Teahouse, and images, colors and themes are set in the app afterwards.

### How files get into the prompt

Knowing this helps you choose tags, aliases and what goes where:

- `world.md`, `user.md` and the files of characters present in a scene are **always** included.
- Every other file (places, lore, imported events, absent characters) is included **only if its
  `name`, a tag or an alias appears as a whole word** in the recent story text. Matching ignores
  case and words shorter than two letters. So pick tags and aliases that the story would actually
  mention: names, nicknames, the name of a ship or a city, not abstract words like "conflict" or
  "backstory".
- When space runs out, files are cut down to their `summary`, then dropped. Events go first,
  oldest first; places, lore and absent characters are kept longer. The always-included files
  are only ever cut to their summary.
- A file with `enabled: false` is never included by a mention.

Teahouse also includes the events of the chat being played, but the events you write here
belong to no chat, so they only come in when the story mentions them. **Anything the narrator
must always know about the past belongs in `world.md` (short) or in the character files**, not
only in `events/`.

## Text conventions

- Refer to the user's persona as `{{user}}`, everywhere, including summaries and greetings.
  Replace the persona's name from the transcripts.
- Inside a character file, `{{char}}` means that character. Plain names work too. Prefer the
  name in descriptions and use `{{char}}` only where the source used it.
- Link other files with wikilinks by slug: `[[mira]]`, `[[the-salt-lantern]]`.
- Write in the present tense for current state ("Mira distrusts the guild") and in the past tense
  in events.
- Keep the language of the source chats.
- Never invent facts. If the sources contradict each other, use the latest state and mention the
  change in an event if it matters.

## Each file type

### `world.md`

```markdown
---
type: world
name: Rain Port
tags: []
aliases: []
summary: A rain-soaked harbour city where smugglers, a merchant guild and a drowned god's cult compete for the docks.
---

# Rain Port

## Setting
Place, era, technology or magic level, the society. A few short paragraphs.

## Tone and rules
Genre, mood, content boundaries, narrative rules the chats followed (e.g. "magic always has a price").

## Story so far
5–15 bullet points of the most important past developments, oldest first, with wikilinks
to the event files.
```

### `user.md`

```markdown
---
type: user
tags: []
aliases: []
summary: A disgraced former harbour officer now working as a fixer between smugglers and the guild.
---

# {{user}}

Who {{user}} is in this world: role, history, reputation, possessions and relationships, as
known in the chats. Do not describe the user's personality or decide what they think or feel.
Only describe what the world knows and has seen.
```

### `characters/<slug>.md`

```markdown
---
type: character
name: Mira Voss
tags:
  - Gull
aliases:
  - Mira
  - Captain Voss
summary: Smuggler captain of the Gull, dry-humoured and fiercely loyal to her crew; owes {{user}} a favour.
greetings:
  - '*Mira looks up from her glass.* "You again."'
---

# Mira Voss

Appearance, background and current situation.

## Personality
Traits, habits, how she talks. One or two short example lines in her voice if the chats show a
distinctive style.

## Relationships
- [[user]]: … (current state of the relationship, including how it developed)
- [[tomas]]: …

## Secrets and goals
Things she knows or wants that drive her behaviour.
```

Make a file for every character who appears in more than one scene or matters to the plot.
Minor one-off characters go into the event where they appeared.
`greetings` are in-character opening messages taken or adapted from the chats. Use `*asterisks*`
for actions and plain text for speech.

### `places/<slug>.md`

`type: place`. Body: what it looks like, who is usually there, what happened there that still
matters. Only for locations the story returns to.

### `lore/<slug>.md`

`type: lore`. One topic per file: a faction, an artefact, a custom, a historical event before the
chats began. Tags are the words that should trigger it.

### `events/<slug>.md`

```markdown
---
type: event
name: The night at the Salt Lantern
tags:
  - Salt Lantern
  - Mira
aliases: []
summary: '{{user}} met Mira at the Salt Lantern and agreed to help move the guild cargo in exchange for passage.'
order: 3
---

# The night at the Salt Lantern

What happened, in a few paragraphs: who was there, what was decided, what changed. Name
consequences that are still open. Use wikilinks for people and places.
```

- One file per scene or coherent story arc, numbered through `order` in story order.
- Name the files `<order>-<slug>` with zero padding so they sort: `events/003-the-night-at-the-salt-lantern.md`.
- Tag them with the characters, places and objects involved so they come up when those return.

## Procedure

1. Read all source files and note every character, place, faction, object and plot thread with
   where it occurs.
2. Determine the user's persona and the chronological order of the chats.
3. Write the event files in order. This forces you through the whole story once.
4. Write characters, places and lore from the notes and the events, with the **latest** state.
5. Write `user.md`, then `world.md` last, including "Story so far".
6. Check:
   - Every file parses: frontmatter between `---` lines, valid YAML, `type` matches the folder.
   - Every file has `name` (except `user.md`), `tags`, `aliases` and a standalone `summary`.
   - The persona's name appears nowhere. Only `{{user}}` is used.
   - Every `[[wikilink]]` points to an existing file slug (`[[user]]` for `user.md`).
   - No transcript passages longer than a few lines were copied.
7. Report what you created, which characters you deliberately left out, and any contradictions or
   gaps you found in the sources.

## Putting the folder in place

This part is for you, not the agent.

1. Copy the finished folder into the worlds folder of your Teahouse server: `<data>/worlds/`, or
   the folder that `TEAHOUSE_WORLDS_DIR` names ([Running the server](server.md#configuration)).
   With the Quickstart's Docker setup, run these two commands in the folder with `compose.yaml`
   (here for a world folder named `rain-port`). The second one gives the files to the user
   Teahouse runs as, because `docker compose cp` copies them as root:

   ```sh
   docker compose cp rain-port teahouse:/data/worlds/rain-port
   docker compose exec -u root teahouse chown -R node:node /data/worlds/rain-port
   ```

2. Open or reload the worlds page. Teahouse picks the folder up, gives it a world ID and a Git
   repository, and commits the files. If the world doesn't show up, `world.md` probably has
   broken frontmatter.
3. Upload images for the characters and backgrounds for the world on the world page, as
   [Worlds](worlds.md#images-and-backgrounds) describes.
4. Run **Tidy up the canon** on the world's overview. It finds contradictions between files,
   duplicates, and names the events use that are missing from the aliases, and you decide what
   to change.
