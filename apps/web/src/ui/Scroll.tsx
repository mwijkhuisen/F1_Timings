import type { ReactNode } from 'react';

/**
 * A table's scroll box (A§13): a named region a keyboard can reach and scroll with the arrow keys
 * (`tabIndex=0`), with `scroll-padding` in styles.css clear of its sticky header and columns.
 */
export function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1, a scroll box must be reachable to scroll it without a pointer.
    // biome-ignore lint/a11y/useSemanticElements: a box around one table, not a document section; role="region" with its name is what a screen reader lists.
    <div className="scroll" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}
