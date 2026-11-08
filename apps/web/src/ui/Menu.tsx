import type { MouseEvent, ReactNode } from 'react';

/**
 * A button that opens a list of links in a native popover (like ui/Note.tsx): Escape and a click outside close it
 * for free, and so does a click on one of its links. `id` must be unique on the page; `children` are `<li>`s.
 */
export function Menu({
  id,
  label,
  name,
  children,
}: {
  id: string;
  label: ReactNode;
  name?: string | undefined;
  children: ReactNode;
}) {
  const close = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('a')) e.currentTarget.hidePopover();
  };
  return (
    <>
      <button type="button" popoverTarget={id} aria-label={name}>
        {label}{' '}
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the links inside are the controls; their click bubbles here. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on a link fires the same click event. */}
      <div popover="auto" id={id} className="pop menu" onClick={close}>
        <ul>{children}</ul>
      </div>
    </>
  );
}
