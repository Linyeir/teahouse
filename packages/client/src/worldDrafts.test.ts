import { describe, expect, it } from 'vitest';
import { clearDraft, clearDrafts, getDraft, setDraft } from './worldDrafts.ts';

const base = { base: '# Mira\n', baseSha: 'a'.repeat(40) };

describe('world file drafts', () => {
  it('keeps an edit while other files are opened, until it is saved or discarded', () => {
    setDraft('w1', 'characters/mira.md', { ...base, text: '# Mira\nA smuggler.\n' });
    // Opening another file does not touch it.
    expect(getDraft('w1', 'characters/ash.md')).toBeUndefined();
    expect(getDraft('w1', 'characters/mira.md')).toEqual({
      ...base,
      text: '# Mira\nA smuggler.\n',
    });
    clearDraft('w1', 'characters/mira.md');
    expect(getDraft('w1', 'characters/mira.md')).toBeUndefined();
  });

  it('is clean again when the text is typed back to its base', () => {
    setDraft('w2', 'lore/fog.md', { ...base, text: 'changed' });
    setDraft('w2', 'lore/fog.md', { ...base, text: base.base });
    expect(getDraft('w2', 'lore/fog.md')).toBeUndefined();
  });

  it('discards the drafts of one world only', () => {
    setDraft('w3', 'a.md', { ...base, text: 'x' });
    setDraft('w3', 'b.md', { ...base, text: 'y' });
    setDraft('w4', 'a.md', { ...base, text: 'z' });
    clearDrafts('w3');
    expect(getDraft('w3', 'a.md')).toBeUndefined();
    expect(getDraft('w3', 'b.md')).toBeUndefined();
    expect(getDraft('w4', 'a.md')?.text).toBe('z');
  });
});
