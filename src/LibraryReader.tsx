import { ArrowLeft, ArrowUpRight, Network, Tags } from 'lucide-react';
import type { Detail, Source } from '../shared/contracts';
import { api, date, pretty } from './api';
import { useResource } from './hooks';
import { Badge, Loading } from './components';
export type LibrarySelection = { id: string; type: 'knowledge' | 'source' };
type SourceSnapshot = Source & {
  revisions: { id: string; text: string; observed_at: string }[];
  passages: { id: string; anchor: string; text: string }[];
};
type Result = { type: 'knowledge'; item: Detail } | { type: 'source'; item: SourceSnapshot };
export default function LibraryReader({
  selected,
  revision,
  onOpen,
  onSource,
  onGraph,
  onCategorize,
  onBack,
}: {
  selected: LibrarySelection | null;
  revision: number;
  onOpen: (id: string) => void;
  onSource: (id: string) => void;
  onGraph: (id: string) => void;
  onCategorize: (id: string) => void;
  onBack: () => void;
}) {
  const resource = useResource<Result | null>(async () => {
    if (!selected) return null;
    if (selected.type === 'knowledge')
      return { type: 'knowledge', item: await api<Detail>(`/knowledge/${selected.id}`) };
    return { type: 'source', item: await api<SourceSnapshot>(`/sources/${selected.id}`) };
  }, [selected?.id, selected?.type, revision]);
  const data =
    resource.data?.item.id === selected?.id && resource.data?.type === selected?.type
      ? resource.data
      : null;
  return (
    <section className="library-reader" aria-label="Selected library item">
      <button className="text-button reader-back" onClick={onBack}>
        <ArrowLeft size={16} />
        Back to collection
      </button>
      {resource.error ? (
        <div className="inline-error" role="alert">
          {resource.error}
        </div>
      ) : !selected ? (
        <div className="reader-placeholder">
          <Tags size={30} />
          <h2>A little room to think.</h2>
          <p>Select a note or source to read it here.</p>
        </div>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="reader-overline">
            <span>{data.type === 'source' ? 'Original source' : pretty(data.item.kind)}</span>
            <Badge
              tone={
                data.type === 'knowledge' && data.item.lifecycle === 'active' ? 'green' : 'neutral'
              }
            >
              {data.type === 'knowledge' ? pretty(data.item.lifecycle) : 'Unverified original'}
            </Badge>
          </div>
          <h2>{data.item.title}</h2>
          <div className="reader-metadata">
            {data.item.project && <span>{data.item.project} · </span>}
            {date(
              data.type === 'knowledge'
                ? data.item.updated_at
                : data.item.metadata?.modified_at || data.item.created_at,
            )}
          </div>
          <div className="reader-actions">
            <button
              className="button small"
              onClick={() =>
                data.type === 'knowledge' ? onOpen(data.item.id) : onSource(data.item.id)
              }
            >
              {data.type === 'knowledge' ? 'Open full detail' : 'Open retained source'}
              <ArrowUpRight size={14} />
            </button>
            <button className="button small" onClick={() => onCategorize(data.item.id)}>
              <Tags size={14} />
              Organize categories
            </button>
            <button className="button small" onClick={() => onGraph(data.item.id)}>
              <Network size={14} />
              Show connections
            </button>
          </div>
          <div className="reader-tags">
            {data.item.tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
          <div className="reader-text">
            {data.type === 'knowledge'
              ? data.item.statement
              : data.item.revisions[0]?.text ||
                'No readable text was exported. The retained original is available in source detail.'}
          </div>
          <section className="reader-evidence">
            <h3>Evidence &amp; quality</h3>
            {data.type === 'knowledge' ? (
              <>
                <div className="reader-quality">
                  <Badge>{pretty(data.item.evidence_status)}</Badge>
                  <Badge tone={data.item.freshness === 'current' ? 'green' : 'amber'}>
                    {pretty(data.item.freshness)}
                  </Badge>
                  <span>Version {data.item.version}</span>
                </div>
                <p>
                  {data.item.verified_at
                    ? `Verified ${date(data.item.verified_at)}`
                    : 'Acceptance is separate from verification. This item has not been independently verified.'}
                </p>
                {data.item.evidence.slice(0, 3).map((evidence) => (
                  <button
                    className="reader-citation"
                    key={evidence.id}
                    onClick={() => onSource(evidence.source_id)}
                  >
                    <strong>
                      {evidence.source_title}
                      <ArrowUpRight size={13} />
                    </strong>
                    <span>
                      {evidence.anchor} · {pretty(evidence.relation)}
                    </span>
                    <p>{evidence.text}</p>
                  </button>
                ))}
              </>
            ) : (
              <>
                <p>
                  The original source and its revision history are retained. Importing it does not
                  verify its contents.
                </p>
                <span className="section-caption">
                  {data.item.revisions.length} revisions · {data.item.passages.length} passages ·{' '}
                  {data.item.claim_count} derived claims
                </span>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
