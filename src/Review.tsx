import { useState } from 'react';
import { CheckCircle2, Clock, ShieldCheck, ArrowRight } from 'lucide-react';
import { api } from './api';
import { useResource } from './hooks';
import { SectionHeading, KnowledgeCard, Loading, Empty, Modal } from './components';
import type { Knowledge } from '../shared/contracts';

export default function Review({
  revision,
  onOpen,
  onChanged,
}: {
  revision: number;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'candidates' | 'due' | 'conflicts'>('candidates');
  const { data, error, loading } = useResource(
    () => api<{ candidates: Knowledge[]; due: Knowledge[]; conflicts: Knowledge[] }>('/review'),
    [revision],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<'accept' | 'reject' | null>(null);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  async function reviewBatch() {
    setBusy(true);
    setBatchError('');
    try {
      const result = await api<{ results: { id: string; ok: boolean; error?: string }[] }>(
        '/review/batch',
        {
          items: data?.candidates
            .filter((k) => selected.includes(k.id))
            .map((k) => ({ id: k.id, expected_version: k.version })),
          decision: batch,
          rationale,
        },
      );
      const failed = result.results.filter((r) => !r.ok);
      if (failed.length)
        setBatchError(
          `${failed.length} items could not be reviewed: ${failed.map((r) => r.error).join('; ')}`,
        );
      setBatch(null);
      setSelected([]);
      setRationale('');
      onChanged();
    } catch (e) {
      setBatchError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SectionHeading
        eyebrow="KEEP IT USEFUL"
        title="A little care, better knowledge."
        description="Review new claims, check what has changed, and make room for uncertainty."
      />
      <div className="review-intro">
        <ShieldCheck size={24} />
        <div>
          <strong>You decide what belongs.</strong>
          <p>
            Accepting keeps knowledge in your collection. Verifying records an actual check of its
            evidence.
          </p>
        </div>
      </div>
      <div className="review-tabs">
        {(['candidates', 'due', 'conflicts'] as const).map((t) => (
          <button
            className={tab === t ? 'active' : ''}
            key={t}
            onClick={() => {
              setTab(t);
              setSelected([]);
            }}
          >
            {t === 'candidates' ? (
              <CheckCircle2 size={16} />
            ) : t === 'due' ? (
              <Clock size={16} />
            ) : (
              <ShieldCheck size={16} />
            )}{' '}
            {t === 'candidates'
              ? 'New candidates'
              : t === 'due'
                ? 'Needs verification'
                : 'Conflicting claims'}
            <span>{data?.[t].length || 0}</span>
          </button>
        ))}
      </div>
      {(error || batchError) && (
        <div className="inline-error" role="alert">
          {error || batchError}
        </div>
      )}
      {loading && !data ? (
        <Loading />
      ) : data?.[tab].length ? (
        <>
          <div className="results-heading">
            <span>{data[tab].length} items to consider</span>
            <span>
              Open a claim to review its evidence
              <ArrowRight size={13} />
            </span>
          </div>
          {tab === 'candidates' && (
            <div className="batch-controls">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={
                    !!selected.length && selected.length === Math.min(50, data.candidates.length)
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? data.candidates.slice(0, 50).map((k) => k.id) : [],
                    )
                  }
                />
                Select candidates
              </label>
              <span>{selected.length} selected</span>
              <button
                className="button small"
                disabled={!selected.length}
                onClick={() => setBatch('accept')}
              >
                Accept selected
              </button>
              <button
                className="button small"
                disabled={!selected.length}
                onClick={() => setBatch('reject')}
              >
                Reject selected
              </button>
            </div>
          )}
          <div className="knowledge-list">
            {data[tab].map((k) => (
              <div className="review-row" key={k.id}>
                {tab === 'candidates' && (
                  <input
                    aria-label={`Select ${k.title}`}
                    type="checkbox"
                    checked={selected.includes(k.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, k.id].slice(0, 50)
                          : selected.filter((id) => id !== k.id),
                      )
                    }
                  />
                )}
                <KnowledgeCard item={k} onOpen={onOpen} />
              </div>
            ))}
          </div>
        </>
      ) : (
        <Empty
          title={
            tab === 'candidates'
              ? 'All caught up.'
              : tab === 'due'
                ? 'Your knowledge is up to date.'
                : 'No unresolved conflicts.'
          }
          description={
            tab === 'candidates'
              ? 'New imports and assistant contributions will appear here for review.'
              : tab === 'due'
                ? 'Knowledge due for a check, or awaiting its first verification, will appear here.'
                : 'Structured claims with overlapping context and different values will be flagged for your review.'
          }
        />
      )}{' '}
      {batch && (
        <Modal
          title={batch === 'accept' ? 'Accept selected candidates' : 'Reject selected candidates'}
          onClose={() => setBatch(null)}
        >
          <form
            className="capture-form"
            onSubmit={(e) => {
              e.preventDefault();
              void reviewBatch();
            }}
          >
            <p className="section-caption">
              Review {selected.length} candidates. Acceptance does not verify their truth.
            </p>
            <label>
              Review rationale
              <textarea
                required
                minLength={3}
                rows={3}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy}>
              Confirm {batch}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
