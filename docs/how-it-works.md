# How Teahouse works

This page explains what happens while you play: how chats are split into scenes, whose turn it is, how the model keeps track of a long story, and how the world is updated from your scenes. You can start playing without reading it.

## Worlds, chats and scenes

A **world** holds the setting, the characters, places and lore, and a record of past events. You can have several worlds. Each one is a folder of files, which [Worlds](worlds.md) describes.

A **chat** is one story in a world, with you and one or more of its characters. A chat is made of **scenes**, and a scene is one stretch of time in one place, such as "the crate on the pier at night".

You end a scene yourself with **End scene**. To start the next one, you write a few words about what happens next, and Teahouse proposes an opening and the characters who are present. You can change both before you start.

Scenes exist because a model can only read a limited amount of text at once. In one long chat, the beginning eventually drops out of what the model sees. At the end of each scene, Teahouse writes down what mattered, so the next scene starts short but still has the story.

## Turns

Each reply is one character's turn. Above the text field you pick who takes the next turn. You can pick a character in the scene, the **narrator**, or someone else from the world, who then joins the scene. The narrator only describes what happens around the characters. You can also tap a character on the stage to give them the turn.

If you leave the text field empty and press **Continue**, the next character acts without a line from you.

Each character speaks only in their own turn. If the model starts to write your lines or another character's lines, Teahouse cuts the reply at that point.

## The novel view

The novel view shows the background, the characters who are present, and the reply in a text box under the speaker's name. Each character's image matches the mood of their last line. Click, Space or Enter go to the next part, the arrow keys step between messages, and **Log** shows the whole scene as text.

**Branch from here** in the ⋯ menu on an earlier page takes the story back to that message. Your next message then starts a new branch, and you can switch back to the old branch with ‹ ›.

<details>
<summary>How replies are marked up</summary>

The model writes its replies in a small tag format, and the view turns the tags into the stage while the reply streams in:

```
<bg id="harbor-night"/>
<narration>Fog rolls in off the water.</narration>
<say who="mira" mood="neutral">You came alone. Good.</say>
<leave who="tomas"/>
```

The `bg` tag changes the background, `narration` is description, `say` is the speech of one character with a mood that picks their image, and `leave` takes a character off the stage. You upload the images and backgrounds in the world, each with a label such as `neutral` or `amused`.

</details>

## Memory while a scene runs

Each request to the model contains three parts: the world files that matter right now, a summary of the scene so far, and the latest messages word for word.

Teahouse chooses the world files in this order:

1. the world itself, your persona, and the characters who are present,
2. the last two events of this chat,
3. any file whose name, alias or tag appears in the recent story,
4. older events.

If the files don't all fit, Teahouse shortens them to their summary and then leaves them out, starting with the oldest events. The first group is shortened last and is never left out.

Because files are found by name, alias and tag, **aliases** are important. If Mira is also called "the Fox", give her file that alias, so that her file is included when someone says "the Fox".

A **scene summary** (Active Memory) is written only for long scenes. After each reply, Teahouse checks the length of the scene. When the scene would no longer fit, Teahouse summarizes its older part in the background. From then on, the model gets that summary plus the recent messages. The opening of the scene and the last three turns are always included word for word.

Teahouse uses a model for four jobs: writing replies, summarizing, updating the world, and proposing openings. Under **Settings**, each job can use its own model. A small, fast model is often enough for summaries.

## Ending a scene with canon

When you end a scene **with canon**, the model reads the scene and the files that the scene mentions. It then proposes changes to the world:

- a new event file that records what happened,
- additions to the files of characters, places and lore,
- new aliases, when the scene called someone by another name.

<p align="center"><img src="images/review.png" alt="The canon review: the scene's title and summary at the top, then one card per file with what changes, and Accept and Reject buttons." width="720"></p>

The review starts with the title and summary of the scene. Below that, each file has a card that says in words what changes, such as "Adds to „Relationships“". **Raw diff** shows the exact text. You accept, edit or reject each file, and Teahouse saves the accepted files together as one change in the history of the world.

The model may only add to a file that it hasn't read in full, so text that it didn't see stays as it is. Doubtful proposals, such as an alias that the scene never uses, are listed under **Not applied as proposed**.

If you edited a file while the review was waiting, Teahouse merges both changes. Where the two changes overlap, the file shows both versions, and you pick before you accept it.

End a scene **without canon** for side scenes that shouldn't change the world.

## Tidying up the world

After many scenes, a world collects small inconsistencies. **Tidy up the canon** on the world overview checks the whole world and suggests fixes for these problems:

- summaries that no longer match their file,
- contradictions between two files,
- duplicate files about the same person, place or thing,
- names that appear in several events but have no file,
- names that the events use for a file but that are missing from its aliases and tags.

<p align="center"><img src="images/cleanup.png" alt="The cleanup review: a card for the lighthouse file with a warning that it contradicts Tomas's file, quoting what Tomas's file says." width="720"></p>

You review the suggestions in the same way as the changes after a scene. A fix for a contradiction quotes what the other file says, so you can decide which side is right. When two character files are merged, the name of the removed file becomes an alias, and its chats move to the character that stays.

Event files are never changed, because they record what happened in play. Nothing is saved until you commit, even if you turned off the review for scenes.
