import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The banners reach the browser through api.ts and i18n.ts.
vi.stubGlobal('window', new EventTarget());
vi.stubGlobal('navigator', { language: 'en', userAgent: '' });
const { ErrorBanner, GenerationError, NoProfileNotice } = await import('./ErrorBanner.tsx');
const { RequestError } = await import('../api.ts');
const i18n = (await import('../i18n.ts')).default;

const render = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
/** The actions of a banner: buttons and links. */
const actions = (html: string) =>
  [...html.matchAll(/<(button|a)\b[^>]*>([^<]*)</g)].map((m) => m[2]);

describe('error banners in a chat', () => {
  beforeAll(() => i18n.changeLanguage('en'));

  it('offers Retry and the profiles for a failed reply', () => {
    const html = render(<GenerationError message="Not found (404)" onRetry={() => {}} />);
    expect(html).toContain('Generation failed: Not found (404)');
    expect(actions(html)).toEqual(['Open Profiles', 'Retry']);
    expect(html).toContain('href="/profiles"');
  });

  it('still offers the profiles when a failed reply cannot be retried', () => {
    expect(actions(render(<GenerationError message="x" />))).toEqual(['Open Profiles']);
  });

  it('sends a missing profile to Profiles instead of offering a retry that fails again', () => {
    const error = new RequestError(409, 'no_profile', 'No profile');
    expect(actions(render(<ErrorBanner error={error} onRetry={() => {}} />))).toEqual([
      'Open Profiles',
    ]);
  });

  it('offers Retry for any other failed action', () => {
    const html = render(<ErrorBanner error={new Error('busy')} onRetry={() => {}} />);
    expect(actions(html)).toEqual(['Retry']);
  });

  it('tells the composer without a profile where to connect a model', () => {
    const html = render(<NoProfileNotice />);
    expect(html).toContain('Connect a model to play');
    expect(actions(html)).toEqual(['Open Profiles']);
  });
});
