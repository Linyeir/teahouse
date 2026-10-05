import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Three-way merge with `git merge-file`: the proposal was made against `base`, the file is
 * now `current`. Returns the merged text and whether conflict markers remain.
 */
export async function mergeThreeWay(
  current: string,
  base: string,
  proposal: string,
): Promise<{ text: string; conflicts: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'teahouse-merge-'));
  try {
    const files = {
      current: join(dir, 'current'),
      base: join(dir, 'base'),
      proposal: join(dir, 'proposal'),
    };
    await Promise.all([
      writeFile(files.current, current),
      writeFile(files.base, base),
      writeFile(files.proposal, proposal),
    ]);
    const args = ['merge-file', '-p', '-L', 'current', '-L', 'base', '-L', 'proposal'];
    return await new Promise((resolve, reject) => {
      execFile('git', [...args, files.current, files.base, files.proposal], (err, stdout) => {
        // Exit code = number of conflicts (capped at 127); anything else is a real failure.
        const code = err && typeof err.code === 'number' ? err.code : 0;
        if (err && (typeof err.code !== 'number' || code < 0 || code > 127)) reject(err);
        else resolve({ text: stdout, conflicts: code > 0 });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
