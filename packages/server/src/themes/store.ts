import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CustomTheme,
  type InstalledTheme,
  isThemeId,
  isThemePreset,
  type ThemeMode,
} from '@teahouse/shared';
import { readZip } from '../packages/zip.ts';
import { buildTheme, cssHash, MAX_THEME_BYTES, MAX_THEME_FILES, themeCss } from './package.ts';

/**
 * Uploaded themes, one folder each under the data directory: `theme.json` with what the app
 * lists, `theme.css` with what it applies. They belong to the server, so every signed-in
 * device sees the same ones.
 */
export class ThemeStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<CustomTheme[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const themes: CustomTheme[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isThemeId(entry.name)) continue;
      const meta = await this.meta(entry.name);
      if (meta) themes.push(meta);
    }
    return themes.sort((a, b) => a.name.localeCompare(b.name));
  }

  async css(id: string): Promise<string | null> {
    if (!isThemeId(id)) return null;
    return readFile(join(this.dir, id, 'theme.css'), 'utf8').catch(() => null);
  }

  /**
   * Installs a theme package. An ID that is taken (by a built-in or an uploaded theme) gets a
   * number, and the name says so: uploading the same package twice gives two themes.
   */
  async install(zip: Uint8Array): Promise<InstalledTheme> {
    const built = buildTheme(
      readZip(zip, { maxBytes: MAX_THEME_BYTES, maxFiles: MAX_THEME_FILES }),
    );
    await mkdir(this.dir, { recursive: true });
    const taken = new Set((await this.list()).map((t) => t.id));
    let id = built.id;
    let name = built.name;
    for (let n = 2; isThemePreset(id) || taken.has(id); n++) {
      id = `${built.id}-${n}`;
      name = `${built.name} (${n})`;
    }
    const notes = [...built.notes];
    if (id !== built.id) notes.push({ code: 'renamed', detail: id });

    const css = themeCss(built.template, id);
    const theme: CustomTheme = {
      id,
      name,
      author: built.author,
      modes: built.modes as ThemeMode[],
      hash: cssHash(css),
    };
    const staging = join(this.dir, `.incoming-${id}-${Date.now()}`);
    await mkdir(staging);
    try {
      await writeFile(join(staging, 'theme.css'), css);
      await writeFile(join(staging, 'theme.json'), JSON.stringify(theme, null, 2));
      await rename(staging, join(this.dir, id));
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
    return { theme, notes };
  }

  /** Removes a theme; false if there was none with this ID. */
  async remove(id: string): Promise<boolean> {
    if (!isThemeId(id) || !(await this.meta(id))) return false;
    await rm(join(this.dir, id), { recursive: true, force: true });
    return true;
  }

  private async meta(id: string): Promise<CustomTheme | null> {
    try {
      const meta = JSON.parse(
        await readFile(join(this.dir, id, 'theme.json'), 'utf8'),
      ) as CustomTheme;
      return meta.id === id ? meta : null;
    } catch {
      return null;
    }
  }
}
