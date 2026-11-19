import type { Live, SessionDetail } from '@f1/contracts';
import { Link } from '../lib/routes.ts';
import { LIVE_TEXT, type NoDataWhat, noDataText } from '../lib/session.ts';

/** A tab without data says why (`noDataText`, #99); live now, "follow it" links to `/live`. */
export function NoData({
  session,
  live,
  what,
  now = Date.now(),
  lead,
}: {
  session: SessionDetail['session'];
  live: Live | null;
  what: NoDataWhat;
  now?: number;
  /** A sentence in front of the reason, in the same paragraph (#238). */
  lead?: string | undefined;
}) {
  const text = noDataText(session, live, now, what);
  return (
    <p>
      {lead && `${lead} `}
      {text === LIVE_TEXT ? (
        <>
          Live now: <Link to="/live">follow it</Link>.
        </>
      ) : (
        text
      )}
    </p>
  );
}
