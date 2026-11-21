import type { CustomTheme, InstalledTheme, World } from '@teahouse/shared';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PackageError, readZip, safePath } from '../src/packages/zip.ts';
import { checkValue, parseThemeCss } from '../src/themes/css.ts';
import { buildTheme } from '../src/themes/package.ts';
import { createTestApp } from './helpers.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [
        name,
        typeof data === 'string' ? strToU8(data) : data,
      ]),
    ),
  );
}

const files = (entries: Record<string, string | Uint8Array>) =>
  new Map(
    Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v] as const),
  );

const resolveNothing = () => null;

/** Every `url()` in the CSS points at an inlined file: nothing can be loaded from elsewhere. */
function loadsOnlyInlinedFiles(css: string) {
  const urls = [...css.matchAll(/url\(\s*("?)([^")]*)/gi)].map((m) => m[2]);
  return urls.every((u) => u?.startsWith('data:')) && !/@import|image-set|\\/i.test(css);
}

describe('theme CSS', () => {
  it('keeps custom properties in :root blocks for light, dark or both', () => {
    const { blocks, notes } = parseThemeCss(
      `:root { --color-bg: #fff; color-scheme: light; }
       :root[data-preset="mine"][data-theme="dark"] { --color-bg: #111 }
       :root[data-theme='light'] { --color-text: #222; }`,
      resolveNothing,
    );
    expect(notes).toEqual([]);
    expect(blocks.base).toEqual([
      { property: '--color-bg', value: '#fff' },
      { property: 'color-scheme', value: 'light' },
    ]);
    expect(blocks.dark).toEqual([{ property: '--color-bg', value: '#111' }]);
    expect(blocks.light).toEqual([{ property: '--color-text', value: '#222' }]);
  });

  it('accepts a built-in theme block as it is', () => {
    const { blocks, notes } = parseThemeCss(
      `:root[data-preset="sakura"] {
        --sakura-round: "Zen Maru Gothic", system-ui, sans-serif;
        --page-background: radial-gradient(circle at 0% 100%, rgb(244 196 214 / 90%), transparent 45%);
      }`,
      resolveNothing,
    );
    expect(notes).toEqual([]);
    expect(blocks.base).toHaveLength(2);
  });

  it('leaves out everything that is not a variable', () => {
    const { blocks, notes } = parseThemeCss(
      `:root { color: red; --ok: 1px; }
       body { --color-bg: red; }
       .button { display: none; }
       :root .sidebar { --x: 1; }
       @media (min-width: 1px) { :root { --color-bg: red; } }
       @font-face { font-family: X; src: url(x.woff2); }
       @import url("https://evil.example/x.css");
       :root { :root { --nested: 1 } }`,
      resolveNothing,
    );
    expect(blocks.base).toEqual([{ property: '--ok', value: '1px' }]);
    expect(notes.map((n) => n.code)).toEqual([
      'not-variable',
      'unsupported-rule',
      'unsupported-rule',
      'unsupported-rule',
      'unsupported-rule',
      'unsupported-rule',
      'unsupported-rule',
      'unsupported-rule',
    ]);
  });

  it.each([
    'url(https://evil.example/x.png)',
    'url("http://evil.example/x.png")',
    'url(//evil.example/x.png)',
    'url(/api/devices)',
    'url(../../etc/passwd)',
    'url(data:image/png;base64,AAAA)',
    'url(javascript:alert(1))',
    'u\\72l(https://evil.example/x.png)',
    'url(\\68ttps://evil.example/x.png)',
    'image-set("https://evil.example/x.png" 1x)',
    '-webkit-image-set("x.png" 1x)',
    'image("https://evil.example/x.png")',
    'src("https://evil.example/x.png")',
    'expression(alert(1))',
    'red; } body { background: url(https://evil.example/x.png)',
    '"</style><script>alert(1)</script>"',
    'url(x.png',
    '"url(x.png)',
  ])('refuses %s', (value) => {
    const checked = checkValue(value, () => 'data:image/png;base64,AAAA');
    expect(checked.ok).toBe(false);
  });

  it('inlines files of the package and refuses missing ones', () => {
    expect(
      checkValue('url(img/bg.png) center / cover', () => 'data:image/png;base64,iVBO'),
    ).toEqual({ ok: true, value: 'url("data:image/png;base64,iVBO") center / cover' });
    expect(checkValue('url("missing.png")', resolveNothing)).toEqual({
      ok: false,
      code: 'missing-file',
      detail: 'missing.png',
    });
  });

  it('never lets a hostile theme load anything from outside its package', () => {
    const hostile = `
      @import url(https://evil.example/a.css);
      :root {
        --a: url(https://evil.example/a.png);
        --b: url(bg.png), url(//evil.example/b.png);
        --c: u\\72l(https://evil.example/c.png);
        --d: image-set("https://evil.example/d.png" 1x);
        --e: url(bg.png) no-repeat;
        --f: "a;b"; --g: url(../bg.png);
      }
      :root[data-theme="dark"] { --h: url( 'bg.png' ) }
      html body { background: url(https://evil.example/e.png) }`;
    const built = buildTheme(files({ 'theme.css': hostile, 'bg.png': PNG }));
    expect(loadsOnlyInlinedFiles(built.template)).toBe(true);
    expect(built.template).not.toContain('evil.example');
    expect(built.template).toContain('--e: url("data:image/png;base64,');
    expect(built.template).toContain('--h: url("data:image/png;base64,');
    expect(built.template).toContain('--f: "a;b";');
  });
});

