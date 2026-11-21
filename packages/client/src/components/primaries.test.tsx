import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CharacterSummary, Profile } from '@teahouse/shared';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The views reach the browser through api.ts and i18n.ts.
vi.stubGlobal('window', new EventTarget());
vi.stubGlobal('navigator', { language: 'en', userAgent: '' });
const { CharacterRow, GroupChatStart } = await import('./StartChat.tsx');
const { ProfilesView } = await import('../views/ProfilesView.tsx');
const ui = (await import('./ui.module.css')).default;
const i18n = (await import('../i18n.ts')).default;

/** How many main buttons a piece of markup has. */
const primaries = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].filter((m) => m[1]?.split(' ').includes(ui.primary ?? ''))
    .length;

function render(node: ReactNode, data: [unknown[], unknown][] = []): string {
  const client = new QueryClient();
  for (const [key, value] of data) client.setQueryData(key, value);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const character = (slug: string): CharacterSummary =>
  ({ slug, name: slug, summary: '', greetings: ['Hi'], images: [] }) as unknown as CharacterSummary;

// #61: one main action per region, so it reads as the main one.
describe('main buttons', () => {
  beforeAll(() => i18n.changeLanguage('en'));

  it('a world’s characters have none in their rows', () => {
    const characters = ['a', 'b', 'c'].map(character);
    const html = render(
      <ul>
        {characters.map((c) => (
          <CharacterRow key={c.slug} worldId="w" character={c} />
        ))}
        <GroupChatStart worldId="w" characters={characters} />
      </ul>,
    );
    expect(html).toContain('Start chat');
    expect(primaries(html)).toBe(0);
  });

  it('the profiles page has one', () => {
    const profile = (id: string) =>
      ({ id, name: id, model: 'm', baseUrl: 'http://x' }) as unknown as Profile;
    const html = render(<ProfilesView />, [
      [['profiles'], ['a', 'b', 'c'].map(profile)],
      [['endpoint-presets'], []],
    ]);
    expect(html).toContain('http://x');
    expect(primaries(html)).toBe(1);
  });
});
