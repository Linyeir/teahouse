import { readFileSync } from 'node:fs';
import { THEME_PRESETS, THEME_TOKENS, type ThemeMode } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import { contrast } from './nameColors.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const globalCss = read('./global.css');
const themesCss = read('./themes.css');
const indexHtml = read('../index.html');
const docs = read('../../../docs/theming.md');

type Block = { selector: string; decls: [string, string][] };

/** The `:root…` rules of a stylesheet, in order, as custom property declarations. */
function rootBlocks(css: string): Block[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Block[] = [];
  for (const match of clean.matchAll(/(:root[^{]*)\{([^}]*)\}/g)) {
    const decls: [string, string][] = [];
    for (const part of (match[2] ?? '').split(';')) {
      const m = part.match(/^\s*--([\w-]+)\s*:\s*([\s\S]+?)\s*$/);
      if (m?.[1] && m[2]) decls.push([m[1], m[2]]);
    }
    blocks.push({ selector: (match[1] ?? '').trim(), decls });
  }
  return blocks;
}

const blocks = [...rootBlocks(globalCss), ...rootBlocks(themesCss)];

function applies(selector: string, preset: string, mode: ThemeMode): boolean {
  const attrs = [...selector.matchAll(/\[data-(\w+)="([\w-]+)"\]/g)];
  return attrs.every(([, name, value]) =>
    name === 'theme' ? value === mode : name === 'preset' ? value === preset : false,
  );
}

function tokens(preset: string, mode: ThemeMode): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of blocks) {
    if (applies(block.selector, preset, mode)) for (const [k, v] of block.decls) map.set(k, v);
  }
  return map;
}

function resolve(value: string, map: Map<string, string>, depth = 0): string {
  if (depth > 20) throw new Error(`var() loop in ${value}`);
  const next = value.replace(/var\(--([\w-]+)\)/g, (_, name: string) => {
    const v = map.get(name);
    if (v === undefined) throw new Error(`--${name} is not defined`);
    return v;
  });
  return next === value ? value : resolve(next, map, depth + 1);
}

type Rgba = [number, number, number, number];

/** The last plain color of a value (the base layer under gradients), as RGBA. */
function color(value: string): Rgba {
  const layers = value.split(/,(?![^(]*\))/).map((s) => s.trim());
  const last = layers[layers.length - 1] ?? '';
  const hex = last.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgb = last.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ (\d+)%)?\)$/);
  if (rgb)
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) / 100 : 1];
  throw new Error(`Not a color: ${value}`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2]
    .map((i) => Math.round((top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a)))
    .concat(1) as Rgba;
}

const hex = (c: Rgba) =>
  `#${c
    .slice(0, 3)
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;

const combos = THEME_PRESETS.flatMap((p) => p.modes.map((mode) => [p.id, mode] as const));

describe.each(combos)('theme %s (%s)', (preset, mode) => {
  const map = tokens(preset, mode);
  const get = (name: string) => color(resolve(`var(--${name})`, map));
  const bg = get('color-bg');
  const surface = over(get('color-surface'), bg);

  it('defines every semantic and vn token', () => {
    for (const name of contractTokens()) expect(() => resolve(`var(--${name})`, map)).not.toThrow();
  });

  it('keeps text readable (4.5:1)', () => {
    const textbox = over(get('vn-textbox-bg'), get('vn-stage-bg'));
    const pairs: [string, Rgba, Rgba][] = [
      ['text on bg', get('color-text'), bg],
      ['text on surface', over(get('color-text'), surface), surface],
      ['muted text on surface', get('color-text-muted'), surface],
      ['muted text on bg', get('color-text-muted'), bg],
      ['accent text on accent', get('color-accent-text'), get('color-accent')],
      ['danger text on danger', get('color-danger-text'), get('color-danger')],
      ['danger on surface', get('color-danger'), surface],
      ['textbox', get('vn-textbox-color'), textbox],
    ];
    for (const name of ['vn-speech-color', 'vn-narration-color']) {
      if (resolve(`var(--${name})`, map) !== 'initial') pairs.push([name, get(name), textbox]);
    }
    for (const [label, fg, back] of pairs) {
      expect(contrast(hex(fg), hex(back)), label).toBeGreaterThanOrEqual(4.5);
    }
  });

  // WCAG 1.4.11: the edges of controls and the focus ring need 3:1 against what is around them.
  it('keeps control borders and the focus ring visible (3:1)', () => {
    const pairs: [string, Rgba, Rgba][] = [];
    for (const name of ['color-control-border', 'color-focus']) {
      pairs.push([`${name} on bg`, over(get(name), bg), bg]);
      pairs.push([`${name} on surface`, over(get(name), surface), surface]);
    }
    for (const [label, fg, back] of pairs) {
      expect(contrast(hex(fg), hex(back)), label).toBeGreaterThanOrEqual(3);
    }
  });
});

/** Tokens of contract v1: everything global.css declares on :root after the primitives. */
function contractTokens(): string[] {
  const semantic = globalCss.slice(globalCss.indexOf('/* Semantic'));
  return (
    rootBlocks(`:root {${semantic.slice(0, semantic.indexOf('}'))}}`)[0]?.decls.map(([k]) => k) ??
    []
  );
}

describe('theme contract', () => {
  it('defines semantic colors only through primitives', () => {
    for (const block of blocks) {
      for (const [name, value] of block.decls) {
        if (/^(color-|vn-(stage-bg|textbox-bg|textbox-color|name-bg|name-color)$)/.test(name)) {
          expect(value, `${block.selector} --${name}`).toMatch(/^var\(--[\w-]+\)$/);
        }
      }
    }
  });

  const documented = (heading: string) => {
    const section = docs.slice(docs.indexOf(heading));
    const table = section.slice(0, section.indexOf('\n## ', 1) >>> 0 || undefined);
    return [...table.matchAll(/^\| `--([\w-]+)` \|/gm)].map((m) => m[1]);
  };

  it('documents every token of contract v1, and no others', () => {
    expect(documented('## Interface tokens').sort()).toEqual(contractTokens().sort());
  });

  it('documents exactly the tokens a world may override', () => {
    expect(documented('## Tokens a world can override').sort()).toEqual([...THEME_TOKENS].sort());
  });

  it('keeps the inline script in index.html in step with THEME_PRESETS', () => {
    const only = JSON.parse(
      (indexHtml.match(/var only = (\{[^}]*\})/)?.[1] ?? '{}').replace(/(\w+):/g, '"$1":'),
    );
    const expected = Object.fromEntries(
      THEME_PRESETS.filter((p) => p.modes.length === 1).map((p) => [p.id, p.modes[0]]),
    );
    expect(only).toEqual(expected);
    const known = indexHtml.match(/var known = \[([^\]]*)\]/)?.[1] ?? '';
    for (const p of THEME_PRESETS.filter((p) => p.modes.length > 1)) {
      expect(known).toContain(`"${p.id}"`);
    }
  });
});