describe('theme packages', () => {
  it('reads name, author, modes and fonts from theme.json', () => {
    const built = buildTheme(
      files({
        'theme.json': JSON.stringify({
          id: 'Rain Port',
          name: 'Rain Port',
          author: 'Alex',
          modes: ['dark'],
          fonts: [
            { family: 'Lora', file: 'fonts/lora.woff2', weight: 400 },
            { family: 'Gone', file: 'fonts/gone.woff2' },
            { family: 'Bad"; } body {', file: 'fonts/lora.woff2' },
          ],
        }),
        'theme.css': ':root { --font-story: "Lora", serif; }',
        'fonts/lora.woff2': FONT,
      }),
    );
    expect(built).toMatchObject({ id: 'rain-port', name: 'Rain Port', author: 'Alex' });
    expect(built.modes).toEqual(['dark']);
    expect(built.template).toContain('font-family: "Lora"');
    expect(built.template).toContain('url("data:font/woff2;base64,');
    expect(built.notes).toEqual([
      { code: 'missing-font', detail: 'fonts/gone.woff2' },
      { code: 'bad-manifest', detail: 'fonts' },
    ]);
  });

  it('works without theme.json and guesses the modes', () => {
    expect(buildTheme(files({ 'theme.css': ':root { --x: 1 }' })).modes).toEqual(['light']);
    expect(
      buildTheme(files({ 'theme.css': ':root { --x: 1 } :root[data-theme=dark] { --x: 2 }' }))
        .modes,
    ).toEqual(['light', 'dark']);
    expect(buildTheme(files({ 'mine.css': ':root { color-scheme: dark; --x: 1 }' }))).toMatchObject(
      { id: 'mine', modes: ['dark'] },
    );
  });

  it('needs a theme.css', () => {
    expect(() => buildTheme(files({ 'readme.txt': 'hi' }))).toThrow(PackageError);
  });
});

