# Coming from SillyTavern

Teahouse is an independent project with no shared code, and it doesn't try to match SillyTavern feature for feature. If you know SillyTavern, this page says what carries over and what works differently. [The concept](concept.md) explains why.

## What carries over

**Character cards** (PNG or JSON, V1 to V3) import as they are. The card becomes a Markdown file in `characters/`, each lorebook entry a file in `lore/`, the card image the character's default image, and the greetings stay greetings.

Lorebook logic (secondary keys, `selective`, `constant`, depth, order, recursion) is not carried over. Teahouse brings files into the story by their name, aliases and tags instead, within the space the model has. A lorebook entry's keys become its tags and aliases.

**Endpoints:** anything that offers OpenAI-compatible chat completion. Text completion and SillyTavern presets are not supported.

**Not imported yet:** chat logs, presets, sprite folders and World Info outside a card ([#99](https://github.com/Linyeir/teahouse/issues/99), [#103](https://github.com/Linyeir/teahouse/issues/103)).

## What works differently

| In SillyTavern | In Teahouse |
|---|---|
| One long chat | A chat is a series of scenes, and you end each one yourself |
| Chat summaries and World Info you maintain | After each scene, Teahouse proposes what the world should remember, and you review it file by file |
| Lorebook entries | Markdown files in a folder with a Git history, editable in any editor |
| Group chats | Any character of the world can join a scene; you pick who speaks next, and a narrator describes what happens around them |
| Sprites and backgrounds through extensions | Built in: images by mood per character, backgrounds per world |
| One app per device | One server, with apps and browsers that sync through it and work offline |

[How Teahouse works](how-it-works.md) walks through all of this as you meet it while playing.
