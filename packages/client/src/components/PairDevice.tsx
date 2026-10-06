import { useMutation, useQuery } from '@tanstack/react-query';
import type { Device, PairingCode, ServerAddresses } from '@teahouse/shared';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, getServer } from '../api.ts';
import { isLoopback, pairingLink } from '../pairing.ts';
import { ErrorText, Field } from './Field.tsx';
import styles from './PairDevice.module.css';
import ui from './ui.module.css';

/** `ABCDE12345` → `ABCDE-12345`, easier to read out and type. */
const formatCode = (code: string) => code.replace(/^(.{5})(.+)$/, '$1-$2');

function useCountdown(until: string | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.round((Date.parse(until) - now) / 1000)) : 0;
}

/**
 * Shows a one-time pairing code as QR code and link (concept, section 3). The panel closes
 * by itself once a new device shows up in the device list.
 */
export function PairDevice({ devices }: { devices: Device[] | undefined }) {
  const { t } = useTranslation();
  const own = getServer() || window.location.origin;
  const [address, setAddress] = useState(own);
  const [knownDevices, setKnownDevices] = useState<number | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<PairingCode>('/api/pairing'),
    onSuccess: () => setKnownDevices(devices?.length ?? 0),
  });
  const pairing = create.data;
  const seconds = useCountdown(pairing?.expiresAt);
  const open = pairing !== undefined && knownDevices !== null;
  const link = pairing ? pairingLink(address, pairing.code) : '';

  // localhost is useless on a phone: offer the server's network addresses instead.
  const loopback = isLoopback(own);
  const addresses = useQuery({
    queryKey: ['pairing-addresses'],
    queryFn: () => api.get<ServerAddresses>('/api/pairing/addresses'),
    enabled: open && loopback,
  });
  const candidates = (() => {
    const base = new URL(own);
    const port = base.port ? `:${base.port}` : '';
    return (addresses.data?.addresses ?? []).map((ip) => `${base.protocol}//${ip}${port}`);
  })();
  // Suggest the first network address once; after that the field is the user's.
  const suggested = useRef(false);
  const firstCandidate = candidates[0];
  useEffect(() => {
    if (!loopback || !firstCandidate || suggested.current) return;
    suggested.current = true;
    setAddress(firstCandidate);
  }, [loopback, firstCandidate]);

  useEffect(() => {
    if (!link) return;
    let current = true;
    void QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (svg) => current && setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
    );
    return () => {
      current = false;
    };
  }, [link]);

  const close = () => {
    setKnownDevices(null);
    create.reset();
  };
  const paired = open && (devices?.length ?? 0) > (knownDevices ?? 0);
  useEffect(() => {
    if (paired) {
      setKnownDevices(null);
      create.reset();
    }
  }, [paired, create.reset]);

  if (!open) {
    return (
      <>
        <button
          className={ui.button}
          type="button"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {t('pairing.start')}
        </button>
        <ErrorText error={create.error} />
      </>
    );
  }

  const expired = seconds === 0;
  return (
    <div className={styles.panel}>
      <p className={ui.muted}>{t('pairing.hint')}</p>
      <div className={styles.body}>
        {qr && (
          <img
            className={styles.qr}
            src={qr}
            alt={t('pairing.qrAlt')}
            style={{ opacity: expired ? 0.2 : 1 }}
          />
        )}
        <div className={styles.details}>
          <div className={styles.code}>{formatCode(pairing.code)}</div>
          <div className={ui.hint}>
            {expired
              ? t('pairing.expired')
              : t('pairing.expiresIn', {
                  time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
                })}
          </div>
          <Field
            label={t('pairing.address')}
            hint={loopback && !candidates.length ? t('pairing.loopbackHint') : undefined}
          >
            <input
              className={ui.input}
              list="pairing-addresses"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <datalist id="pairing-addresses">
              {[own, ...candidates].map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </Field>
          <button
            className={ui.ghost}
            type="button"
            onClick={() => void navigator.clipboard?.writeText(link)}
          >
            {t('pairing.copyLink')}
          </button>
        </div>
      </div>
      <div className={ui.actions}>
        {expired && (
          <button className={ui.button} type="button" onClick={() => create.mutate()}>
            {t('pairing.newCode')}
          </button>
        )}
        <button className={ui.button} type="button" onClick={close}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
