import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

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
  /** Nothing answers: wrong address, server down, or not on the same network. */
  | { kind: 'unreachable'; reason?: string }
  /** Something answers, but not with TLS, or the TLS handshake fails. */
  | { kind: 'tlsFailed'; reason: string }
  /** The server answers with TLS, but the device does not trust its certificate. */
  | { kind: 'untrusted'; certificate: Certificate };

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
  const url = `${server}/api/auth/status`;
  const response = await attempt(url, 'cors');
  if (response) {
    return response.status >= 502 && response.status <= 504
      ? { kind: 'gateway' }
      : { kind: 'reachable' };
  }
  // An opaque answer means the connection, certificate included, was fine.
  if (await attempt(url, 'no-cors')) return { kind: 'blocked' };
  const probe = await invoke<Probe>('probe_server', { url: server });
  switch (probe.result) {
    case 'notTls':
      return { kind: 'unreachable' };
    case 'unreachable':
      return { kind: 'unreachable', reason: probe.reason };
    case 'tlsFailed':
      return { kind: 'tlsFailed', reason: probe.reason };
    case 'tls':
      return { kind: 'untrusted', certificate: probe.certificate };
  }
}

// Several views fail at once when the server goes away; they share one diagnosis.
const recent = new Map<string, { at: number; diagnosis: Promise<Diagnosis> }>();

function diagnoseOnce(server: string): Promise<Diagnosis> {
  const cached = recent.get(server);
  if (cached && Date.now() - cached.at < 3000) return cached.diagnosis;
  const diagnosis = diagnose(server);
  recent.set(server, { at: Date.now(), diagnosis });
  return diagnosis;
}

/**
 * Diagnoses `server` whenever `trigger` changes to something truthy (a new error, or going
 * offline). Undefined while it runs or when there is nothing to diagnose.
 */
export function useDiagnosis(server: string, trigger: unknown): Diagnosis | undefined {
  const [result, setResult] = useState<{ trigger: unknown; diagnosis: Diagnosis }>();
  useEffect(() => {
    if (!trigger || !server) return;
    let current = true;
    diagnoseOnce(server).then(
      (diagnosis) => {
        if (current) setResult({ trigger, diagnosis });
      },
      (err: unknown) => console.warn('Diagnosis failed:', err),
    );
    return () => {
      current = false;
    };
  }, [server, trigger]);
  return result && result.trigger === trigger ? result.diagnosis : undefined;
}
