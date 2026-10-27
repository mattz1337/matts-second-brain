import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useResource } from './hooks';
import { api } from './api';
import { Badge } from './components';
type Proposal = {
  id: string;
  source_title: string;
  target_title: string;
  relation: string;
  confidence: string;
  status: string;
  rationale: string;
};
export default function GraphifySettings({ onChanged }: { onChanged: () => void }) {
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [graph, setGraph] = useState<File | null>(null),
    [manifest, setManifest] = useState<File | null>(null);
  const proposals = useResource(() => api<Proposal[]>('/assistant/graphify/proposals'), [revision]);
  async function upload() {
    if (!graph || !manifest) return;
    setBusy(true);
    setError('');
    try {
      if (graph.size + manifest.size > 8 * 1024 * 1024)
        throw Error('Choose graph and manifest files totaling at most 8 MB.');
      const result = await api<{
        created: number;
        existing: number;
        stale: number;
        unmatched: number;
      }>('/assistant/graphify/import', {
        graph: JSON.parse(await graph.text()),
        manifest: JSON.parse(await manifest.text()),
      });
      setMessage(
        `${result.created} new suggestions, ${result.existing} already reviewed, ${result.stale} stale and ${result.unmatched} unmatched connections. No graph links changed automatically.`,
      );
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function decide(id: string, decision: 'accept' | 'dismiss') {
    setBusy(true);
    setError('');
    try {
      await api(`/assistant/graphify/proposals/${id}`, { decision });
      setRevision((v) => v + 1);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card graphify-settings">
      <div className="settings-card-heading">
        <div className="settings-icon">
          <GitBranch size={22} />
        </div>
        <div>
          <h2>Graphify connections</h2>
          <p>
            Optional source-backed suggestions across your notes. You choose which links join your
            graph.
          </p>
        </div>
      </div>
      <ol>
        <li>
          <a href="/api/assistant/graphify/corpus" className="button small">
            Export a local corpus
          </a>{' '}
          Keep its <code>orbit-manifest.json</code>.
        </li>
        <li>
          Run Graphify on the exported folder. Semantic extraction may send notes to its configured
          provider.
        </li>
        <li>Import its graph and the matching manifest, then review the connections.</li>
      </ol>
      <div className="assistant-settings-grid">
        <label>
          Graphify graph.json
          <input
            type="file"
            accept=".json"
            onChange={(e) => setGraph(e.target.files?.[0] || null)}
          />
        </label>
        <label>
          Matching orbit-manifest.json
          <input
            type="file"
            accept=".json"
            onChange={(e) => setManifest(e.target.files?.[0] || null)}
          />
        </label>
      </div>
      <button
        className="button small"
        disabled={busy || !graph || !manifest}
        onClick={() => void upload()}
      >
        Import suggestions
      </button>
      {(error || proposals.error) && (
        <p role="alert" className="error">
          {error || proposals.error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="graphify-proposals">
        {proposals.data?.map((p) => (
          <article key={p.id}>
            <header>
              <strong>
                {p.source_title} ↔ {p.target_title}
              </strong>
              <Badge>{p.status}</Badge>
            </header>
            <p>
              {p.relation} · {p.confidence}
            </p>
            <small>{p.rationale}</small>
            <div>
              {p.status === 'proposed' && (
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() => void decide(p.id, 'accept')}
                >
                  Accept connection
                </button>
              )}
              {p.status !== 'dismissed' && (
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() => void decide(p.id, 'dismiss')}
                >
                  {p.status === 'accepted' ? 'Remove Graphify link' : 'Dismiss'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!proposals.data?.length && !proposals.loading && (
        <p className="assistant-notice">
          No imported suggestions yet. Orbit’s existing search and graph work independently.
        </p>
      )}
    </section>
  );
}
