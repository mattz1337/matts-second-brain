import { useState } from 'react';
import { GitMerge, RotateCcw, Network } from 'lucide-react';
import { api, date } from './api';
import { useResource } from './hooks';
import { Modal, Loading, Badge } from './components';

interface Entity {
  id: string;
  canonical: string;
  label: string;
  type: string;
  aliases: string[];
}
interface Merge {
  id: string;
  from_id: string;
  to_id: string;
  created_at: string;
  undone_at: string | null;
}
export default function EntityDetail({
  id,
  onClose,
  onChanged,
  onGraph,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onGraph: (id: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const entities = useResource(() => api<Entity[]>('/entities'), [id, revision]);
  const merges = useResource(() => api<Merge[]>('/entities/merges'), [revision]);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const entity = entities.data?.find((e) => e.id === id);
  async function merge() {
    setBusy(true);
    setError('');
    try {
      await api('/entities/merge', { from: id, to: target });
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function undo(mergeId: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/entities/merges/${mergeId}/undo`, {});
      setRevision((x) => x + 1);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Named entity" onClose={onClose}>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {entities.loading && !entities.data ? (
        <Loading />
      ) : entity ? (
        <>
          <div className="detail-badges">
            <Badge>Entity</Badge>
            <span className="version-label">Explicit connections</span>
          </div>
          <h2 className="detail-title">{entity.label}</h2>
          <p className="section-caption">
            A person, product, organization, or concept mentioned by your claims.
          </p>
          {!!entity.aliases.length && (
            <div className="detail-topics">
              {entity.aliases.map((a) => (
                <span className="tag" key={a}>
                  {a}
                </span>
              ))}
            </div>
          )}
          <button
            className="button small"
            style={{ marginTop: 20 }}
            onClick={() => {
              onClose();
              onGraph(id);
            }}
          >
            <Network size={14} />
            Focus this entity
          </button>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void merge();
            }}
          >
            <h4>
              <GitMerge size={15} /> Combine duplicate names
            </h4>
            <p className="section-caption">
              Review context before merging. Original connections and aliases are saved so the merge
              can be undone.
            </p>
            <label>
              Merge into
              <select required value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose the canonical entity</option>
                {entities.data
                  ?.filter((e) => e.type === 'entity' && e.id !== id)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
              </select>
            </label>
            <button className="button primary small" disabled={busy || !target}>
              Merge entities
            </button>
          </form>
          <div className="history-list">
            <h4>Merge history for this entity</h4>
            {merges.data
              ?.filter((m) => m.to_id === id)
              .map((m) => (
                <article key={m.id}>
                  <div>
                    <strong>{m.undone_at ? 'Merge undone' : 'Names combined'}</strong>
                    <p>{date(m.created_at)}</p>
                    {!m.undone_at && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => void undo(m.id)}
                      >
                        <RotateCcw size={13} />
                        Undo merge
                      </button>
                    )}
                  </div>
                </article>
              ))}
          </div>
        </>
      ) : (
        <p className="section-caption">
          This entity was merged or removed. Refresh the graph to inspect its canonical name.
        </p>
      )}
    </Modal>
  );
}
