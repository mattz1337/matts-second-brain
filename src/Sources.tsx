import { useState } from 'react';
import {
  Plus,
  FileText,
  Globe,
  ArrowUpRight,
  AlertCircle,
  Upload,
  Trash2,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api, date } from './api';
import { useResource } from './hooks';
import { SectionHeading, Loading, Empty, Modal, Badge } from './components';
import type { Source, ImportJob } from '../shared/contracts';
import ImportActivity from './ImportActivity';
import { useUrlState } from './navigation';
import SourceContent, { SourceAttachments, type SourceSnapshot } from './SourceContent';

export function SourceDetail({
  id,
  onClose,
  onChanged,
  onGraph,
  onCategorize,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onGraph?: (id: string) => void;
  onCategorize: (id: string) => void;
}) {
  const { data, error, loading } = useResource(() => api<SourceSnapshot>(`/sources/${id}`), [id]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [presentation, setPresentation] = useState<'read' | 'passages'>('read');
  const revision = data?.revisions.find((r) => r.id === selected) || data?.revisions[0];
  async function action(remove = false) {
    setBusy(true);
    try {
      await api(
        remove ? `/sources/${id}` : `/sources/${id}/retract`,
        remove ? {} : {},
        remove ? 'DELETE' : 'POST',
      );
      onChanged();
      onClose();
    } catch (e) {
      setActionError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Retained source" onClose={onClose} wide>
      {(error || actionError) && (
        <div className="inline-error" role="alert">
          {error || actionError}
        </div>
      )}
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <div className="source-detail">
            <div className="detail-badges">
              <Badge tone={data.status === 'active' ? 'green' : 'red'}>{data.status}</Badge>
              <Badge>{data.origin}</Badge>
            </div>
            <h2>{data.title}</h2>
            <p className="section-caption">
              A stored snapshot. Citations remain available when the original page changes.
            </p>
            {data.url && (
              <a className="source-url" href={data.url} target="_blank" rel="noreferrer">
                {data.url}
                <ArrowUpRight size={14} />
              </a>
            )}
            {data.metadata && (
              <div className="nsx-source-metadata">
                <strong>
                  Note Station · {data.metadata.stack ? `${data.metadata.stack} / ` : ''}
                  {data.metadata.notebook}
                </strong>
                <span>
                  Created {data.metadata.created_at ? date(data.metadata.created_at) : 'unknown'} ·
                  Modified {data.metadata.modified_at ? date(data.metadata.modified_at) : 'unknown'}
                </span>
                {data.metadata.original_tags.length > 0 && (
                  <span>Original tags: {data.metadata.original_tags.join(', ')}</span>
                )}
                {data.metadata.warnings.map((warning) => (
                  <p className="job-warning" key={warning}>
                    {warning}
                  </p>
                ))}
              </div>
            )}
            {data.revisions.length > 1 && (
              <label>
                Source revision
                <select value={revision?.id || ''} onChange={(e) => setSelected(e.target.value)}>
                  {data.revisions.map((r) => (
                    <option value={r.id} key={r.id}>
                      {date(r.observed_at)}
                      {r.id === data.revisions[0].id ? ' · Current snapshot' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="source-presentation" aria-label="Source presentation">
              <button
                aria-pressed={presentation === 'read'}
                onClick={() => setPresentation('read')}
              >
                Read
              </button>
              <button
                aria-pressed={presentation === 'passages'}
                onClick={() => setPresentation('passages')}
              >
                Citation passages
              </button>
            </div>
            {presentation === 'read' ? (
              <SourceContent source={data} revision={revision} />
            ) : (
              <div className="source-passages">
                {data.passages
                  .filter((p) => p.revision_id === revision?.id)
                  .map((p) => (
                    <article key={p.id}>
                      <small>{p.anchor}</small>
                      <p>{p.text}</p>
                    </article>
                  ))}
              </div>
            )}
            <details className="source-provenance">
              <summary>Source details &amp; original</summary>
              <p>
                Snapshot saved {date(revision?.observed_at || null)} ·{' '}
                {data.passages.filter((p) => p.revision_id === revision?.id).length} citation
                passages
              </p>
              <p className="citation-anchor">Content SHA-256: {revision?.content_hash}</p>
              {data.origin === 'note_station' && revision && (
                <a
                  className="text-button source-original"
                  href={`/api/sources/${data.id}/revisions/${revision.id}/original`}
                >
                  <FileText size={14} />
                  Download original note JSON
                </a>
              )}
            </details>
            {presentation === 'passages' && (
              <SourceAttachments
                attachments={data.attachments?.filter(
                  (attachment) => attachment.revision_id === revision?.id,
                )}
              />
            )}
            <div className="detail-bottom">
              <button className="button small" onClick={() => onCategorize(id)}>
                Organize categories
              </button>
              {onGraph && (
                <button className="button small" onClick={() => onGraph(id)}>
                  Show connections <ArrowUpRight size={14} />
                </button>
              )}
              <button
                className="text-button muted"
                disabled={busy || data.status === 'retracted'}
                onClick={() => void action()}
              >
                <AlertCircle size={14} />
                Retract source evidence
              </button>
              <button className="text-button danger-text" onClick={() => setConfirm(!confirm)}>
                <Trash2 size={14} />
                Forget source
              </button>
            </div>
            {confirm && (
              <div className="delete-confirm">
                <p>
                  Permanently remove this source, its snapshots, and extracted claims? Other notes
                  will lose evidence from this source.
                </p>
                <button
                  className="button danger small"
                  disabled={busy}
                  onClick={() => void action(true)}
                >
                  Forget source and derived claims
                </button>
              </div>
            )}
          </div>
        )
      )}
    </Modal>
  );
}
export default function Sources({
  revision,
  onImport,
  onOpen,
  onChanged,
  latestImport,
  onBrowseImported,
  onReview,
}: {
  revision: number;
  onImport: () => void;
  onOpen: (id: string) => void;
  onChanged: () => void;
  latestImport?: string;
  onBrowseImported: () => void;
  onReview: () => void;
}) {
  const sources = useResource(() => api<Source[]>('/sources'), [revision], 3000);
  const jobs = useResource(() => api<ImportJob[]>('/imports'), [revision], 3000);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState('');
  const [query, setQuery] = useUrlState('sources_q', '');
  const [status, setStatus] = useUrlState('sources_status', 'all', ['all', 'active', 'retracted']);
  const [page, setPage] = useState(0);
  const normalize = (value: string) =>
    value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  const filtered = (sources.data || []).filter(
    (source) =>
      (status === 'all' || source.status === status) &&
      normalize(
        [source.title, source.project, source.metadata?.stack, ...source.tags, source.url]
          .filter(Boolean)
          .join(' '),
      ).includes(normalize(query.trim())),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  const offset = currentPage * 25;
  async function retry(id: string) {
    setRetrying(id);
    setError('');
    try {
      await api(`/imports/${id}/retry`, {});
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying('');
    }
  }
  return (
    <>
      <SectionHeading
        eyebrow="THE FOUNDATION"
        title="Your sources"
        description="Keep the original. Make every piece of knowledge traceable."
        action={
          <button className="button primary" onClick={onImport}>
            <Plus size={16} />
            Import source
          </button>
        }
      />
      <div className="import-callout">
        <div className="import-symbol">
          <Upload size={22} />
        </div>
        <div>
          <h3>Bring your knowledge together.</h3>
          <p>
            Import a document, paste a note, or save a web page. Note Station archives keep your
            notebooks and original notes together.
          </p>
        </div>
        <button className="button" onClick={onImport}>
          Choose a source
          <ArrowUpRight size={15} />
        </button>
      </div>
      {(error || sources.error || jobs.error) && (
        <div className="inline-error" role="alert">
          {error || sources.error || jobs.error}
          {(sources.error || jobs.error) && (
            <button
              className="button small"
              onClick={() => {
                sources.retry();
                jobs.retry();
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
      <ImportActivity
        jobs={jobs.data || []}
        latestImport={latestImport}
        retrying={retrying}
        onRetry={(id) => void retry(id)}
        onOpen={onOpen}
        onBrowseImported={onBrowseImported}
        onReview={onReview}
      />
      <div className="source-toolbar">
        <div className="source-search">
          <Search size={18} />
          <input
            aria-label="Search sources"
            placeholder="Find a source, notebook, or tag…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
          {query && (
            <button
              className="text-button"
              onClick={() => {
                setQuery('');
                setPage(0);
              }}
              aria-label="Clear source search"
            >
              Clear
            </button>
          )}
        </div>
        <select
          aria-label="Source status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">All sources</option>
          <option value="active">Active sources</option>
          <option value="retracted">Retracted sources</option>
        </select>
      </div>
      <div className="results-heading">
        <span>
          {filtered.length} {query || status !== 'all' ? 'matching' : 'retained'} sources
        </span>
        <span>Immutable snapshots · Original evidence</span>
      </div>
      {sources.loading && !sources.data ? (
        <Loading />
      ) : filtered.length ? (
        <div className="source-list">
          {filtered.slice(offset, offset + 25).map((s) => (
            <button className="source-row" key={s.id} onClick={() => onOpen(s.id)}>
              <div className="source-icon">
                {s.origin === 'url' ? <Globe size={21} /> : <FileText size={21} />}
              </div>
              <div>
                <h3>{s.title}</h3>
                <p>
                  {s.url ||
                    `${s.origin === 'note_station' ? `Note Station · ${s.metadata?.notebook || s.project}` : s.origin === 'file' ? 'Uploaded document' : 'Retained text'} · Added ${date(s.created_at)}`}
                </p>
                <div className="knowledge-meta">
                  {s.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                  {s.status === 'retracted' && <Badge tone="red">Retracted</Badge>}
                </div>
              </div>
              <div className="source-count">
                <strong>{s.claim_count}</strong>
                <span>claims</span>
              </div>
              <div className="source-count">
                <strong>{s.revision_count}</strong>
                <span>revision{s.revision_count !== 1 ? 's' : ''}</span>
              </div>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </div>
      ) : query || status !== 'all' ? (
        <Empty
          title="No matching sources"
          description="Try another title or notebook, or clear your filters."
          action={
            <button
              className="button small"
              onClick={() => {
                setQuery('');
                setStatus('all');
                setPage(0);
              }}
            >
              Clear source filters
            </button>
          }
        />
      ) : (
        <Empty
          title="Start with a source you trust"
          description="Bring in a document or web page. The system keeps its original passages and proposes claims for you to review."
          action={
            <button className="button primary" onClick={onImport}>
              Import your first source
            </button>
          }
        />
      )}
      {filtered.length > 25 && (
        <div className="pagination">
          <button
            className="button small"
            aria-label="Previous source page"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={14} />
            Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 25, filtered.length)} of {filtered.length}
          </span>
          <button
            className="button small"
            aria-label="Next source page"
            disabled={offset + 25 >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </>
  );
}
