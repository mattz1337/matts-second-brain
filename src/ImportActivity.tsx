import { useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, RotateCcw } from 'lucide-react';
import { Badge } from './components';
import type { ImportJob } from '../shared/contracts';

export default function ImportActivity({
  jobs,
  latestImport,
  retrying,
  onRetry,
  onOpen,
  onBrowseImported,
  onReview,
}: {
  jobs: ImportJob[];
  latestImport?: string;
  retrying: string;
  onRetry: (id: string) => void;
  onOpen: (id: string) => void;
  onBrowseImported: () => void;
  onReview: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const attention = jobs.filter(
    (job) => ['queued', 'running', 'failed'].includes(job.status) || job.id === latestImport,
  );
  const recent = jobs.filter((job) => !attention.includes(job)).slice(0, 3);
  const visible = expanded ? jobs : [...attention, ...recent];
  if (!jobs.length) return null;
  return (
    <section className="jobs-section import-activity" aria-label="Import activity">
      <div className="section-title">
        <h2>Import activity</h2>
        <span className="section-caption">Progress and next steps</span>
      </div>
      {visible.map((job) => (
        <article
          key={job.id}
          className={`job-row ${job.id === latestImport ? 'latest-import' : ''}`}
        >
          <div className={`job-icon ${job.status}`}>
            {job.status === 'completed' ? (
              <CheckCircle2 size={19} />
            ) : job.status === 'failed' ? (
              <AlertCircle size={19} />
            ) : (
              <Loader2 className="spin" size={19} />
            )}
          </div>
          <div className="job-content">
            <strong>{job.title}</strong>
            <small>
              {job.status === 'completed'
                ? job.result.scanned !== undefined
                  ? `${job.result.scanned} items scanned · ${job.result.categorized || 0} categorized · ${job.result.uncategorized || 0} need a category`
                  : job.result.notes !== undefined
                    ? `${job.result.imported || 0} notes imported · ${job.result.duplicates || 0} unchanged · ${job.result.skipped || 0} skipped · ${job.result.attachments || 0} attachments`
                    : job.result.duplicate
                      ? 'Existing source revision reused'
                      : `Original saved · ${job.result.claims || 0} candidates for review`
                : job.status === 'failed'
                  ? job.error
                  : `${job.stage || 'Queued'} · ${job.progress}%`}
            </small>
            {job.status === 'completed' && job.result.notes !== undefined && (
              <small>
                Your original notes are available in the library. Category suggestions continue in
                the background.
              </small>
            )}
            {!!job.warnings.length && (
              <details className="job-warnings">
                <summary>
                  {job.warnings.length} import {job.warnings.length === 1 ? 'notice' : 'notices'}
                </summary>
                {job.warnings.map((w) => (
                  <p className="job-warning" key={w}>
                    {w}
                  </p>
                ))}
              </details>
            )}
            {['running', 'queued'].includes(job.status) && (
              <progress aria-label={`Progress for ${job.title}`} value={job.progress} max={100} />
            )}
            {job.status === 'completed' && (
              <div className="job-next-actions">
                {typeof job.result.source_id === 'string' && (
                  <button
                    className="text-button"
                    onClick={() => onOpen(job.result.source_id as string)}
                  >
                    Open source
                  </button>
                )}
                {job.result.notes !== undefined && (
                  <button className="text-button" onClick={onBrowseImported}>
                    Browse imported notes
                  </button>
                )}
                {Number(job.result.claims) > 0 && (
                  <button className="text-button" onClick={onReview}>
                    Review {job.result.claims} candidates
                  </button>
                )}
              </div>
            )}
          </div>
          <Badge
            tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'red' : 'amber'}
          >
            {job.status}
          </Badge>
          {job.status === 'failed' && (
            <button
              className="button small"
              disabled={retrying === job.id}
              aria-label={`Retry ${job.title}`}
              onClick={() => onRetry(job.id)}
            >
              <RotateCcw size={16} />
              {retrying === job.id ? 'Retrying…' : 'Retry'}
            </button>
          )}
        </article>
      ))}
      {jobs.length > visible.length && (
        <button className="text-button activity-toggle" onClick={() => setExpanded(true)}>
          Show all activity ({jobs.length})
        </button>
      )}
      {expanded && jobs.length > 3 && (
        <button className="text-button activity-toggle" onClick={() => setExpanded(false)}>
          Show recent activity
        </button>
      )}
    </section>
  );
}
