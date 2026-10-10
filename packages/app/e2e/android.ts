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
  const fingerprint = run('openssl', [
    'x509',
    '-in',
    file('server.pem'),
    '-noout',
    '-fingerprint',
    '-sha256',
  ])
    .trim()
    .split('=')[1];
  return {
    caPem: readFileSync(file('ca.pem'), 'utf8'),
    caHash: run('openssl', ['x509', '-in', file('ca.pem'), '-noout', '-subject_hash_old']).trim(),
    key: readFileSync(file('server.key')),
    cert: readFileSync(file('server.pem')),
    fingerprint,
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
function startHttpsFront(key: Buffer, cert: Buffer) {
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
  server.listen(HTTPS_PORT, '127.0.0.1');
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
/** The centre of the first native element whose text matches, or null. */
function findNative(text: RegExp): [number, number] | null {
  shell('uiautomator dump /sdcard/e2e-ui.xml');
  const xml = shell('cat /sdcard/e2e-ui.xml');
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
    if (!target) return;
    shell(`input tap ${target[0]} ${target[1]}`);
    await sleep(1000);
  }
  throw new Error(`"${text.source}" is still on the device after tapping it`);
}

const ALLOW = /^Allow$/;
const DONT_ALLOW = /^Don.t allow$/;

function permission(): string {
  return /ACCESS_LOCAL_NETWORK: granted=(\w+)/.exec(shell(`dumpsys package ${APP}`))?.[1] ?? '?';
}

async function launch(): Promise<Page> {
  shell(`am force-stop ${APP}`);
  shell(`monkey -p ${APP} -c android.intent.category.LAUNCHER 1`);
  const page = await Page.attach();
  await until('the client to load', () => page.eval<boolean>("document.readyState === 'complete'"));
  return page;
}

// --- the test ----------------------------------------------------------------------------

const certs = makeCertificates();
const server = startServer();
const front = startHttpsFront(certs.key, certs.cert);
const userCa = `/data/misc/user/0/cacerts-added/${certs.caHash}.0`;
let page: Page | undefined;

/** What a failed run needs explained: printed before the temporary files are gone. */
async function diagnostics() {
  const section = (title: string, text: string) =>
    console.log(`\n--- ${title}\n${text.trim() || '(nothing)'}`);
  section('HTTPS front', JSON.stringify(front.seen, null, 2));
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
  page = await launch();
  // The webview writes localStorage to disk with a delay, so the force-stop above can lose the
  // address set a moment earlier, and the app comes back on plain HTTP. Not what is tested here.
  const stored = await page.eval<string | null>("localStorage.getItem('teahouse.server')");
  if (stored !== httpsServer) {
    console.log(`  (the restart lost the new server address, ${stored} was stored; set again)`);
    await page.eval(
      `localStorage.setItem('teahouse.server', ${JSON.stringify(httpsServer)}); location.reload()`,
    );
  }
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

  step('Local network: refused for good, allowed in the settings');
  shell(`pm revoke ${APP} android.permission.ACCESS_LOCAL_NETWORK`);
  page.close();
  page = await launch();
  await tapNative(DONT_ALLOW);
  await page.waitForText(en.server.localNetwork, 20_000);
  check(true, 'the offline banner says why, at once');
  await page.click(en.server.localNetworkAllow);
  await page.waitForText(en.server.localNetworkRefused);
  check(true, 'Android does not ask again, and the app says so');
  await page.click(en.server.localNetworkSettingsOpen);
  await until('the app settings', () =>
    /topResumedActivity=.*(settings|permissioncontroller)/i.test(
      shell('dumpsys activity activities'),
    ),
  );
  check(true, 'the app opens its settings page');
  shell(`pm grant ${APP} android.permission.ACCESS_LOCAL_NETWORK`);
  shell(`monkey -p ${APP} -c android.intent.category.LAUNCHER 1`);
  await until(
    'the app to reconnect',
    async () => !(await page?.text())?.includes(en.app.offlineMode),
    60_000,
  );
  check(true, 'the app reconnects by itself once allowed');

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
