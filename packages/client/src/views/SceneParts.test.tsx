import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CanonProposal } from '@teahouse/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The views reach the browser through api.ts and i18n.ts.
vi.stubGlobal('window', new EventTarget());
vi.stubGlobal('navigator', { language: 'en', userAgent: '' });
const { ProposalReview } = await import('./SceneParts.tsx');
const i18n = (await import('../i18n.ts')).default;

const proposal = (patch: Partial<CanonProposal>): CanonProposal => ({
  id: 'p',
  sceneId: 's',
  status: 'generating',
  error: null,
  files: [],
  notes: [],
  ...patch,
});

/** The review as it renders with `data` already loaded for the scene. */
function render(data: CanonProposal | null): string {
  const client = new QueryClient();
  client.setQueryData(['proposal', 's'], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProposalReview chatId="c" sceneId="s" />
    </QueryClientProvider>,
  );
}

describe('canon proposal review', () => {
  beforeAll(() => i18n.changeLanguage('en'));

  it('offers to propose again while a proposal is generating', () => {
    const html = render(proposal({ status: 'generating' }));
    expect(html).toContain('Writing the canon proposal');
    expect(html).toContain('Propose again');
  });

  it('offers to propose again when a closing scene has no proposal at all', () => {
    expect(render(null)).toContain('Propose again');
  });

  it('shows why a proposal failed, with a way to propose again', () => {
    const html = render(proposal({ status: 'failed', error: 'The server stopped' }));
    expect(html).toContain('The server stopped');
    expect(html).toContain('Propose again');
  });

  it('opens with what the world will remember, and the changes in words', () => {
    const html = render(
      proposal({
        status: 'ready',
        files: [
          {
            path: 'events/deal.md',
            before: null,
            after: '---\ntype: event\nname: The tavern deal\nsummary: Ash agreed.\nchat: c1\n---\n',
            decision: 'pending',
            changes: [{ op: 'event', detail: 'The tavern deal' }],
          },
          {
            path: 'characters/mira.md',
            before: '---\nname: Mira\n---\n',
            after: '---\nname: Mira\n---\n\n## Relationships\n\nOwes Ash.\n',
            decision: 'pending',
            changes: [{ op: 'append_section', detail: 'Relationships' }],
          },
        ],
      }),
    );
    expect(html).toContain('The tavern deal');
    expect(html).toContain('Ash agreed.');
    expect(html).toContain('2 changes: 1 new, 1 changed');
    expect(html).toContain('Adds to „Relationships“');
    expect(html).toContain('2 files still need a decision');
  });

  it('lists the changes that were not applied as proposed, in words', () => {
    const html = render(
      proposal({
        status: 'ready',
        notes: [
          {
            path: 'lore/fog.md',
            op: 'replace_section',
            code: 'unseen_replace',
            outcome: 'downgraded',
            reason: 'the file was not read in full',
            detail: 'Origin',
          },
        ],
      }),
    );
    expect(html).toContain('Not applied as proposed');
    expect(html).toContain('lore/fog.md');
    expect(html).toContain('instead of replacing it');
  });
});
