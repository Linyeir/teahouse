import { type ReactNode, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ui from './ui.module.css';

/**
 * A modal dialog inside the app, instead of the browser's `confirm()`: it follows the theme,
 * keeps focus inside, Escape cancels, and focus returns to where it was. Rendered only while
 * it is open.
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
    // Where focus goes back to once the dialog is gone, e.g. the menu button that opened it.
    const previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
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

/**
 * Asks before something that cannot be undone. With `danger`, the confirming button is the
 * only filled one, in the danger color.
 */
export function ConfirmDialog({
  title,
  children,
  confirm,
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  /** Label of the confirming button, a verb such as "Delete". */
  confirm: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={title}
      onCancel={onCancel}
      actions={
        <>
          <button className={ui.button} type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            className={danger ? ui.dangerPrimary : ui.primary}
            type="button"
            disabled={pending}
            onClick={onConfirm}
          >
            {confirm}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
