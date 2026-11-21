import { posix } from 'node:path';
import type { ThemeNote } from '@teahouse/shared';

/*
 * The CSS of an uploaded theme. It may set custom properties (and `color-scheme`) in `:root`
 * blocks for light, dark or both, and nothing else: no selectors that style the interface
 * directly, no at-rules, and no way to load anything that is not a file in its own package.
 * Whatever breaks these rules is left out with a note; the rest of the theme still works.
 */

export type ThemeBlock = 'base' | 'light' | 'dark';

export interface Declaration {
  property: string;
  value: string;
}

export interface ParsedThemeCss {
  blocks: Record<ThemeBlock, Declaration[]>;
  notes: ThemeNote[];
}

/** Turns a file of the package into a `data:` URL, or null if it is not in the package. */
export type ResolveFile = (path: string) => string | null;

// `:root`, optionally named for a preset (so a built-in theme can be copied as it is), and
// optionally for one mode.
const SELECTOR =
  /^(?::root|html)(?:\[data-preset=(["']?)[\w-]+\1\])?(?:\[data-theme=(["']?)(light|dark)\2\])?$/i;

const PROPERTY = /^--[a-z0-9_-]{1,100}$/i;

// Ways to load a resource without `url()`, and old IE script hooks.
const BLOCKED_FUNCTIONS = /(?:^|[^a-z0-9_-])(?:-webkit-)?(?:image-set|image|src|expression)\s*\(/i;

export function parseThemeCss(css: string, resolve: ResolveFile): ParsedThemeCss {
  const blocks: Record<ThemeBlock, Declaration[]> = { base: [], light: [], dark: [] };
  const notes: ThemeNote[] = [];
  for (const rule of splitRules(stripComments(css))) {
    if (rule.kind !== 'rule') {
      notes.push({ code: 'unsupported-rule', detail: shorten(rule.prelude) });
      continue;
    }
    const block = blockFor(rule.prelude);
    if (!block) {
      notes.push({ code: 'unsupported-rule', detail: shorten(rule.prelude) });
      continue;
    }
    for (const raw of splitTopLevel(rule.body, ';')) {
      const colon = raw.indexOf(':');
      if (colon < 0) continue;
      const property = raw.slice(0, colon).trim();
      const value = raw
        .slice(colon + 1)
        .trim()
        .replace(/\s*!important$/i, '');
      if (!property || !value) continue;
      if (property.toLowerCase() === 'color-scheme') {
        if (/^(light|dark|light dark|dark light|normal)$/i.test(value)) {
          blocks[block].push({ property: 'color-scheme', value: value.toLowerCase() });
        }
        continue;
      }
      if (!PROPERTY.test(property)) {
        notes.push({ code: 'not-variable', detail: property });
        continue;
      }
      const checked = checkValue(value, resolve);
      if (checked.ok) blocks[block].push({ property, value: checked.value });
      else notes.push({ code: checked.code, detail: checked.detail ?? property });
    }
  }
  return { blocks, notes };
}

function blockFor(selectors: string): ThemeBlock | null {
  // `:root, :root[data-theme="light"]` and the like: every selector must be allowed, and the
  // whole list goes to the widest block among them.
  const parts = splitTopLevel(selectors, ',').map((s) => s.replace(/\s+/g, ''));
  if (parts.length === 0) return null;
  let block: ThemeBlock | null = null;
  for (const part of parts) {
    const match = SELECTOR.exec(part);
    if (!match) return null;
    const mode = (match[3]?.toLowerCase() as ThemeBlock | undefined) ?? 'base';
    block = block === null || block === mode ? mode : 'base';
  }
  return block;
}

type Checked =
  | { ok: true; value: string }
  | { ok: false; code: 'blocked-value' | 'missing-file'; detail?: string };

/**
 * A custom property's value, with every `url()` replaced by the package file it names.
 * Refused: escapes (which can hide `url(`), markup and braces, functions that load resources
 * without `url()`, and any `url()` that is not a file in the package.
 */
export function checkValue(value: string, resolve: ResolveFile): Checked {
  if (/[\\<>{}]/.test(value) || value.includes('/*') || BLOCKED_FUNCTIONS.test(value)) {
    return { ok: false, code: 'blocked-value' };
  }
  let out = '';
  let rest = value;
  for (;;) {
    const at = rest.search(/url\(/i);
    if (at < 0) break;
    // `url(` inside a string is not a URL, but nothing needs one there; refuse it.
    if (insideString(rest.slice(0, at))) return { ok: false, code: 'blocked-value' };
    const close = rest.indexOf(')', at);
    if (close < 0) return { ok: false, code: 'blocked-value' };
    const target = rest
      .slice(at + 4, close)
      .trim()
      .replace(/^(["'])(.*)\1$/s, '$2');
    if (!isPackagePath(target)) return { ok: false, code: 'blocked-value', detail: target };
    const data = resolve(posix.normalize(target));
    if (!data) return { ok: false, code: 'missing-file', detail: target };
    out += `${rest.slice(0, at)}url("${data}")`;
    rest = rest.slice(close + 1);
  }
  if (insideString(rest)) return { ok: false, code: 'blocked-value' };
  return { ok: true, value: out + rest };
}

/** A relative path that stays inside the package: no scheme, no host, no climbing out. */
export function isPackagePath(target: string): boolean {
  if (!target || /[\s"'()]/.test(target)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) {
    return false;
  }
  return !posix.normalize(target).split('/').includes('..');
}

function insideString(text: string): boolean {
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
  }
  return quote !== null;
}

function stripComments(css: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      out += ' ';
    } else out += ch;
  }
  return out;
}

type Rule =
  | { kind: 'rule'; prelude: string; body: string }
  | { kind: 'at-rule' | 'broken'; prelude: string };

/** Top-level rules. A block that contains another block (nesting, `@media`) is one rule. */
function splitRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let start = 0;
  let depth = 0;
  let open = -1;
  let nested = false;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') {
      if (depth === 0) open = i;
      else nested = true;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) {
        const prelude = css.slice(start, open).trim();
        if (prelude.startsWith('@') || nested) rules.push({ kind: 'at-rule', prelude });
        else rules.push({ kind: 'rule', prelude, body: css.slice(open + 1, i) });
        start = i + 1;
        nested = false;
      }
    } else if (ch === ';' && depth === 0) {
      // A statement at-rule such as `@import url(…);`.
      const prelude = css.slice(start, i).trim();
      if (prelude) rules.push({ kind: 'at-rule', prelude });
      start = i + 1;
    }
  }
  const tail = css.slice(start).trim();
  if (tail) rules.push({ kind: 'broken', prelude: tail });
  return rules;
}

/** Splits at `separator` outside strings and parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

const shorten = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};
