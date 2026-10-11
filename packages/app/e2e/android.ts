/**
 * End-to-end test of the Android app on an emulator with Android 17 or later and a
 * `google_apis` image (it allows `adb root`). It covers what the network changes for 0.3.3
 * are about:
 *
 * - the local network permission: asked before the first request, refused (requests fail at
 *   once and the app says why), allowed from the app, refused for good (the app opens the
 *   settings), allowed there (the app reconnects by itself);
 * - a server whose certificate comes from a private CA: the app explains the unknown CA and
 *   shows the right fingerprint, and once the CA is in the user store, requests, the
 *   WebSocket and images all work over HTTPS.
 *
 *   node packages/app/e2e/android.ts path/to/teahouse.apk
 *
 * Needs adb on PATH with one emulator attached, openssl, and the workspace installed. Starts
 * its own Teahouse server with temporary data on port 8787 and an HTTPS front on 8443. The
 * emulator reaches both as 10.0.2.2, a private address, so Android treats them as local.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const APP = 'io.github.linyeir.teahouse';
const HTTP_PORT = 8787;
const HTTPS_PORT = 8443;
/** A server with a self-signed certificate, which the user trusts by its fingerprint. */
const PINNED_PORT = 8444;
const HOST = '10.0.2.2';
const root = new URL('../../..', import.meta.url).pathname;
const en = JSON.parse(readFileSync(join(root, 'packages/client/src/locales/en.json'), 'utf8'));

if (!process.argv[2])
  throw new Error('Usage: node packages/app/e2e/android.ts path/to/teahouse.apk');
// pnpm runs package scripts in the package folder; the path is relative to where it was called.
const apk = resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]);

// --- helpers ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command: string, args: string[], input?: string): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 << 20,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const adb = (...args: string[]) => run('adb', args).trim();
const shell = (command: string) => adb('shell', command);

function step(name: string) {
  console.log(`\n▶ ${name}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function until<T>(what: string, probe: () => Promise<T> | T, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (${last})` : ''}`);
}

/** A small PNG, so the webview has a real image to decode. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- server and HTTPS front --------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'teahouse-e2e-'));

/** A private CA and a certificate for the host the emulator connects to. */
function makeCertificates() {
  const file = (name: string) => join(work, name);
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.pem'),
    '-days',
    '2',
    '-subj',
    '/CN=Teahouse E2E CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  run('openssl', [
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    file('server.key'),
    '-out',
    file('server.csr'),
    '-subj',
    '/CN=teahouse.lan',
  ]);
  writeFileSync(
    file('ext.cnf'),
    `subjectAltName=IP:${HOST},DNS:teahouse.lan\nextendedKeyUsage=serverAuth\n`,
  );
  run('openssl', [
    'x509',
    '-req',
    '-in',
    file('server.csr'),
    '-CA',
    file('ca.pem'),
    '-CAkey',
    file('ca.key'),
    '-CAcreateserial',
    '-out',
    file('server.pem'),
    '-days',
    '1',
    '-extfile',
    file('ext.cnf'),
  ]);
  const fingerprint = fingerprintOf(file('server.pem'));
  return {
    caPem: readFileSync(file('ca.pem'), 'utf8'),
    caHash: run('openssl', ['x509', '-in', file('ca.pem'), '-noout', '-subject_hash_old']).trim(),
    key: readFileSync(file('server.key')),
    cert: readFileSync(file('server.pem')),
    fingerprint,
  };
}

/** `AB:CD:…`, as the app shows it. */
function fingerprintOf(pem: string): string {
  const out = run('openssl', ['x509', '-in', pem, '-noout', '-fingerprint', '-sha256']);
  return out.trim().split('=')[1] ?? '';
}

/** A self-signed certificate for the host the emulator connects to: no CA vouches for it. */
function makeSelfSigned(name: string) {
  const file = (ext: string) => join(work, `${name}.${ext}`);
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    file('key'),
    '-out',
    file('pem'),
    '-days',
    '1',
    '-subj',
    '/CN=teahouse.lan',
    '-addext',
    `subjectAltName=IP:${HOST},DNS:teahouse.lan`,
  ]);
  return {
    key: readFileSync(file('key')),
    cert: readFileSync(file('pem')),
    fingerprint: fingerprintOf(file('pem')),
  };
}

function startServer(): ChildProcess {
  return spawn('pnpm', ['--filter', '@teahouse/server', 'start'], {
    cwd: root,
    env: {
      ...process.env,
      TEAHOUSE_DATA_DIR: join(work, 'data'),
      TEAHOUSE_PORT: String(HTTP_PORT),
      TEAHOUSE_HOST: '127.0.0.1',
    },
    // Kept for the diagnostics printed when a check fails.
    stdio: [
      'ignore',
      openSync(join(work, 'server.log'), 'w'),
      openSync(join(work, 'server.log'), 'a'),
    ],
    detached: true,
  });
}

/** Forwards HTTPS to the server and counts what passes through. */
function startHttpsFront(key: Buffer, cert: Buffer, port = HTTPS_PORT) {
  const seen = { tls: 0, tlsErrors: [] as string[], requests: 0, webSockets: 0, assets: 0 };
  const server = https.createServer({ key, cert }, (req, res) => {
    seen.requests++;
    if (req.url?.includes('/assets/')) seen.assets++;
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: HTTP_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  // WebSockets leave the server's bookkeeping once upgraded; closing must end them too.
  const upgraded = new Set<net.Socket>();
  server.on('upgrade', (req, socket, head) => {
    seen.webSockets++;
    upgraded.add(socket as net.Socket);
    socket.on('close', () => upgraded.delete(socket as net.Socket));
    const upstream = net.connect(HTTP_PORT, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`);
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  // A client that rejects the certificate never gets as far as a request.
  server.on('secureConnection', () => seen.tls++);
  server.on('tlsClientError', (err) => seen.tlsErrors.push(err.message));
  server.listen(port, '127.0.0.1');
  const close = () => {
    server.close();
    server.closeAllConnections();
    for (const socket of upgraded) socket.destroy();
  };
  return { close, seen };
}

