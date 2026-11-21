# Coming from SillyTavern

Teahouse is an independent project with no shared code, and matching SillyTavern feature for feature is not a goal. This page lists what carries over from SillyTavern and what works differently. [The concept](concept.md) explains the reasons.

## What carries over

Teahouse imports **character cards** (PNG or JSON, V1 to V3) as they are. The card becomes a Markdown file in `characters/`, each lorebook entry becomes a file in `lore/`, the card image becomes the character's default image, and the greetings stay greetings.

Lorebook logic (secondary keys, `selective`, `constant`, depth, order, recursion) is not carried over. Instead, Teahouse includes files in the story by their name, aliases and tags, as far as they fit into what the model can read. The keys of a lorebook entry become its tags and aliases.

Teahouse works with any endpoint that offers OpenAI-compatible chat completion. It doesn't support text completion or SillyTavern presets.

Chat logs, presets, sprite folders and World Info outside a card can't be imported yet ([#99](https://github.com/Linyeir/teahouse/issues/99), [#103](https://github.com/Linyeir/teahouse/issues/103)). To bring a story over anyway, export the chat as text and give it to an AI agent together with [Converting chats into a world](converting-chats.md): the agent writes a world folder from it, with characters, places and the story so far.

## What works differently

| In SillyTavern | In Teahouse |
|---|---|
| One long chat | A chat is a series of scenes, and you end each scene yourself |
| Chat summaries and World Info that you maintain | After each scene, Teahouse proposes what the world should remember, and you review the proposal file by file |
| Lorebook entries | Markdown files in a folder with a Git history, which you can edit in any editor |
| Group chats | Any character of the world can join a scene, you pick who speaks next, and a narrator describes what happens around the characters |
| Sprites and backgrounds through extensions | Built in: images by mood for each character, and backgrounds for each world |
| One app per device | One server, and apps and browsers that sync through it and also work offline |

[How Teahouse works](how-it-works.md) explains all of this in the order in which you meet it while playing.
