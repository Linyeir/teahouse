# Worlds

A world holds everything that stays between scenes: the setting, the characters, places, lore, and the events that you have played. Teahouse stores it as a folder of Markdown files, which you can open and edit outside the app.

<p align="center"><img src="images/world.png" alt="A world's overview: the file list on the left (characters, places, events, lore), and on the right the characters with Start chat buttons, the Tidy up the canon card and the world's backgrounds." width="800"></p>

## The files of a world

Each world is a folder under `<data>/worlds/` with its own Git repository:

```
rain-port/
  world.md        the setting, its ground rules and tone
  user.md         what the world knows about you (your persona)
  characters/     one file per character
  places/         locations
  events/         one file per scene that ended with canon
  lore/           everything else: history, customs, factions
  assets/         images (not in Git)
```

Every file starts with a few fields between two `---` lines. Ordinary Markdown follows:

```markdown
---
type: character
name: Mira
tags: [smuggler, pier]
aliases: [the Fox]
summary: A smuggler who runs crates over the night pier.
greetings:
  - Mira looks up from her crate. "You're the new one."
---

# Mira

Mira grew up on the docks and knows every plank of the night pier.

## Personality

Dry, patient, and hard to rattle.
```

The fields have these purposes:

| Field | Purpose |
|---|---|
| `name` | The name that Teahouse shows, and the first name that it looks for in the story |
| `aliases` | Other names for the same thing, such as nicknames, titles or "her sister". When one of them appears in the story, the file is included |
| `tags` | Keywords that include the file in the same way, but for topics such as `fog` or `smuggling` |
| `summary` | One to three sentences. Teahouse uses the summary instead of the full text when space is short, so keep it current |
| `greetings` | Only for characters: the opening lines that you can start a chat with |
| `enabled: false` | Leaves a file out of the story without deleting it |

Event files also have `chat`, `scene` and `order` fields, which Teahouse sets itself.

> [!TIP]
> Teahouse includes a file only when its name, an alias or a tag appears in the story. If a character is often called something else, add that name as an alias. After each scene, Teahouse proposes aliases that the scene used, and **Tidy up the canon** looks for more.

## Editing

To edit a file, select it on the world page. Every save is a commit, so the world has a full history.

You can also edit the folder directly, for example with [Obsidian](https://obsidian.md) or any text editor. Teahouse detects the change and commits it a few seconds later. Links between files can use wikilinks such as `[[mira]]`, which Obsidian supports.

A file can change while you edit it in Teahouse, for example through a scene's canon or an edit in Obsidian. In that case, saving doesn't overwrite the change. Teahouse shows the current file next to your version, and you either discard your edit or save yours anyway.

## Images and backgrounds

Each character can have several images, one per mood. Open the character's file and upload images, each with a label such as `neutral`, `amused` or `angry`. The novel view shows the image whose label matches the mood of the character's line, and uses `neutral` when no label matches.

Backgrounds belong to the world. You upload them on the world overview with a short description, and the model reads these descriptions to pick a background for the scene. `defaultBackground:` in `world.md` sets the background that is shown before the model picks one.

`color:` in a character file sets the color of that character's name badge. [Theming](theming.md) explains how a world can change the colors and fonts of the whole view.

## Character cards

**Import character card** imports SillyTavern-style cards (PNG or JSON, V1 to V3) into a new or an existing world. The card becomes a file in `characters/`, each lorebook entry becomes a file in `lore/`, and the card image becomes the character's default image. [Coming from SillyTavern](sillytavern.md) lists what carries over.

## Export and sharing

**Export world** on the world overview downloads a `.teahouse.tar.gz` file with the world's files, images and chats. **Import world** on the worlds page restores it with a fresh history. If the world already exists on the server, the import creates a copy.

An export never contains profiles, API keys or the world's Git history.
