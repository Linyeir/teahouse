import type { ReactNode } from 'react';
import { NetworkError } from '../offline.ts';
import { NetworkErrorText } from './ServerDiagnosis.tsx';
import ui from './ui.module.css';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className={ui.field}>
      {label}
      {children}
      {hint && <span className={ui.hint}>{hint}</span>}
    </label>
  );
}

export function ErrorText({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  if (error instanceof NetworkError) return <NetworkErrorText error={error} onRetry={onRetry} />;
  return <p className={ui.error}>{error instanceof Error ? error.message : String(error)}</p>;
}
