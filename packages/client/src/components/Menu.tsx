import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { IconButton } from './IconButton.tsx';
import ui from './ui.module.css';

/** The menu's enabled items, in order. */
const enabledItems = (list: HTMLElement | null) => [
  ...(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []),
];

export type MenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown in the danger color, e.g. for Delete. */
  danger?: boolean;
};

/**
 * A button that opens a short list of actions. Arrow keys move between them, Escape and a
 * click outside close it, and focus goes back to the button.
 */
export function Menu({
  label,
  icon = '⋯',
  items,
}: {
  label: string;
  icon?: ReactNode;
  items: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    enabledItems(list.current)[0]?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return (
    <div className={ui.menuAnchor}>
      <IconButton
        ref={button}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </IconButton>
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={ui.menu}
          onKeyDown={(e) => {
            const all = enabledItems(list.current);
            const at = all.indexOf(document.activeElement as HTMLButtonElement);
            const move = (to: number) => {
              e.preventDefault();
              all[(to + all.length) % all.length]?.focus();
            };
            if (e.key === 'ArrowDown') move(at + 1);
            else if (e.key === 'ArrowUp') move(at - 1);
            else if (e.key === 'Home') move(0);
            else if (e.key === 'End') move(all.length - 1);
            else if (e.key === 'Escape' || e.key === 'Tab') {
              e.preventDefault();
              close();
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`${ui.menuItem} ${item.danger ? ui.menuDanger : ''}`}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
