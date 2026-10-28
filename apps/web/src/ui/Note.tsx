import type { ReactNode } from 'react';

/**
 * Content with a reason behind it: a hover shows the title, a tap opens the
 * popover. The native popover needs no JS state, so it works on a phone (D10).
 * `id` must be unique on the page.
 */
export const Note = ({ id, text, children }: { id: string; text: string; children: ReactNode }) => (
  <>
    <button type="button" className="note" popoverTarget={id} aria-describedby={id} title={text}>
      {children}
    </button>
    <div popover="auto" id={id} className="pop">
      {text}
    </div>
  </>
);
