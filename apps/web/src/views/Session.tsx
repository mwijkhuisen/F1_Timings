import type { View } from '../lib/routes.ts';

// Placeholder: step B loads the session and shows the lap table or stints (D1, D11).
export const Session = ({ session, view }: { session: number; view: View }) => (
  <p>
    Session {session} {view}
  </p>
);
