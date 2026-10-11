import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { localNetworkAllowed, looksLocal } from './localNetwork.ts';
import {
  acceptedCertificates,
  originOf,
  platformTrusts,
  serverFetch,
  trustGeneration,
  UntrustedCertificateError,
  usesNativeTransport,
} from './transport.ts';

/**
 * Why the app cannot reach the server. A rejected certificate and a server that is down are
 * the same `TypeError` in JavaScript, so the app asks its native side, which makes a TLS
 * handshake of its own (packages/app/src-tauri/src/probe.rs). Browsers explain certificate
 * errors themselves, so this only runs in the apps.
 */
export type Diagnosis =
  /** The server answers now: the failure was temporary. */
  | { kind: 'reachable' }
  /** A reverse proxy answers, the Teahouse server behind it does not. */
  | { kind: 'gateway' }
  /** The webview connects, but may not read the answer (CORS, or a redirect by a proxy). */
  | { kind: 'blocked' }
  /** Android 17 keeps the app off the local network until the user allows it. */
  | { kind: 'localNetwork' }
  /** Nothing answers: wrong address, server down, or not on the same network. */
  | { kind: 'unreachable'; reason?: string }
  /** Something answers, but not with TLS, or the TLS handshake fails. */
  | { kind: 'tlsFailed'; reason: string }
  /** The server answers with TLS, but neither the device nor the user trusts its certificate. */
  | { kind: 'untrusted'; certificate: Certificate }
  /**
   * The device trusts the certificate, the webview does not: some webviews (LineageOS's) ignore
   * CAs the user installed. The app can connect through itself (transport.ts).
   */
  | { kind: 'webviewOnly'; certificate: Certificate }
  /** The user accepted a certificate for this server, and it now presents another one. */
  | { kind: 'certificateChanged'; certificate: Certificate; accepted: string | null };

/** The server's own certificate, as the probe saw it. */
export interface Certificate {
  subject: string | null;
  issuer: string | null;
  /** Unix seconds. */
  notBefore: number | null;
  notAfter: number | null;
  /** `AB:CD:…`, as browsers and `openssl x509 -fingerprint -sha256` show it. */
  sha256: string;
  selfSigned: boolean;
  matchesHost: boolean;
}

type Probe =
  | { result: 'notTls' }
  | { result: 'unreachable'; reason: string }
  | { result: 'tlsFailed'; reason: string; certificate: Certificate | null }
  | { result: 'tls'; certificate: Certificate };

const TIMEOUT = 5000;

async function attempt(url: string, mode: RequestMode): Promise<Response | null> {
  try {
    return await fetch(url, { mode, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    return null;
  }
}

export async function diagnose(server: string): Promise<Diagnosis> {
  // Requests to a local address fail at once without the permission (api.ts).
  if (looksLocal(server) && !(await localNetworkAllowed())) return { kind: 'localNetwork' };
  if (usesNativeTransport(server)) return diagnoseNative(server);
  const url = `${server}/api/auth/status`;
  const response = await attempt(url, 'cors');
  if (response) return answered(response);
  // An opaque answer means the connection, certificate included, was fine.
  if (await attempt(url, 'no-cors')) return { kind: 'blocked' };
  const probe = await invoke<Probe>('probe_server', { url: server });
  if (probe.result === 'tls') {
    // The webview refused a certificate the handshake shows; does the device trust it?
    return (await platformTrusts(server))
      ? { kind: 'webviewOnly', certificate: probe.certificate }
      : { kind: 'untrusted', certificate: probe.certificate };
  }
  return fromProbe(probe);
}

/** A server the app connects to itself: its own request says what is wrong. */
async function diagnoseNative(server: string): Promise<Diagnosis> {
  try {
    return answered(await serverFetch(`${server}/api/auth/status`, { cache: 'no-store' }));
  } catch (err) {
    if (err instanceof UntrustedCertificateError) {
      if (!err.pinned) return { kind: 'untrusted', certificate: err.certificate };
      const origin = originOf(server);
      const accepted = (await acceptedCertificates().catch(() => [])).find(
        (pin) => pin.origin === origin,
      );
      return {
        kind: 'certificateChanged',
        certificate: err.certificate,
        accepted: accepted?.sha256 ?? null,
      };
    }
  }
  const probe = await invoke<Probe>('probe_server', { url: server });
  return probe.result === 'tls' ? { kind: 'unreachable' } : fromProbe(probe);
}

function answered(response: Response): Diagnosis {
  return response.status >= 502 && response.status <= 504
    ? { kind: 'gateway' }
    : { kind: 'reachable' };
}

async function fromProbe(probe: Exclude<Probe, { result: 'tls' }>): Promise<Diagnosis> {
  switch (probe.result) {
    case 'notTls':
    case 'unreachable':
      // Without the permission, a server on the local network fails like one that is down.
      if (!(await localNetworkAllowed())) return { kind: 'localNetwork' };
      return probe.result === 'notTls'
        ? { kind: 'unreachable' }
        : { kind: 'unreachable', reason: probe.reason };
    case 'tlsFailed':
      return { kind: 'tlsFailed', reason: probe.reason };
  }
}

// Several views fail at once when the server goes away; they share one diagnosis, unless the
// user changed what the app trusts since.
const recent = new Map<string, { at: number; trust: number; diagnosis: Promise<Diagnosis> }>();

function diagnoseOnce(server: string): Promise<Diagnosis> {
  const cached = recent.get(server);
  const trust = trustGeneration();
  if (cached && cached.trust === trust && Date.now() - cached.at < 3000) return cached.diagnosis;
  const diagnosis = diagnose(server);
  recent.set(server, { at: Date.now(), trust, diagnosis });
  return diagnosis;
}

/**
 * Diagnoses `server` whenever `trigger` changes to something truthy (a new error, or going
 * offline), and again every `refreshMs` while it stays so, showing the last result meanwhile:
 * what fails may change during an outage (a server restarted with a new certificate).
 * Undefined while the first one runs or when there is nothing to diagnose.
 */
export function useDiagnosis(
  server: string,
  trigger: unknown,
  refreshMs?: number,
): Diagnosis | undefined {
  const [result, setResult] = useState<{ trigger: unknown; diagnosis: Diagnosis }>();
  useEffect(() => {
    if (!trigger || !server) return;
    let current = true;
    const run = () =>
      diagnoseOnce(server).then(
        (diagnosis) => {
          if (current) setResult({ trigger, diagnosis });
        },
        (err: unknown) => console.warn('Diagnosis failed:', err),
      );
    void run();
    const timer = refreshMs ? setInterval(run, refreshMs) : undefined;
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [server, trigger, refreshMs]);
  return result && result.trigger === trigger ? result.diagnosis : undefined;
}
