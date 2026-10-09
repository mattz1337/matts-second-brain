import { useState } from 'react';
import {
  Plus,
  FileText,
  Globe,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  AlertCircle,
  RotateCcw,
  Upload,
  Trash2,
} from 'lucide-react';
import { api, date } from './api';
import { useResource } from './hooks';
import { SectionHeading, Loading, Empty, Modal, Badge } from './components';
import type { Source, ImportJob, SourceAttachment } from '../shared/contracts';

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
  const { data, error, loading } = useResource(
    () =>
      api<
        Source & {
          revisions: {
            id: string;
            content_hash: string;
            text: string;
            observed_at: string;
            parser: string;
          }[];
          passages: { id: string; revision_id: string; anchor: string; text: string }[];
          attachments: SourceAttachment[];
        }
      >(`/sources/${id}`),
    [id],
  );
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirm, setConfirm] = useState(false);
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
            <label>
              Source revision
              <select value={revision?.id || ''} onChange={(e) => setSelected(e.target.value)}>
                {data.revisions.map((r) => (
                  <option value={r.id} key={r.id}>
                    {date(r.observed_at)} · {r.content_hash.slice(0, 12)}
                  </option>
                ))}
              </select>
            </label>
            <div className="source-reading">
              {data.passages
                .filter((p) => p.revision_id === revision?.id)
                .map((p) => (
                  <article key={p.id}>
                    <small>{p.anchor}</small>
                    <p>{p.text}</p>
                  </article>
                ))}
            </div>
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
            {data.attachments?.some((attachment) => attachment.revision_id === revision?.id) && (
              <section className="source-attachments">
                <h3>Attachments</h3>
                {data.attachments
                  .filter((attachment) => attachment.revision_id === revision?.id)
                  .map((attachment) => (
                    <a key={attachment.id} href={`/api/attachments/${attachment.id}`}>
                      {attachment.mime.startsWith('image/') &&
                      attachment.size <= 10 * 1024 * 1024 ? (
                        <img
                          className="attachment-thumbnail"
                          src={`/api/attachments/${attachment.id}`}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <FileText size={15} />
                      )}
                      <span>{attachment.name}</span>
                      <small>{(attachment.size / 1024).toFixed(1)} KB</small>
                      <ArrowUpRight size={14} />
                    </a>
                  ))}
              </section>
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
}: {
  revision: number;
  onImport: () => void;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const sources = useResource(() => api<Source[]>('/sources'), [revision], 3000);
  const jobs = useResource(() => api<ImportJob[]>('/imports'), [revision], 3000);
  const [error, setError] = useState('');
  async function retry(id: string) {
    try {
      await api(`/imports/${id}/retry`, {});
      onChanged();
    } catch (e) {
      setError((e as Error).message);
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
            Import a document, paste a note, or save a public web page. Review the claims it
            contains.
          </p>
        </div>
        <button className="button" onClick={onImport}>
          Choose a source
          <ArrowUpRight size={15} />
        </button>
      </div>
      {(error || sources.error) && (
        <div className="inline-error" role="alert">
          {error || sources.error}
        </div>
      )}
      <div className="results-heading">
        <span>{sources.data?.length || 0} retained sources</span>
        <span>Immutable snapshots · Original evidence</span>
      </div>
      {sources.loading && !sources.data ? (
        <Loading />
      ) : sources.data?.length ? (
        <div className="source-list">
          {sources.data.map((s) => (
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
      {!!jobs.data?.length && (
        <section className="jobs-section">
          <div className="section-title">
            <h2>Import activity</h2>
            <span className="section-caption">Saved progress · Safe to retry</span>
          </div>
          {jobs.data.map((j) => (
            <article key={j.id} className="job-row">
              <div className={`job-icon ${j.status}`}>
                {j.status === 'completed' ? (
                  <CheckCircle2 size={19} />
                ) : j.status === 'failed' ? (
                  <AlertCircle size={19} />
                ) : (
                  <Loader2 className="spin" size={19} />
                )}
              </div>
              <div className="job-content">
                <strong>{j.title}</strong>
                <small>
                  {j.status === 'completed'
                    ? j.result.scanned !== undefined
                      ? `${j.result.scanned} items scanned · ${j.result.categorized || 0} categorized · ${j.result.uncategorized || 0} uncategorized`
                      : j.result.notes !== undefined
                        ? `${j.result.imported || 0} notes imported · ${j.result.duplicates || 0} unchanged · ${j.result.skipped || 0} skipped · ${j.result.attachments || 0} attachments · ${j.result.claims || 0} claim candidates`
                        : `${j.result.claims || 0} claims · ${j.result.duplicate ? 'Existing revision reused' : 'Ready for review'}`
                    : j.status === 'failed'
                      ? j.error
                      : `${j.stage} · ${j.progress}%`}
                </small>
                {j.warnings.map((w) => (
                  <p className="job-warning" key={w}>
                    {w}
                  </p>
                ))}
                {j.status === 'running' && (
                  <div className="progress-track">
                    <i style={{ width: `${j.progress}%` }} />
                  </div>
                )}
              </div>
              <Badge
                tone={j.status === 'completed' ? 'green' : j.status === 'failed' ? 'red' : 'amber'}
              >
                {j.status}
              </Badge>
              {j.status === 'failed' && (
                <button
                  className="icon-button"
                  aria-label={`Retry ${j.title}`}
                  onClick={() => void retry(j.id)}
                >
                  <RotateCcw size={16} />
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </>
  );
}
