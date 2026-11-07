import type { ReactNode } from 'react';

/** Struck through, with the word for a screen reader, which does not announce `<s>`. */
export const Cancelled = ({ children }: { children: ReactNode }) => (
  <s>
    {children}
    <span className="vh"> (cancelled)</span>
  </s>
);
