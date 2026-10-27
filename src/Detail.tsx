import { useEffect, useState } from 'react';
import {
  Check,
  FileText,
  Clock,
  Network,
  Archive,
  Trash2,
  PenLine,
  Plus,
  AlertTriangle,
  Link2,
  ExternalLink,
} from 'lucide-react';
import type { Detail as DetailType, Knowledge, Source } from '../shared/contracts';
import { Modal, Badge, Loading } from './components';
import { api, date, key, pretty } from './api';
import Capture from './Capture';
import DocumentContent from './DocumentContent';

export default function Detail({
  id,
  onClose,
  onChanged,
  onGraph,
  onOpenSource,
  onCategorize,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onGraph: (id: string) => void;
  onOpenSource: (id: string) => void;
  onCategorize: (id: string) => void;
}) {
  const [item, setItem] = useState<DetailType | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('evidence');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [reviewAction, setReviewAction] = useState<'accept' | 'reject' | 'verify' | null>(null);
  const [rationale, setRationale] = useState('');
  const [edit, setEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState('');
  const [passages, setPassages] = useState<{ id: string; text: string; anchor: string }[]>([]);
  const [passage, setPassage] = useState('');
  const [relation, setRelation] = useState('supports');
  const [evidenceRationale, setEvidenceRationale] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkItems, setLinkItems] = useState<Knowledge[]>([]);
  const [linkId, setLinkId] = useState('');
  const [linkType, setLinkType] = useState('related_to');
  useEffect(() => {
    let live = true;
    setError('');
    api<DetailType>(`/knowledge/${id}`)
      .then((x) => {
        if (live) setItem(x);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [id, revision]);
  async function perform(work: () => Promise<unknown>, close = false) {
    setBusy(true);
    setError('');
    try {
      await work();
      setReviewAction(null);
      setRationale('');
      setEvidenceOpen(false);
      setLinkOpen(false);
      setRevision((x) => x + 1);
      onChanged();
      if (close) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  }
  async function openEvidence() {
    setEvidenceOpen(!evidenceOpen);
    try {
      setSources(await api<Source[]>('/sources'));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function chooseSource(value: string) {
    setSelectedSource(value);
    setPassage('');
    try {
      const result = await api<{ passages: typeof passages }>(`/sources/${value}`);
      setPassages(result.passages);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function openLinks() {
    setLinkOpen(!linkOpen);
    try {
      const result = await api<{ items: Knowledge[] }>('/knowledge');
      setLinkItems(result.items.filter((x) => x.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (edit && item)
    return (
      <Capture
        existing={item}
        onClose={() => setEdit(false)}
        onSaved={() => {
          setEdit(false);
          setRevision((x) => x + 1);
          onChanged();
        }}
      />
    );
  return (
    <Modal title="Knowledge detail" onClose={onClose} wide>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {!item ? (
        <Loading />
      ) : (
        <div className="detail-content">
          <div className="detail-badges">
            <Badge tone={item.lifecycle === 'active' ? 'green' : 'amber'}>
              {pretty(item.lifecycle)}
            </Badge>
            <Badge>{pretty(item.kind)}</Badge>
            <span className="version-label">Version {item.version}</span>
          </div>
          <h2 className="detail-title">{item.title}</h2>
          <div className="detail-statement">
            <DocumentContent text={item.statement} />
          </div>
          {item.assistant_origin && (
            <details className="assistant-tool-trace">
              <summary>
                Saved from an assistant draft ·{' '}
                {item.assistant_origin.stale ? 'sources changed' : 'retained sources'}
              </summary>
              <p>
                Generated content was explicitly saved by you. Source references describe provenance
                and do not establish independent verification.
              </p>
              {item.assistant_origin.citations?.map((citation) => (
                <section className="assistant-action" key={citation.ref}>
                  <strong>
                    [{citation.ref}] {citation.title}
                  </strong>
                  <p>{citation.quality}</p>
                  {citation.excerpt && <DocumentContent text={citation.excerpt} />}{' '}
                  {citation.snapshot && (
                    <pre>{JSON.stringify(citation.snapshot.facts, null, 2)}</pre>
                  )}
                  {citation.kind === 'source' && (
                    <button className="button small" onClick={() => onOpenSource(citation.id)}>
                      Open retained source
                    </button>
                  )}
                </section>
              ))}
            </details>
          )}
          <div className="detail-topics">
            {item.tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
            {item.project && <span className="tag project-tag">{item.project}</span>}
          </div>
          {item.context && <p className="context-note">{item.context}</p>}
          <div className="quality-grid">
            <div>
              <span>Evidence</span>
              <strong>{pretty(item.evidence_status)}</strong>
              <small>
                {item.independent_sources} independent source
                {item.independent_sources !== 1 ? 's' : ''}
              </small>
            </div>
            <div>
              <span>Freshness</span>
              <strong
                className={['stale', 'review_due'].includes(item.freshness) ? 'warning-text' : ''}
              >
                {pretty(item.freshness)}
              </strong>
              <small>
                {item.verified_at ? `Verified ${date(item.verified_at)}` : 'Not yet verified'}
              </small>
            </div>
            <div>
              <span>Next review</span>
              <strong>{item.review_due_at ? date(item.review_due_at) : 'Not scheduled'}</strong>
              <small>
                {item.review_interval_days
                  ? `Every ${item.review_interval_days} days`
                  : 'Manual review'}
              </small>
            </div>
          </div>
          {(item.valid_from || item.valid_to) && (
            <p className="validity-note">
              <Clock size={14} /> Applies{' '}
              {item.valid_from ? `from ${date(item.valid_from)}` : 'from an unknown date'}{' '}
              {item.valid_to ? `until ${date(item.valid_to)}` : 'onward'}
            </p>
          )}
          {item.conflicts.length > 0 && (
            <div className="warning-box">
              <AlertTriangle size={18} />
              <div>
                <strong>Conflicting knowledge</strong>
                {item.conflicts.map((c) => (
                  <p key={c.id}>
                    {c.title} — {c.object || c.statement}
                  </p>
                ))}
                <small>Different values with overlapping context. Review both accounts.</small>
              </div>
            </div>
          )}
          <div className="detail-toolbar">
            <button className="button small" onClick={() => onCategorize(id)}>
              Organize categories
            </button>
            <button className="button small" onClick={() => setEdit(true)}>
              <PenLine size={14} />
              Edit
            </button>
            <button
              className="button small"
              onClick={() => {
                onClose();
                onGraph(id);
              }}
            >
              <Network size={14} />
              View connections
            </button>
            <button className="button small" onClick={() => void openLinks()}>
              <Link2 size={14} />
              Link knowledge
            </button>
          </div>
          {linkOpen && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void perform(async () => {
                  const other = await api<DetailType>(`/knowledge/${linkId}`);
                  return api('/links', {
                    from: id,
                    to: linkId,
                    type: linkType,
                    expected_version: other.version,
                  });
                });
              }}
            >
              <h4>Connect accepted knowledge</h4>
              <label>
                Other item
                <select required value={linkId} onChange={(e) => setLinkId(e.target.value)}>
                  <option value="">Choose an item</option>
                  {linkItems.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Relationship
                <select value={linkType} onChange={(e) => setLinkType(e.target.value)}>
                  <option value="related_to">Related to</option>
                  <option value="supersedes">This item supersedes the other item</option>
                </select>
              </label>
              <button className="button primary small" disabled={busy}>
                Save relationship
              </button>
            </form>
          )}
          <div className="detail-tabs">
            <button
              className={tab === 'evidence' ? 'active' : ''}
              onClick={() => setTab('evidence')}
            >
              <FileText size={15} />
              Evidence ({item.evidence.length})
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
              <Clock size={15} />
              History ({item.versions.length})
            </button>
          </div>
          {tab === 'evidence' ? (
            <div className="evidence-section">
              {item.evidence.length ? (
                item.evidence.map((e) => (
                  <article
                    key={e.id}
                    className={`evidence-card ${e.relation === 'challenges' ? 'challenge' : ''}`}
                  >
                    <div className="evidence-card-heading">
                      <strong>{e.source_title}</strong>
                      <Badge
                        tone={
                          e.source_status === 'retracted'
                            ? 'red'
                            : e.relation === 'supports'
                              ? 'green'
                              : 'amber'
                        }
                      >
                        {e.source_status === 'retracted' ? 'Retracted' : pretty(e.relation)}
                      </Badge>
                    </div>
                    <blockquote>{e.text}</blockquote>
                    <div className="citation-anchor">
                      {e.anchor} · revision {e.content_hash.slice(0, 8)}
                    </div>
                    <p>{e.rationale}</p>
                    <div className="evidence-links">
                      <button className="text-button" onClick={() => onOpenSource(e.source_id)}>
                        View retained source
                        <ExternalLink size={13} />
                      </button>
                      {e.source_url && (
                        <a href={e.source_url} target="_blank" rel="noreferrer">
                          Original page
                          <ExternalLink size={13} />
                        </a>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <div className="no-evidence">
                  {['personal_observation', 'preference'].includes(item.kind)
                    ? 'A personal observation is valid knowledge. It is labeled as self-reported rather than externally supported.'
                    : 'No supporting evidence yet. Attach a source passage to make the basis of this claim inspectable.'}
                </div>
              )}
              <button className="text-button" onClick={() => void openEvidence()}>
                <Plus size={15} />
                Attach evidence
              </button>
              {evidenceOpen && (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(() =>
                      api(`/knowledge/${id}/evidence`, {
                        passage_id: passage,
                        relation,
                        rationale: evidenceRationale,
                        expected_version: item.version,
                        idempotency_key: key(),
                      }),
                    );
                  }}
                >
                  <label>
                    Source
                    <select
                      required
                      value={selectedSource}
                      onChange={(e) => void chooseSource(e.target.value)}
                    >
                      <option value="">Choose a retained source</option>
                      {sources
                        .filter((s) => s.status === 'active')
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Passage
                    <select required value={passage} onChange={(e) => setPassage(e.target.value)}>
                      <option value="">Choose supporting or challenging text</option>
                      {passages.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.anchor}: {p.text.slice(0, 90)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {passage && (
                    <blockquote>{passages.find((p) => p.id === passage)?.text}</blockquote>
                  )}
                  <label>
                    Assessment
                    <select value={relation} onChange={(e) => setRelation(e.target.value)}>
                      <option value="supports">Supports this knowledge</option>
                      <option value="challenges">Challenges this knowledge</option>
                    </select>
                  </label>
                  <label>
                    Why is this evidence relevant?
                    <textarea
                      required
                      minLength={3}
                      rows={2}
                      value={evidenceRationale}
                      onChange={(e) => setEvidenceRationale(e.target.value)}
                    />
                  </label>
                  <button className="button primary small" disabled={busy}>
                    Attach evidence
                  </button>
                </form>
              )}
            </div>
          ) : (
            <div className="history-list">
              {item.versions.map((v) => (
                <article key={String(v.version)}>
                  <div className="history-dot" />
                  <div>
                    <strong>Version {String(v.version)}</strong>
                    <span>{date(String(v.recorded_at))}</span>
                    <p>{String((v.snapshot as Knowledge).statement)}</p>
                    <small>
                      {pretty((v.snapshot as Knowledge).lifecycle)} ·{' '}
                      {pretty((v.snapshot as Knowledge).evidence_status)}
                    </small>
                  </div>
                </article>
              ))}
              {item.reviews.length > 0 && <h4>Review decisions</h4>}
              {item.reviews.map((r) => (
                <div className="review-history" key={String(r.id)}>
                  <Badge>{pretty(String(r.decision))}</Badge>
                  <p>{String(r.rationale)}</p>
                  <small>
                    {String(r.actor)} · {date(String(r.created_at))}
                  </small>
                </div>
              ))}
            </div>
          )}
          {reviewAction ? (
            <form
              className="review-form"
              onSubmit={(e) => {
                e.preventDefault();
                void perform(() =>
                  api(`/knowledge/${id}/review`, {
                    expected_version: item.version,
                    decision: reviewAction,
                    rationale,
                  }),
                );
              }}
            >
              <h4>
                {reviewAction === 'verify'
                  ? 'What did you check?'
                  : reviewAction === 'accept'
                    ? 'Why keep this knowledge?'
                    : 'Why reject this candidate?'}
              </h4>
              <textarea
                aria-label="Review rationale"
                required
                minLength={3}
                rows={2}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder={
                  reviewAction === 'verify'
                    ? 'Record the evidence and context you checked.'
                    : 'Add a short review note.'
                }
              />
              <div className="button-group">
                <button
                  type="button"
                  className="button small"
                  onClick={() => setReviewAction(null)}
                >
                  Cancel
                </button>
                <button className="button primary small" disabled={busy}>
                  Confirm {reviewAction}
                </button>
              </div>
            </form>
          ) : (
            <div className="detail-actions">
              {item.lifecycle === 'candidate' ? (
                <>
                  <button className="button primary" onClick={() => setReviewAction('accept')}>
                    <Check size={16} />
                    Accept knowledge
                  </button>
                  <button className="button" onClick={() => setReviewAction('reject')}>
                    Reject
                  </button>
                </>
              ) : item.lifecycle === 'active' ? (
                <button
                  className="button primary"
                  onClick={() => setReviewAction('verify')}
                  disabled={
                    !item.independent_sources &&
                    !['personal_observation', 'preference'].includes(item.kind)
                  }
                  title="Verification requires supporting evidence or a personal observation."
                >
                  <Check size={16} />
                  Verify against evidence
                </button>
              ) : null}
              <span className="acceptance-note">
                Acceptance keeps it. Verification records a check.
              </span>
            </div>
          )}
          <div className="detail-bottom">
            <button
              className="text-button muted"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  api(`/knowledge/${id}/archive`, {
                    expected_version: item.version,
                    restore: item.lifecycle === 'archived',
                  }),
                )
              }
            >
              <Archive size={14} />
              {item.lifecycle === 'archived' ? 'Restore knowledge' : 'Archive'}
            </button>
            <button
              className="text-button danger-text"
              onClick={() => setConfirmDelete(!confirmDelete)}
            >
              <Trash2 size={14} />
              Forget this item
            </button>
          </div>
          {confirmDelete && (
            <div className="delete-confirm">
              <p>
                Permanently delete this item, its evidence links, history, and search vectors?
                Retained source documents stay available.
              </p>
              <div className="button-group">
                <button className="button small" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
                <button
                  className="button danger small"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () => api(`/knowledge/${id}`, { expected_version: item.version }, 'DELETE'),
                      true,
                    )
                  }
                >
                  Permanently delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
