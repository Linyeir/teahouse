// Keeps the Teahouse version the same in every file that carries it.
//
//   pnpm version:set 0.3.2     writes the version into all of them, and starts a section
//                              for it in CHANGELOG.md if there is none
//   pnpm version:check         fails if they differ
//   pnpm version:check 0.3.2   fails if any of them is not 0.3.2
//
// Runs with Node's built-in TypeScript support (Node 22.18 or later), so it uses no syntax
// beyond type annotations.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A file and a pattern that captures the text before its version, the version, and `"`. */
interface Place {
  file: string;
  pattern: RegExp;
}

const json = /^(\s*"version":\s*")([^"]*)(")/m;

const places: Place[] = [
  // The release workflow reads the root package.json.
  { file: 'package.json', pattern: json },
  // The server reports the one in packages/shared, and the client shows it.
  ...['shared', 'server', 'client', 'app'].map((p) => ({
    file: `packages/${p}/package.json`,
    pattern: json,
  })),
  // The app version, which Android's versionCode is derived from.
  { file: 'packages/app/src-tauri/tauri.conf.json', pattern: json },
  {
    file: 'packages/app/src-tauri/Cargo.toml',
    pattern: /^(\[package\][^[]*?\nversion = ")([^"]*)(")/m,
  },
  {
    file: 'packages/app/src-tauri/Cargo.lock',
    pattern: /^(\[\[package\]\]\nname = "teahouse"\nversion = ")([^"]*)(")/m,
  },
];

const RELEASES = 'https://github.com/Linyeir/teahouse/releases/tag';
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const root = fileURLToPath(new URL('../', import.meta.url));

function read(place: Place): { text: string; version: string } {
  const text = readFileSync(root + place.file, 'utf8');
  const version = place.pattern.exec(text)?.[2];
  if (version === undefined) throw new Error(`No version found in ${place.file}`);
  return { text, version };
}

function set(version: string): void {
  if (!SEMVER.test(version)) throw new Error(`Not a version: ${version}`);
  // Read everything first, so a file without a version leaves all files unchanged.
  const files = places.map((place) => ({ place, ...read(place) }));
  for (const { place, text } of files) {
    writeFileSync(root + place.file, text.replace(place.pattern, `$1${version}$3`));
    console.log(`${place.file}: ${version}`);
  }
  addChangelogSection(version);
}

/** Starts a section for a new version in CHANGELOG.md, above the newest one. */
function addChangelogSection(version: string): void {
  const file = `${root}CHANGELOG.md`;
  const text = readFileSync(file, 'utf8');
  if (text.includes(`\n## [${version}]`)) return;
  const insert = (into: string, before: string, line: string) => {
    const found = into.indexOf(`\n${before}`);
    const at = found === -1 ? into.length : found + 1;
    return `${into.slice(0, at)}${line}${into.slice(at)}`;
  };
  let next = insert(text, '## [', `## [${version}] - unreleased\n\n`);
  // The link that makes the heading point to the release.
  next = insert(next, '[', `[${version}]: ${RELEASES}/v${version}\n`);
  writeFileSync(file, next);
  console.log(`CHANGELOG.md: new section for ${version}`);
}

function check(expected: string | undefined): boolean {
  const found = places.map((place) => ({ file: place.file, version: read(place).version }));
  const want = expected ?? found[0]?.version;
  for (const f of found) {
    console.log(`${f.version === want ? 'ok  ' : 'DIFF'} ${f.file}: ${f.version}`);
  }
  if (found.every((f) => f.version === want)) return true;
  console.error(`\nNot ${want} everywhere. Run: pnpm version:set <version>`);
  return false;
}

const [command, version] = process.argv.slice(2);
try {
  if (command === 'set' && version) set(version);
  else if (command === 'check') process.exitCode = check(version) ? 0 : 1;
  else {
    console.error('Usage: node scripts/version.ts set <version> | check [<version>]');
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