// --- the app: Chrome DevTools protocol for the webview, uiautomator for Android ----------

/** The webview's console messages and uncaught errors, across app restarts. */
const consoleLog: string[] = [];

class Page {
  private id = 0;
  private pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();

  private socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.consoleAPICalled') {
        const args = message.params.args.map(
          (arg: { value?: unknown; description?: string }) => arg.description ?? String(arg.value),
        );
        consoleLog.push(`${message.params.type}: ${args.join(' ')}`);
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        consoleLog.push(`exception: ${details.exception?.description ?? details.text}`);
      }
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    };
    socket.send(JSON.stringify({ id: ++this.id, method: 'Runtime.enable' }));
  }

  /** Attaches to the app's webview (debug builds allow it). */
  static async attach(): Promise<Page> {
    const pid = await until('the app process', () => shell(`pidof ${APP}`));
    const socketName = await until(
      'the webview debug socket',
      () => shell('cat /proc/net/unix').match(new RegExp(`webview_devtools_remote_${pid}`))?.[0],
    );
    const port = adb('forward', 'tcp:0', `localabstract:${socketName}`);
    const url = await until('the page in the webview', async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      return targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    });
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    return new Page(socket);
  }

  close() {
    this.socket.close();
  }

  /** Runs `expression` in the page and returns its (awaited) value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const id = ++this.id;
    const message = await new Promise<{
      result?: { result: { value: T }; exceptionDetails?: unknown };
    }>((resolve) => {
      this.pending.set(id, resolve as never);
      this.socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (!message.result || message.result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${expression}\n${JSON.stringify(message)}`);
    }
    return message.result.result.value;
  }

  text = () => this.eval<string>('document.body.innerText');

  async waitForText(text: string, timeoutMs = 20_000) {
    await until(`"${text}" on screen`, async () => (await this.text()).includes(text), timeoutMs);
  }

  /** Types into the input of the field labelled `label`, the way React notices. */
  async fill(label: string, value: string) {
    const done = await this.eval<boolean>(`(() => {
      const field = [...document.querySelectorAll('label')]
        .find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}));
      const input = field?.querySelector('input');
      if (!input) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    check(done, `filled "${label}"`);
  }

  async click(text: string) {
    const done = await until(`a button "${text}"`, () =>
      this.eval<boolean>(`(() => {
        const button = [...document.querySelectorAll('button, a')]
          .find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled);
        button?.click();
        return Boolean(button);
      })()`),
    );
    check(done, `clicked "${text}"`);
  }
}

/** Taps a native element (a system dialog, the settings) by its text. */
/**
 * The centre of the first native element whose text matches, null when there is none, or
 * undefined when the screen could not be read (uiautomator fails while the UI is busy).
 */
function findNative(text: RegExp): [number, number] | null | undefined {
  let xml: string;
  try {
    shell('uiautomator dump /sdcard/e2e-ui.xml');
    xml = shell('cat /sdcard/e2e-ui.xml');
  } catch {
    return undefined;
  }
  for (const node of xml.matchAll(/<node [^>]*>/g)) {
    const label = /text="([^"]*)"/.exec(node[0])?.[1] ?? '';
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node[0]);
    if (bounds && text.test(label.replace(/&apos;/g, "'"))) {
      const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
      return [(x1 + x2) >> 1, (y1 + y2) >> 1];
    }
  }
  return null;
}

/**
 * Taps a native element (a system dialog, the settings) by its text. A dialog that is still
 * animating in ignores taps on a slow emulator, so it taps again until the element is gone.
 */
async function tapNative(text: RegExp, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  await until(`"${text.source}" on the device`, () => findNative(text), timeoutMs);
  while (Date.now() < end) {
    const target = findNative(text);
    if (target === null) return;
    if (target) shell(`input tap ${target[0]} ${target[1]}`);
    await sleep(1000);
  }
  throw new Error(`"${text.source}" is still on the device after tapping it`);
}

const ALLOW = /^Allow$/;
const DONT_ALLOW = /^Don.t allow$/;

/** The activity in front, e.g. `io.github.linyeir.teahouse/.MainActivity`. */
function topActivity(): string {
  return /topResumedActivity=.*? (\S+\/\S+)/.exec(shell('dumpsys activity activities'))?.[1] ?? '';
}

function permission(): string {
  return /ACCESS_LOCAL_NETWORK: granted=(\w+)/.exec(shell(`dumpsys package ${APP}`))?.[1] ?? '?';
}

/**
 * Restarts the app. The webview writes localStorage to disk with a delay, so killing the app
 * can lose what was stored before, even the sign-in: `keep` is set again where it was lost.
 * Not what is tested here.
 */
async function launch(keep: Record<string, string> = {}): Promise<Page> {
  shell(`am force-stop ${APP}`);
  shell(`monkey -p ${APP} -c android.intent.category.LAUNCHER 1`);
  const page = await Page.attach();
  const loaded = () =>
    until('the client to load', () => page.eval<boolean>("document.readyState === 'complete'"));
  await loaded();
  const stored = await page.eval<Record<string, string | null>>(
    `Object.fromEntries(${JSON.stringify(Object.keys(keep))}.map((k) => [k, localStorage.getItem(k)]))`,
  );
  const lost = Object.keys(keep).filter((key) => stored[key] !== keep[key]);
  if (lost.length > 0) {
    console.log(`  (the restart lost ${lost.join(', ')}; set again)`);
    await page.eval(
      `for (const [k, v] of Object.entries(${JSON.stringify(keep)})) localStorage.setItem(k, v); location.reload()`,
    );
    await sleep(500);
    await loaded();
  }
  return page;
}

/** What the app must keep across a restart: the server and the sign-in. */
function session(page: Page) {
  return page.eval<Record<string, string>>(
    `Object.fromEntries(['teahouse.server', 'teahouse.token'].flatMap((k) => { const v = localStorage.getItem(k); return v === null ? [] : [[k, v]]; }))`,
  );
}

// --- the test ----------------------------------------------------------------------------

const certs = makeCertificates();
const server = startServer();
const front = startHttpsFront(certs.key, certs.cert);
let pinnedFront: ReturnType<typeof startHttpsFront> | undefined;
const userCa = `/data/misc/user/0/cacerts-added/${certs.caHash}.0`;
let page: Page | undefined;

/** What a failed run needs explained: printed before the temporary files are gone. */
async function diagnostics() {
  const section = (title: string, text: string) =>
    console.log(`\n--- ${title}\n${text.trim() || '(nothing)'}`);
  section('HTTPS front', JSON.stringify(front.seen, null, 2));
  if (pinnedFront) section('self-signed HTTPS front', JSON.stringify(pinnedFront.seen, null, 2));
  try {
    section('activity in front', topActivity());
  } catch (err) {
    section('activity in front', `unavailable: ${err}`);
  }
  try {
    section(
      'local network permission',
      shell(`dumpsys package ${APP}`)
        .split('\n')
        .filter((line) => line.includes('ACCESS_LOCAL_NETWORK: granted'))
        .join('\n'),
    );
  } catch (err) {
    section('local network permission', `unavailable: ${err}`);
  }
  section('webview console', consoleLog.slice(-40).join('\n'));
  try {
    section('page text', ((await page?.text()) ?? '').slice(0, 2000));
  } catch (err) {
    section('page text', `unavailable: ${err}`);
  }
  try {
    section(
      'server log',
      readFileSync(join(work, 'server.log'), 'utf8').split('\n').slice(-40).join('\n'),
    );
  } catch (err) {
    section('server log', `unavailable: ${err}`);
  }
  try {
    const logcat = adb('logcat', '-d', '-t', '2000')
      .split('\n')
      .filter((line) => /chromium|cr_|ssl|cert|websocket|Tauri|teahouse/i.test(line));
    section('logcat', logcat.slice(-60).join('\n'));
  } catch (err) {
    section('logcat', `unavailable: ${err}`);
  }
}

function cleanUp() {
  page?.close();
  try {
    shell(`rm -f ${userCa}`);
    adb('forward', '--remove-all');
  } catch {
    // The emulator may be gone already.
  }
  front.close();
  pinnedFront?.close();
  try {
    // The server runs in its own process group, with pnpm and tsx in front of node.
    if (server.pid) process.kill(-server.pid);
  } catch {
    // Exited already.
  }
  rmSync(work, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanUp();
    process.exit(1);
  });
}

try {
  step('Setup');
  const sdk = Number(shell('getprop ro.build.version.sdk'));
  check(sdk >= 37, `the emulator runs Android 17 or later (SDK ${sdk})`);
  // Right after boot adbd may still be restarting and refuse; ask until it runs as root.
  await until(
    'adb as root',
    () => {
      try {
        adb('root');
        adb('wait-for-device');
      } catch {
        return false;
      }
      return shell('id').includes('uid=0');
    },
    60_000,
  );
  await until(
    'the server',
    async () => (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/auth/status`)).ok,
    60_000,
  );
  try {
    adb('uninstall', APP);
  } catch {
    // Not installed.
  }
  adb('install', apk);
  // The package manager may report the new package before its permissions.
  const initial = await until('the permission state', () => {
    const state = permission();
    return state === '?' ? null : state;
  });
  check(initial === 'false', `the local network permission starts out not granted (${initial})`);

  page = await launch();
  await page.eval("localStorage.setItem('teahouse.lang', 'en'); location.reload()");
  await page.waitForText(en.auth.connectTitle);

  step('Local network: refused');
  await page.fill(en.auth.server, `http://${HOST}:${HTTP_PORT}`);
  await page.click(en.auth.connect);
  await tapNative(DONT_ALLOW);
  const refusedAt = Date.now();
  await page.waitForText(en.server.localNetwork, 20_000);
  // Without the fix a request hangs for about two minutes.
  check(Date.now() - refusedAt < 20_000, 'the request fails at once instead of hanging');

  step('Local network: allowed from the app');
  await page.click(en.server.localNetworkAllow);
  await tapNative(ALLOW);
  await page.waitForText(en.server.localNetworkGranted);
  check(permission() === 'true', 'the permission is granted');
  await page.click(en.auth.connect);
  await page.waitForText(en.auth.setupTitle);
  check(true, 'plain HTTP to a LAN address works');

  step('HTTPS with a private CA the device does not know');
  await page.click('Change server');
  await page.fill(en.auth.server, `https://${HOST}:${HTTPS_PORT}`);
  await page.click(en.auth.connect);
  await page.waitForText(en.server.untrusted);
  const text = await page.text();
  check(text.includes(en.server.certUnknownCaAndroid), 'the app names the unknown CA');
  check(text.includes('CN=Teahouse E2E CA'), 'the app shows the issuer');
  check(
    text.replace(/\s/g, '').includes(certs.fingerprint),
    `the app shows the fingerprint openssl computes (${certs.fingerprint.slice(0, 11)}…)`,
  );

  step('HTTPS with the CA in the user store');
  shell(`mkdir -p /data/misc/user/0/cacerts-added`);
  adb('push', join(work, 'ca.pem'), userCa);
  shell(`chown -R system:system /data/misc/user/0/cacerts-added && chmod 644 ${userCa}`);
  page.close();
  const httpsServer = `https://${HOST}:${HTTPS_PORT}`;
  const requestsBefore = front.seen.requests;
  // Set a moment ago, so the restart is likely to lose it.
  page = await launch({ 'teahouse.server': httpsServer });
  await page.waitForText(en.auth.setupTitle);
  await until('a request through the HTTPS front', () => front.seen.requests > requestsBefore);
  check(true, 'requests work over HTTPS');
  const password = randomBytes(12).toString('hex');
  await page.fill(en.auth.password, password);
  await page.click(en.auth.setup);
  await page.waitForText(en.nav.worlds);
  // A first attempt that fails is retried with a growing delay.
  await until('the WebSocket over HTTPS', () => front.seen.webSockets > 0, 60_000);
  check(!(await page.text()).includes(en.app.offline), 'the WebSocket stays connected');

  const login = (await (
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, deviceName: 'E2E test' }),
    })
  ).json()) as { token: string };
  const auth = { authorization: `Bearer ${login.token}` };
  const world = (await (
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/worlds`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Harbor' }),
    })
  ).json()) as { id: string };
  const form = new FormData();
  form.set('description', 'harbor');
  form.set('file', new Blob([png(64, 36)], { type: 'image/png' }), 'harbor.png');
  await fetch(`http://127.0.0.1:${HTTP_PORT}/api/worlds/${world.id}/backgrounds`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  await page.eval(
    `history.pushState(null, '', '/worlds/${world.id}'); dispatchEvent(new PopStateEvent('popstate'))`,
  );
  const image = await until('the background image', () =>
    page?.eval<{ src: string; width: number } | null>(`(() => {
      const img = [...document.images].find((i) => i.src.includes('/assets/backgrounds/'));
      return img?.complete && img.naturalWidth > 0 ? { src: img.src, width: img.naturalWidth } : null;
    })()`),
  );
  check(image.src.startsWith(`https://${HOST}:${HTTPS_PORT}/`), 'the image loads over HTTPS');
  check(front.seen.assets > 0, 'the image request went through the HTTPS front');
  // The app's own connections ask Android too (rustls-platform-verifier through JNI).
  const trust = await page.eval<{ result: string }>(
    `window.__TAURI_INTERNALS__.invoke('platform_trust', { server: ${JSON.stringify(httpsServer)} })`,
  );
  check(
    trust.result === 'trusted',
    `Android trusts the user CA for the app as well (${trust.result})`,
  );

  step('Local network: refused for good, allowed in the settings');
  const signedIn = await session(page);
  check(signedIn['teahouse.token'], 'the app is signed in');
  // Revoking a permission kills the app.
  shell(`pm revoke ${APP} android.permission.ACCESS_LOCAL_NETWORK`);
  page.close();
  page = await launch(signedIn);
  await tapNative(DONT_ALLOW);
  await page.waitForText(en.server.localNetwork, 20_000);
  check((await page.text()).includes(en.app.offlineMode), 'the offline banner says why, at once');
  await page.click(en.server.localNetworkAllow);
  await page.waitForText(en.server.localNetworkRefused);
  check(true, 'Android does not ask again, and the app says so');
  await page.click(en.server.localNetworkSettingsOpen);
  await until('the app settings', () => /settings|permissioncontroller/i.test(topActivity()));
  check(true, 'the app opens its settings page');
  // What the user does there: allow "Nearby devices", then go back to the app. On a slow
  // emulator the settings page may still be opening, so check that the grant took.
  await until('the permission to be granted', () => {
    shell(`pm grant ${APP} android.permission.ACCESS_LOCAL_NETWORK`);
    return permission() === 'true';
  });
  // Back to the app. Android pauses the webview's timers, and so the app's retries, while it
  // is in the background, so make sure it really is in front again.
  await until('the app in front', () => {
    if (topActivity().startsWith(`${APP}/`)) return true;
    shell(`monkey -p ${APP} -c android.intent.category.LAUNCHER 1`);
    return false;
  });
  await until(
    'the app to reconnect',
    async () => {
      const text = (await page?.text()) ?? '';
      return text.includes(en.nav.worlds) && !text.includes(en.app.offlineMode);
    },
    60_000,
  );
  check(true, 'the app reconnects by itself once allowed, still signed in');

  step('A self-signed certificate, trusted by its fingerprint');
  const selfSigned = makeSelfSigned('self-signed');
  pinnedFront = startHttpsFront(selfSigned.key, selfSigned.cert, PINNED_PORT);
  const pinnedServer = `https://${HOST}:${PINNED_PORT}`;
  // The same server behind another front, so the device stays signed in.
  await page.eval(
    `localStorage.setItem('teahouse.server', ${JSON.stringify(pinnedServer)}); location.reload()`,
  );
  await page.waitForText(en.server.untrusted, 60_000);
  check((await page.text()).includes(en.server.certSelfSigned), 'the app says it is self-signed');
  await page.click(en.server.acceptStart);
  await page.waitForText(en.server.acceptCheck);
  check(
    (await page.text()).includes(selfSigned.fingerprint),
    `the app shows the fingerprint to compare (${selfSigned.fingerprint.slice(0, 11)}…)`,
  );
  check(pinnedFront.seen.requests === 0, 'nothing reached the server before the user decided');
  await page.click(en.server.acceptConfirm);
  await until('the WebSocket through the app', () => pinnedFront?.seen.webSockets, 60_000);
  await until(
    'the app to connect',
    async () => !(await page?.text())?.includes(en.app.offlineMode),
    60_000,
  );
  check(pinnedFront.seen.requests > 0, 'requests go through the app');
  const pins = await page.eval<{ origin: string; sha256: string }[]>(
    "window.__TAURI_INTERNALS__.invoke('list_pins')",
  );
  check(
    pins.some((pin) => pin.origin === pinnedServer && pin.sha256 === selfSigned.fingerprint),
    'the app keeps the trusted certificate',
  );
  await page.eval(
    `history.pushState(null, '', '/worlds/${world.id}'); dispatchEvent(new PopStateEvent('popstate'))`,
  );
  const pinnedImage = await until('the background image through the app', () =>
    page?.eval<{ src: string } | null>(`(() => {
      const img = [...document.images].find((i) => i.src.includes('teahouse-asset'));
      return img?.complete && img.naturalWidth > 0 ? { src: img.src } : null;
    })()`),
  );
  check(
    pinnedFront.seen.assets > 0,
    `the image loads through the app (${pinnedImage.src.slice(0, 40)}…)`,
  );

  step('A self-signed certificate that changed');
  pinnedFront.close();
  const replaced = makeSelfSigned('replaced');
  pinnedFront = startHttpsFront(replaced.key, replaced.cert, PINNED_PORT);
  // The closed front ends the WebSocket; reconnecting meets the new certificate.
  await page.waitForText(en.server.certChanged, 60_000);
  const changed = await page.text();
  check(
    changed.includes(selfSigned.fingerprint) && changed.includes(replaced.fingerprint),
    'the app shows the trusted and the presented fingerprint',
  );
  check(pinnedFront.seen.requests === 0, 'nothing reaches the server with the new certificate');
  await page.click(en.server.forgetCertificate);
  await page.waitForText(en.server.forgotten);
  const forgotten = await page.eval<{ origin: string }[]>(
    "window.__TAURI_INTERNALS__.invoke('list_pins')",
  );
  check(!forgotten.some((pin) => pin.origin === pinnedServer), 'the app forgets it');

  console.log('\nAll checks passed.');
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  await diagnostics();
  throw err;
} finally {
  cleanUp();
}
// Open handles (the webview's keep-alive connections) must not keep the run alive.
process.exit(0);
