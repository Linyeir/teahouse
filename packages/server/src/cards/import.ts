import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CardImportResult } from '@teahouse/shared';
import { newId } from '../time.ts';
import { parseDocument, stringifyDocument } from '../worlds/frontmatter.ts';
import { slug, type WorldService } from '../worlds/service.ts';
import { type BookEntry, type CardData, isPng, parseCard } from './parse.ts';

export interface ImportTarget {
  /** Import into this world… */
  worldId?: string;
  /** …or create a new one with this name (defaults to the character's name). */
  newWorldName?: string;
}

const section = (heading: string, text: string) =>
  text.trim() ? `## ${heading}\n\n${text.trim()}` : '';

const join2 = (...parts: string[]) =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');

/**
 * Imports a Character Card into a world: one character file, one lore file per lorebook
 * entry, the card image as the character's default image, all in one commit.
 */
export async function importCard(
  worlds: WorldService,
  bytes: Uint8Array,
  target: ImportTarget,
): Promise<CardImportResult> {
  const { data } = parseCard(bytes);
  const isNewWorld = !target.worldId;
  const worldId = target.worldId ?? (await worlds.create(target.newWorldName || data.name)).id;

  let characterSlug = '';
  const files: string[] = [];

  await worlds.transaction(worldId, `Import character card: ${data.name}`, async (dir) => {
    const characterPath = await worlds.uniquePath(dir, 'characters', slug(data.name, 'character'));
    characterSlug = characterPath.slice('characters/'.length, -'.md'.length);

    const images = [];
    if (isPng(bytes)) {
      const imageId = newId();
      const file = `assets/characters/${characterSlug}/${imageId}.png`;
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), bytes);
      images.push({ id: imageId, label: 'neutral', file });
    }

    if (isNewWorld && data.scenario.trim()) {
      const worldPath = join(dir, 'world.md');
      const doc = parseDocument(await readFile(worldPath, 'utf8'));
      await writeFile(
        worldPath,
        stringifyDocument({
          data: doc.data,
          body: join2(doc.body, section('Scenario', data.scenario)),
        }),
      );
      files.push('world.md');
    }

    await writeFile(join(dir, characterPath), characterFile(data, images, !isNewWorld));
    files.push(characterPath);

    for (const entry of data.character_book?.entries ?? []) {
      if (!entry.content.trim()) continue;
      const title = entryTitle(entry);
      const path = await worlds.uniquePath(dir, 'lore', slug(title, 'entry'));
      await writeFile(join(dir, path), loreFile(entry, title));
      files.push(path);
    }
  });

  return { worldId, characterSlug, files };
}

function characterFile(
  data: CardData,
  images: { id: string; label: string; file: string }[],
  scenarioInCharacter: boolean,
): string {
  const greetings = [data.first_mes, ...data.alternate_greetings].filter((g) => g.trim());
  const frontmatter: Record<string, unknown> = {
    type: 'character',
    name: data.name,
    tags: data.tags,
    aliases: [],
    summary: firstSentence(data.description) || data.name,
    greetings,
    images,
  };
  // Kept for the character template layer; not part of the prompt yet.
  if (data.system_prompt.trim()) frontmatter.system_prompt = data.system_prompt;
  if (data.post_history_instructions.trim()) {
    frontmatter.post_history_instructions = data.post_history_instructions;
  }
  if (data.creator_notes.trim()) frontmatter.creator_notes = data.creator_notes;

  const body = join2(
    `# ${data.name}`,
    data.description.trim(),
    section('Personality', data.personality),
    scenarioInCharacter ? section('Scenario', data.scenario) : '',
    section('Example dialogue', data.mes_example),
  );
  return stringifyDocument({ data: frontmatter, body });
}

function loreFile(entry: BookEntry, title: string): string {
  const frontmatter: Record<string, unknown> = {
    type: 'lore',
    name: title,
    tags: entry.keys.map((k) => k.trim()).filter(Boolean),
    aliases: [],
    summary: firstSentence(entry.content),
  };
  if (!entry.enabled) frontmatter.enabled = false;
  return stringifyDocument({ data: frontmatter, body: `# ${title}\n\n${entry.content.trim()}` });
}

const entryTitle = (entry: BookEntry) =>
  (entry.comment || entry.name || entry.keys[0] || 'Entry').trim().slice(0, 80);

/** First sentence, capped, as a fallback summary until the user or the LLM writes one. */
function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = /^.{1,240}?[.!?](?=\s|$)/.exec(clean);
  return (match?.[0] ?? clean.slice(0, 240)).trim();
}
