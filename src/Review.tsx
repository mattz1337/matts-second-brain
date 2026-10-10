import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  ShieldCheck,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api } from './api';
import { useResource } from './hooks';
import { SectionHeading, KnowledgeCard, Loading, Empty, Modal } from './components';
import type { Knowledge } from '../shared/contracts';
import { useUrlState } from './navigation';

export default function Review({
  revision,
  onOpen,
  onChanged,
}: {
  revision: number;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useUrlState<'candidates' | 'due' | 'conflicts'>(
    'review_tab',
    'candidates',
    ['candidates', 'due', 'conflicts'],
  );
  const { data, error, loading, retry } = useResource(
    () => api<{ candidates: Knowledge[]; due: Knowledge[]; conflicts: Knowledge[] }>('/review'),
    [revision],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<'accept' | 'reject' | null>(null);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState('');
  const items = data?.[tab] || [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(items.length / 25) - 1));
  const visible = items.slice(currentPage * 25, (currentPage + 1) * 25);
  const pageSelected = visible.length > 0 && visible.every((item) => selected.includes(item.id));
  useEffect(() => {
    setPage(0);
    setSelected([]);
    setBatchError('');
    setNotice('');
  }, [tab]);
  useEffect(() => {
    if (loading || !data) return;
    setSelected((previous) =>
      previous.filter((id) => data.candidates.some((item) => item.id === id)),
    );
  }, [data, loading]);
  async function reviewBatch() {
    if (busy || loading || !selected.length) return;
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
      if (failed.length) {
        setBatchError(
          `${failed.length} items could not be reviewed: ${failed.map((r) => r.error).join('; ')}`,
        );
        setSelected(failed.map((item) => item.id));
      } else {
        setBatch(null);
        setSelected([]);
        setRationale('');
      }
      const succeeded = result.results.length - failed.length;
      if (succeeded)
        setNotice(
          `${batch === 'accept' ? 'Accepted' : 'Rejected'} ${succeeded} ${succeeded === 1 ? 'candidate' : 'candidates'}.`,
        );
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
          {error && (
            <button className="button small" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="review-notice" aria-live="polite">
          {notice}
        </p>
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
                  checked={pageSelected}
                  disabled={!pageSelected && selected.length >= 50}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...new Set([...selected, ...visible.map((item) => item.id)])].slice(
                            0,
                            50,
                          )
                        : selected.filter((id) => !visible.some((item) => item.id === id)),
                    )
                  }
                />
                Select this page
              </label>
              <span>{selected.length} of 50 selected</span>
              <button
                className="button small"
                disabled={!selected.length}
                onClick={() => {
                  setBatchError('');
                  setBatch('accept');
                }}
              >
                Accept selected
              </button>
              <button
                className="button small"
                disabled={!selected.length}
                onClick={() => {
                  setBatchError('');
                  setBatch('reject');
                }}
              >
                Reject selected
              </button>
            </div>
          )}
          <div className="knowledge-list">
            {visible.map((k) => (
              <div className="review-row" key={k.id}>
                {tab === 'candidates' && (
                  <input
                    aria-label={`Select ${k.title}`}
                    type="checkbox"
                    checked={selected.includes(k.id)}
                    disabled={!selected.includes(k.id) && selected.length >= 50}
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
          {items.length > 25 && (
            <div className="pagination">
              <button
                className="button small"
                aria-label="Previous review page"
                disabled={!currentPage}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft size={14} />
                Previous
              </button>
              <span>
                {currentPage * 25 + 1}–{Math.min((currentPage + 1) * 25, items.length)} of{' '}
                {items.length}
              </span>
              <button
                className="button small"
                aria-label="Next review page"
                disabled={(currentPage + 1) * 25 >= items.length}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          )}
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
          closeDisabled={busy}
          initialFocus="textarea"
        >
          <form
            className="capture-form"
            onSubmit={(e) => {
              e.preventDefault();
              void reviewBatch();
            }}
          >
            {batchError && (
              <div className="inline-error" role="alert">
                {batchError}
              </div>
            )}
            {notice && <p className="review-notice">{notice}</p>}
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
            <button className="button primary" disabled={busy || loading || !selected.length}>
              {busy ? 'Reviewing…' : batchError ? 'Retry remaining' : `Confirm ${batch}`}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
