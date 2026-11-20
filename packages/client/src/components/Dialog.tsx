import { type ReactNode, useEffect, useId, useRef } from 'react';
import ui from './ui.module.css';

/**
 * A modal dialog inside the app, instead of the browser's `confirm()`: it follows the theme,
 * keeps focus inside, and Escape cancels. Rendered only while it is open.
 */
export function Dialog({
  title,
  children,
  actions,
  onCancel,
  sheet = false,
}: {
  title: string;
  children?: ReactNode;
  /** Buttons, the primary one last. */
  actions: ReactNode;
  onCancel: () => void;
  /** A sheet from the bottom edge on phones, a dialog elsewhere. */
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${ui.dialog} ${sheet ? ui.sheet : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
      <div className={ui.actions}>{actions}</div>
    </dialog>
  );
}
