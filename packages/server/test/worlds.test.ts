import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument, stringifyDocument } from '../src/worlds/frontmatter.ts';
import { WorldWatcher } from '../src/worlds/watcher.ts';
import { createTestApp, tempWorlds } from './helpers.ts';

describe('frontmatter', () => {
  it('round-trips data and body', () => {
    const text = stringifyDocument({ data: { type: 'lore', tags: ['a', 'b'] }, body: '# Title' });
    expect(text).toBe('---\ntype: lore\ntags:\n  - a\n  - b\n---\n\n# Title\n');
    expect(parseDocument(text)).toEqual({
      data: { type: 'lore', tags: ['a', 'b'] },
      body: '# Title\n',
    });
  });

  it('treats files without frontmatter as body and reports invalid YAML', () => {
    expect(parseDocument('just text')).toEqual({ data: {}, body: 'just text' });
    expect(parseDocument('---\n: [\n---\nbody').error).toBeTruthy();
  });
});

describe('worlds', () => {
  it('creates a world folder with canon structure and an initial commit', async () => {
    const worlds = await tempWorlds();
    const world = await worlds.create('Rain Port');
    expect(world.folder).toBe('rain-port');
    expect((await worlds.list()).map((w) => w.name)).toEqual(['Rain Port']);
    expect((await worlds.files(world.id)).map((f) => f.path)).toEqual(['user.md', 'world.md']);
    expect((await worlds.history(world.id)).map((c) => c.message)).toEqual([
      'Create world Rain Port',
    ]);
    const gitignore = await readFile(join(worlds.dir(world.folder), '.gitignore'), 'utf8');
    expect(gitignore).toContain('assets/');
  });

  it('commits every write and can read old versions', async () => {
    const worlds = await tempWorlds();
    const { id } = await worlds.create('W');
    const first = await worlds.write(id, 'places/harbor.md', 'v1');
    await worlds.write(id, 'places/harbor.md', 'v2');
    expect(await worlds.write(id, 'places/harbor.md', 'v2')).toBeNull(); // nothing changed

    const history = await worlds.history(id, 'places/harbor.md');
    expect(history.map((c) => c.message)).toEqual([
      'Edit places/harbor.md',
      'Edit places/harbor.md',
    ]);
    expect(await worlds.readAt(id, first ?? '', 'places/harbor.md')).toBe('v1');
  });

  it('rejects paths outside the canon', async () => {
    const worlds = await tempWorlds();
    const { id } = await worlds.create('W');
    for (const path of [
      '../escape.md',
      '.git/config.md',
      'assets/x.md',
      '/etc/x.md',
      'notes.txt',
    ]) {
      await expect(worlds.write(id, path, 'x')).rejects.toThrow();
    }
  });

  it('adopts a world folder created by hand', async () => {
    const worlds = await tempWorlds();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(worlds.root, 'manual'));
    await writeFile(join(worlds.root, 'manual', 'world.md'), '---\nname: Manual\n---\n\nHi');
    const [world] = await worlds.list();
    expect(world?.name).toBe('Manual');
    const text = await readFile(join(worlds.root, 'manual', 'world.md'), 'utf8');
    expect(parseDocument(text).data.id).toBe(world?.id);
    expect((await worlds.history(world?.id ?? '')).map((c) => c.message)).toEqual(['Add world ID']);
  });

  it('commits edits made outside Teahouse', async () => {
    const worlds = await tempWorlds();
    const { id, folder } = await worlds.create('W');
    const watcher = new WorldWatcher(worlds, 50);
    await watcher.start();
    try {
      await writeFile(join(worlds.dir(folder), 'lore', 'moon.md'), '# The moon');
      await writeFile(join(worlds.dir(folder), 'lore', '.moon.md.swp'), 'editor junk');
      for (let i = 0; i < 100; i++) {
        if ((await worlds.history(id)).length > 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect((await worlds.history(id))[0]?.message).toBe('Edit outside Teahouse');
      expect((await worlds.files(id)).map((f) => f.path)).toContain('lore/moon.md');
    } finally {
      await watcher.stop();
    }
  });
});

describe('world routes', () => {
  it('serves canon files with history and refuses escapes', async () => {
    const { api, app, token } = await createTestApp();
    const world = await api<{ id: string }>('POST', '/api/worlds', { name: 'W' });
    const base = `/api/worlds/${world.body.id}`;

    const put = await api<{ commit: string }>('PUT', `${base}/file`, {
      path: 'places/harbor.md',
      content: '# Harbor',
    });
    expect(put.status).toBe(200);
    expect((await api('GET', `${base}/file?path=places/harbor.md`)).body).toEqual({
      path: 'places/harbor.md',
      content: '# Harbor',
    });
    const history = await api<{ sha: string }[]>('GET', `${base}/history?path=places/harbor.md`);
    const old = await api(
      'GET',
      `${base}/file-at?path=places/harbor.md&sha=${history.body[0]?.sha}`,
    );
    expect(old.status).toBe(200);

    for (const path of ['../x.md', '.git/x.md', 'assets/x.md']) {
      const res = await api('PUT', `${base}/file`, { path, content: 'x' });
      expect(res.status, path).toBe(400);
    }
    const sha = await api('GET', `${base}/file-at?path=world.md&sha=--output=x`);
    expect(sha.status).toBe(400);

    for (const asset of ['..%2Fworld.md', '..%2F..%2Fsecret.png', 'missing.png']) {
      const res = await app.inject({ url: `${base}/assets/${asset}?token=${token}` });
      expect(res.statusCode, asset).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, asset).toBeLessThan(500);
    }
    expect((await app.inject({ url: `${base}/assets/x.png` })).statusCode).toBe(401);
  });
});
