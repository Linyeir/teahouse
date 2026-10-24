import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileConflict, FileContent, FileWritten } from '@teahouse/shared';
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
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
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

describe('saving against the base', () => {
  it('refuses a save from an editor opened before a canon commit', async () => {
    const { api, worlds } = await createTestApp();
    const world = await worlds.create('Rain Port');
    const path = 'characters/mira.md';
    await worlds.write(world.id, path, 'Mira, a smuggler.\n');
    const url = `/api/worlds/${world.id}/file`;

    // The editor opens the file…
    const opened = await api<FileContent>('GET', `${url}?path=${path}`);
    const sha = execFileSync('git', ['hash-object', '--stdin'], { input: 'Mira, a smuggler.\n' });
    expect(opened.body.sha).toBe(sha.toString().trim());

    // …then the canon update of a scene changes it, the way CanonProposals.apply writes.
    await worlds.transaction(world.id, 'Canon: scene 1', async (dir) => {
      await writeFile(join(dir, path), 'Mira, a smuggler. Owes Ash.\n');
    });

    const saved = await api<FileConflict>('PUT', url, {
      path,
      content: 'Mira, a retired smuggler.\n',
      baseSha: opened.body.sha,
    });
    expect(saved.status).toBe(409);
    expect(saved.body).toMatchObject({
      error: 'file_conflict',
      current: 'Mira, a smuggler. Owes Ash.\n',
    });
    expect(await worlds.read(world.id, path)).toBe('Mira, a smuggler. Owes Ash.\n');
    expect((await worlds.history(world.id, path))[0]?.message).toBe('Canon: scene 1');

    // Saving against what is there now works, and answers with the new sha.
    const retry = await api<FileWritten>('PUT', url, {
      path,
      content: 'Mira, a retired smuggler. Owes Ash.\n',
      baseSha: saved.body.currentSha,
    });
    expect(retry.status).toBe(200);
    const reread = await api<FileContent>('GET', `${url}?path=${path}`);
    expect(retry.body.sha).toBe(reread.body.sha);
  });

  it('reports a file deleted in the meantime, and still saves without a base', async () => {
    const { api, worlds } = await createTestApp();
    const world = await worlds.create('W');
    const url = `/api/worlds/${world.id}/file`;
    await worlds.write(world.id, 'lore/fog.md', 'Fog.\n');
    const { body } = await api<FileContent>('GET', `${url}?path=lore/fog.md`);
    await worlds.remove(world.id, 'lore/fog.md');

    const stale = await api<FileConflict>('PUT', url, {
      path: 'lore/fog.md',
      content: 'Thick fog.\n',
      baseSha: body.sha,
    });
    expect(stale).toMatchObject({ status: 409, body: { current: null, currentSha: null } });

    // Older clients send no base: the file is written as before.
    const old = await api('PUT', url, { path: 'lore/fog.md', content: 'Thick fog.\n' });
    expect(old.status).toBe(200);
    expect(await worlds.read(world.id, 'lore/fog.md')).toBe('Thick fog.\n');
  });
});
