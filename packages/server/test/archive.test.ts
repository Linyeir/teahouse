import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatPath, World } from '@teahouse/shared';
import * as tar from 'tar';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { StreamFn } from '../src/generation.ts';
import { parseDocument } from '../src/worlds/frontmatter.ts';
import { createTestApp, profileBody } from './helpers.ts';

const stream: StreamFn = async function* () {
  yield '<narration>Mira nods.</narration>';
};

async function worldWithChat() {
  const ctx = await createTestApp(stream);
  await ctx.api('POST', '/api/profiles', profileBody('http://127.0.0.1:9/v1'));
  const world = await ctx.worlds.create('Rain Port');
  await ctx.worlds.write(
    world.id,
    'characters/mira.md',
    '---\ntype: character\nname: Mira\ngreetings:\n  - Hi.\n---\n\n# Mira\n',
  );
  const chat = (
    await ctx.api<ChatPath>('POST', '/api/chats', { worldId: world.id, characterSlug: 'mira' })
  ).body;
  await ctx.api('POST', `/api/chats/${chat.chat.id}/messages`, { content: 'Hello.' });
  for (let i = 0; i < 100; i++) {
    const p = (await ctx.api<ChatPath>('GET', `/api/chats/${chat.chat.id}`)).body;
    if (p.messages.at(-1)?.status === 'complete' && p.messages.length === 3) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  // An event that references the chat, as a canon update would write it.
  await ctx.worlds.write(
    world.id,
    'events/rain-port-scene-1.md',
    `---\ntype: event\nname: Hello\nchat: ${chat.chat.id}\nscene: ${chat.scene?.id}\norder: 1\nsummary: They met.\n---\n\n# Hello\n`,
  );
  return { ...ctx, world, chat };
}

async function download(ctx: Awaited<ReturnType<typeof worldWithChat>>, worldId: string) {
  const res = await ctx.app.inject({
    url: `/api/worlds/${worldId}/export`,
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-disposition']).toContain('.teahouse.tar.gz');
  return res.rawPayload;
}

async function upload(
  ctx: { app: Awaited<ReturnType<typeof createTestApp>>['app']; token: string },
  bytes: Buffer,
) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'world.tar.gz');
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/import/world',
    headers: { authorization: `Bearer ${ctx.token}` },
    body: form,
  });
  return { status: res.statusCode, body: res.json() };
}

