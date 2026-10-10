import { useState } from 'react';
import type { ItemCategories, ItemCategory } from '../shared/contracts';
import { api } from './api';
import { useResource } from './hooks';
import { Modal, Loading, Badge } from './components';

export default function CategoryEditor({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const { data, error, loading, retry } = useResource(
    () => api<ItemCategories>(`/categories/items/${id}`),
    [id, revision],
    3000,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [path, setPath] = useState('');
  async function decide(
    action: 'accept' | 'dismiss' | 'reset',
    categoryId?: string,
    newPath?: string[],
  ) {
    if (!data) return;
    setBusy(true);
    setActionError('');
    try {
      await api(`/categories/items/${id}/decisions`, {
        expected_version: data.decision_version,
        action,
        ...(categoryId ? { category_id: categoryId } : { path: newPath }),
      });
      setPath('');
      setRevision((value) => value + 1);
      onChanged();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Category correction failed.');
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  const confidence = (item: ItemCategory) =>
    item.similarity !== undefined ? (
      <p className="category-confidence">
        Confidence: <strong>{item.confidence}</strong> · Similarity {item.similarity.toFixed(3)}
        {item.margin !== undefined && ` · Separation ${item.margin.toFixed(3)}`}
      </p>
    ) : null;
  const decisionOf = (id: string) =>
    data?.decisions.find((item) => item.category_id === id)?.decision;
  const remaining =
    data?.suggestions.filter(
      (item) =>
        !data.assigned.some((assigned) => assigned.category_id === item.category_id) &&
        decisionOf(item.category_id) !== 'dismiss',
    ) || [];
  return (
    <Modal title="Organize categories" onClose={onClose} wide>
      {(error || actionError || data?.error) && (
        <div className="inline-error" role="alert">
          {error || actionError || data?.error}
          {error && (
            <button className="button small" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <div className="category-editor">
            <h3>{data.title}</h3>
            <p className="section-caption">
              Categories describe subjects. Imported notebooks remain source information and provide
              context through their titles and independently categorized notes. Suggestions use
              meaning and tags. Confidence describes model similarity and separation, not a
              probability. Your confirmations and dismissals survive rescans and edits.
            </p>
            {data.semantic_state === 'pending' && (
              <p role="status">
                Semantic categorization pending. Suggestions will appear here automatically.
              </p>
            )}
            {data.semantic_state === 'disabled' && (
              <p role="status">
                Semantic model is disabled. Metadata and keyword fallback are shown; enable local
                embeddings for semantic suggestions.
              </p>
            )}
            <section className="assigned-categories">
              <h4>Current categories</h4>
              {data.assigned.map((item) => (
                <article className="category-assignment" key={item.category_id}>
                  <div>
                    <strong>{item.path.join(' / ')}</strong>
                    <Badge tone={item.method === 'manual' ? 'green' : 'amber'}>
                      {item.method === 'manual'
                        ? 'Confirmed'
                        : item.method === 'semantic'
                          ? item.level === 'broad'
                            ? 'Broad suggestion'
                            : 'Suggested'
                          : item.method === 'fallback'
                            ? 'Needs a category'
                            : 'From metadata / fallback'}
                    </Badge>
                  </div>
                  {confidence(item)}
                  <p>{item.rationale}</p>
                  {item.method !== 'fallback' && (
                    <div className="category-decision-actions">
                      {item.method !== 'manual' && (
                        <button
                          className="button small"
                          disabled={busy}
                          onClick={() => void decide('accept', item.category_id)}
                          aria-label={`Confirm category: ${item.path.join(' / ')}`}
                        >
                          Confirm
                        </button>
                      )}
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() => void decide('dismiss', item.category_id)}
                        aria-label={`Dismiss category: ${item.path.join(' / ')}`}
                      >
                        Dismiss
                      </button>
                      {item.method === 'manual' && (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => void decide('reset', item.category_id)}
                          aria-label={`Use automatic category: ${item.path.join(' / ')}`}
                        >
                          Use automatic
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </section>
            {!!remaining.length && (
              <section className="suggested-categories">
                <h4>Other suggestions</h4>
                {remaining.map((item) => (
                  <article className="category-assignment" key={item.category_id}>
                    <strong>{item.path.join(' / ')}</strong>
                    {confidence(item)}
                    <p>{item.rationale}</p>
                    <div className="category-decision-actions">
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() => void decide('accept', item.category_id)}
                        aria-label={`Accept suggestion: ${item.path.join(' / ')}`}
                      >
                        Accept suggestion
                      </button>
                      <button
                        className="button small"
                        disabled={busy}
                        onClick={() => void decide('dismiss', item.category_id)}
                        aria-label={`Dismiss suggestion: ${item.path.join(' / ')}`}
                      >
                        Dismiss
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}
            <form
              className="category-add"
              onSubmit={(event) => {
                event.preventDefault();
                const parts = path
                  .split(/\s*(?:\/|>)\s*/)
                  .map((part) => part.trim())
                  .filter(Boolean);
                if (parts.length) void decide('accept', undefined, parts);
              }}
            >
              <label htmlFor="manual-category-path">Add a category or hierarchy</label>
              <div>
                <input
                  id="manual-category-path"
                  placeholder="Personal / Learning"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  maxLength={400}
                />
                <button className="button small" disabled={busy || !path.trim()} type="submit">
                  Add category
                </button>
              </div>
            </form>
            {data.decisions.some((item) => item.decision === 'dismiss') && (
              <section className="dismissed-categories">
                <h4>Dismissed categories</h4>
                {data.decisions
                  .filter((item) => item.decision === 'dismiss')
                  .map((item) => (
                    <div className="category-dismissed" key={item.category_id}>
                      <span>{item.path.join(' / ')}</span>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => void decide('reset', item.category_id)}
                        aria-label={`Undo dismissal: ${item.path.join(' / ')}`}
                      >
                        Undo dismissal
                      </button>
                    </div>
                  ))}
              </section>
            )}
          </div>
        )
      )}
    </Modal>
  );
}
