import type { ComponentProps } from 'react';
import ui from './ui.module.css';

/** A square button that shows only a symbol; `label` is what screen readers announce. */
export function IconButton({
  label,
  className,
  ...props
}: { label: string } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={`${ui.iconButton} ${className ?? ''}`}
    />
  );
}