describe('world archives', () => {
  it('moves a world and its chats to another server, without its Git repository', async () => {
    const source = await worldWithChat();
    const archive = await download(source, source.world.id);
    const entries: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const list = tar.t({ onReadEntry: (e) => entries.push(e.path) });
      list.on('end', resolve).on('error', reject);
      list.end(archive);
    });
    expect(entries).toContain('world/world.md');
    expect(entries.filter((p) => p.split('/').includes('.git'))).toEqual([]);

    const target = await createTestApp(stream);
    const imported = await upload(target, archive);
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ worldId: source.world.id, chats: 1, copy: false });

    const worlds = await target.api<World[]>('GET', '/api/worlds');
    expect(worlds.body.map((w) => w.name)).toEqual(['Rain Port']);
    const history = (await target.worlds.history(source.world.id)).map((c) => c.message);
    expect(history).toEqual(['Import Rain Port']); // a fresh repository, no history
    const path = await target.api<ChatPath>('GET', `/api/chats/${source.chat.chat.id}`);
    expect(path.body.messages.map((m) => m.content)).toEqual([
      'Hi.',
      'Hello.',
      '<narration>Mira nods.</narration>',
    ]);
  });

  it('imports into the same server as a copy with new IDs and rewritten event references', async () => {
    const ctx = await worldWithChat();
    const imported = await upload(ctx, await download(ctx, ctx.world.id));
    expect(imported.body.copy).toBe(true);
    expect(imported.body.worldId).not.toBe(ctx.world.id);

    const chats = await ctx.api<{ id: string; worldId: string }[]>('GET', '/api/chats');
    const copy = chats.body.find((c) => c.worldId === imported.body.worldId);
    expect(copy?.id).toBeDefined();
    expect(copy?.id).not.toBe(ctx.chat.chat.id);
    const path = await ctx.api<ChatPath>('GET', `/api/chats/${copy?.id}`);
    expect(path.body.messages).toHaveLength(3);

    const event = parseDocument(
      await ctx.worlds.read(imported.body.worldId, 'events/rain-port-scene-1.md'),
    );
    expect(event.data.chat).toBe(copy?.id);
    expect(event.data.scene).toBe(path.body.scene?.id);
    // The original is untouched.
    expect(
      await readFile(join(ctx.worlds.dir(ctx.world.folder), 'events/rain-port-scene-1.md'), 'utf8'),
    ).toContain(ctx.chat.chat.id);
  });

  it('rejects files that are not world archives, path escapes and links', async () => {
    const ctx = await createTestApp();
    expect((await upload(ctx, Buffer.from('not a tarball'))).status).toBe(400);

    const dir = await mkdtemp(join(tmpdir(), 'teahouse-evil-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'world'));
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ format: 'teahouse-world', version: 1, name: 'Evil', exportedAt: '' }),
    );
    await writeFile(join(dir, 'chats.json'), '[]');
    await writeFile(join(dir, 'world', 'world.md'), '---\nname: Evil\n---\n');
    await symlink('/etc/passwd', join(dir, 'world', 'leak.md'));
    const file = join(dir, 'evil.tar.gz');
    await tar.c({ gzip: true, cwd: dir, file }, ['manifest.json', 'chats.json', 'world']);
    const imported = await upload(ctx, await readFile(file));
    expect(imported.status).toBe(400); // the link is refused, not skipped
    expect((await ctx.worlds.list()).map((w) => w.name)).toEqual([]);
    await rm(join(dir, 'world', 'leak.md'));

    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ format: 'something-else', version: 1, name: 'x', exportedAt: '' }),
    );
    await tar.c({ gzip: true, cwd: dir, file }, ['manifest.json', 'chats.json', 'world']);
    expect((await upload(ctx, await readFile(file))).status).toBe(400);
  });

  it('never brings a Git repository along, so its hooks and config cannot run', async () => {
    const ctx = await createTestApp();
    const dir = await mkdtemp(join(tmpdir(), 'teahouse-hooks-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, 'pwned');
    const git = join(dir, 'world', '.git');
    await mkdir(join(git, 'hooks'), { recursive: true });
    await mkdir(join(git, 'objects'), { recursive: true });
    await mkdir(join(git, 'refs', 'heads'), { recursive: true });
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(git, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch ${marker}-fsmonitor"\n\thooksPath = .git/hooks\n`,
    );
    for (const hook of ['pre-commit', 'post-commit', 'commit-msg']) {
      await writeFile(join(git, 'hooks', hook), `#!/bin/sh\ntouch ${marker}-${hook}\n`);
      await chmod(join(git, 'hooks', hook), 0o755);
    }
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ format: 'teahouse-world', version: 1, name: 'Hooked', exportedAt: '' }),
    );
    await writeFile(join(dir, 'chats.json'), '[]');
    await writeFile(join(dir, 'world', 'world.md'), '---\nname: Hooked\n---\n');
    const file = join(dir, 'hooked.tar.gz');
    await tar.c({ gzip: true, cwd: dir, file }, ['manifest.json', 'chats.json', 'world']);

    const imported = await upload(ctx, await readFile(file));
    expect(imported.status).toBe(200);
    const folder = ctx.worlds.dir(imported.body.folder);
    await ctx.worlds.write(imported.body.worldId, 'lore/later.md', '---\ntype: lore\n---\n');

    for (const name of ['fsmonitor', 'pre-commit', 'post-commit', 'commit-msg']) {
      expect(await stat(`${marker}-${name}`).catch(() => null), name).toBeNull();
    }
    const config = await readFile(join(folder, '.git', 'config'), 'utf8');
    expect(config).not.toContain('fsmonitor');
    expect(config).not.toContain('hooksPath');
    expect(await stat(join(folder, '.git', 'hooks', 'pre-commit')).catch(() => null)).toBeNull();
  });
});
