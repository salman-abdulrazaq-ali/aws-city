// The City tab's way in to linking an AWS account, for a hosted player who is signed in and hasn't linked one. Linking
// is why they're on a real server, so it shouldn't need ⋯ → Show everything to find. Not a primary button: the City tab
// keeps one primary (the next action), and this card sits above the list until the account is linked.
import { useCity } from '@/state/store';
import type { OpenTab } from './QuestLog';
import { useCanConnect } from './useLadder';

export function ConnectCard({ openTab }: { openTab: OpenTab }) {
  const canConnect = useCanConnect();
  const signedIn = useCity((s) => s.backendStatus !== 'signed-out');
  if (!canConnect || !signedIn) return null;
  return (
    <section className="card connect-card" aria-labelledby="connect-title">
      <h3 id="connect-title">Connect your AWS account</h3>
      <p className="muted">Your city mirrors your real account and its agents look after it. Nothing changes there until you approve it.</p>
      <button className="btn" onClick={() => openTab('deploy')}>
        Connect it (opens Deploy)
      </button>
    </section>
  );
}
