import type { ReactNode } from 'react';
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

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className={ui.error}>{error instanceof Error ? error.message : String(error)}</p>;
}