describe('package ZIPs', () => {
  it('drops a single top folder', () => {
    const read = readZip(zip({ 'my-theme/theme.css': ':root{}', 'my-theme/a/b.png': PNG }), {
      maxBytes: 1e6,
      maxFiles: 10,
    });
    expect([...read.keys()].sort()).toEqual(['a/b.png', 'theme.css']);
  });

  it('leaves out paths outside the package, .git and macOS metadata', () => {
    const read = readZip(
      zip({
        'theme.css': ':root{}',
        '../evil.css': 'x',
        '/etc/evil': 'x',
        'a/../../evil': 'x',
        '.git/hooks/pre-commit': 'x',
        '__MACOSX/._theme.css': 'x',
      }),
      { maxBytes: 1e6, maxFiles: 10 },
    );
    expect([...read.keys()]).toEqual(['theme.css']);
    expect(safePath('C:/windows')).toBe(false);
    expect(safePath('a\\..\\..\\b')).toBe(false);
  });

  it('refuses packages that are too large or have too many files', () => {
    const big = zip({ 'theme.css': 'x'.repeat(2000) });
    expect(() => readZip(big, { maxBytes: 1000, maxFiles: 10 })).toThrow(/Larger/);
    const many = zip(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.png`, PNG])));
    expect(() => readZip(many, { maxBytes: 1e6, maxFiles: 4 })).toThrow(/More than/);
    expect(() => readZip(strToU8('not a zip'), { maxBytes: 1e6, maxFiles: 4 })).toThrow(
      PackageError,
    );
  });
});

describe('theme routes', () => {
  async function upload(ctx: Awaited<ReturnType<typeof createTestApp>>, bytes: Uint8Array) {
    const boundary = '----teahouse';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.zip"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/themes',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    return { status: res.statusCode, body: res.json() };
  }

  const pkg = zip({
    'theme.json': JSON.stringify({ name: 'Rain Port' }),
    'theme.css': ':root { --color-bg: #123; --x: url(https://evil.example/x.png); }',
  });

  it('installs, lists, serves and removes a theme', async () => {
    const ctx = await createTestApp();
    const res = await upload(ctx, pkg);
    expect(res.status).toBe(200);
    const installed = res.body as InstalledTheme;
    expect(installed.theme).toMatchObject({ id: 'rain-port', name: 'Rain Port', modes: ['light'] });
    expect(installed.notes).toEqual([
      { code: 'blocked-value', detail: 'https://evil.example/x.png' },
    ]);

    const list = await ctx.api<CustomTheme[]>('GET', '/api/themes');
    expect(list.body.map((t) => t.id)).toEqual(['rain-port']);
    const css = await ctx.api<{ css: string }>('GET', '/api/themes/rain-port/css');
    expect(css.body.css).toContain(':root[data-preset="rain-port"][data-theme] {');
    expect(css.body.css).toContain('--color-bg: #123;');
    expect(css.body.css).not.toContain('evil');

    expect((await ctx.api('DELETE', '/api/themes/rain-port')).status).toBe(200);
    expect((await ctx.api<CustomTheme[]>('GET', '/api/themes')).body).toEqual([]);
    expect((await ctx.api('GET', '/api/themes/rain-port/css')).status).toBe(404);
    expect((await ctx.api('GET', '/api/themes/..%2F..%2Fetc/css')).status).toBe(404);
  });

  it('gives a taken ID a number instead of refusing the upload', async () => {
    const ctx = await createTestApp();
    await upload(ctx, pkg);
    const second = (await upload(ctx, pkg)).body as InstalledTheme;
    expect(second.theme).toMatchObject({ id: 'rain-port-2', name: 'Rain Port (2)' });
    expect(second.notes).toContainEqual({ code: 'renamed', detail: 'rain-port-2' });
    const builtIn = (
      await upload(ctx, zip({ 'theme.json': '{"id":"nord"}', 'theme.css': ':root{}' }))
    ).body as InstalledTheme;
    expect(builtIn.theme.id).toBe('nord-2');
  });

  it('says in a code what is wrong with a file that is no theme', async () => {
    const ctx = await createTestApp();
    expect(await upload(ctx, strToU8('hello'))).toMatchObject({
      status: 400,
      body: { error: 'not-zip' },
    });
    expect(await upload(ctx, zip({ 'readme.md': 'hi' }))).toMatchObject({
      status: 400,
      body: { error: 'no-theme-css' },
    });
  });

  it('lets a world name an uploaded theme', async () => {
    const ctx = await createTestApp();
    const world = await ctx.worlds.create('Rain Port');
    const doc = await ctx.worlds.read(world.id, 'world.md');
    await ctx.worlds.write(
      world.id,
      'world.md',
      doc.replace('type: world', 'type: world\nthemePreset: rain-port'),
    );
    const worlds = (await ctx.api<World[]>('GET', '/api/worlds')).body;
    expect(worlds.find((w) => w.id === world.id)?.themePreset).toBe('rain-port');
  });
});
