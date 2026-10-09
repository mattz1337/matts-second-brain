import { useState } from 'react';
import {
  Search,
  SlidersHorizontal,
  ArrowRight,
  Sparkles,
  Plus,
  FileText,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api, pretty, date } from './api';
import { useResource } from './hooks';
import { SectionHeading, KnowledgeCard, Loading, Empty, Badge } from './components';
import {
  kinds,
  type SearchResult,
  type Detail,
  type Dashboard,
  type SourceBrowseResult,
} from '../shared/contracts';

interface Digest {
  summary: string;
  gap: boolean;
  claims: Detail[];
  passages: SearchResult['passages'];
  warnings: string[];
  mode: string;
}
export default function Library({
  query,
  setQuery,
  revision,
  onOpen,
  onCapture,
  onSource,
  dashboard,
}: {
  query: string;
  setQuery: (q: string) => void;
  revision: number;
  onOpen: (id: string) => void;
  onCapture: () => void;
  onSource: (id: string) => void;
  dashboard: Dashboard | null;
}) {
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('all');
  const [project, setProject] = useState('');
  const [sourceOffset, setSourceOffset] = useState(0);
  const [includeStale, setIncludeStale] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [temporal, setTemporal] = useState('current');
  const [asOf, setAsOf] = useState('');
  const [recordedAt, setRecordedAt] = useState('');
  const [offset, setOffset] = useState(0);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');
  const request = {
    query,
    topic,
    ...(kind ? { kind } : {}),
    lifecycle: ['all', 'imported'].includes(status) ? 'active' : status,
    project,
    include_stale: includeStale,
    include_candidates: status === 'candidate',
    temporal_mode: temporal,
    ...(asOf ? { as_of: new Date(asOf).toISOString() } : {}),
    ...(recordedAt ? { recorded_at: new Date(recordedAt).toISOString() } : {}),
    limit: 20,
    offset,
  };
  const { data, error, loading } = useResource(
    () => api<SearchResult>('/search', request),
    [
      query,
      topic,
      project,
      kind,
      status,
      includeStale,
      temporal,
      asOf,
      recordedAt,
      offset,
      revision,
    ],
  );
  const showSources = status === 'all' || status === 'imported';
  const sources = useResource(
    () =>
      showSources
        ? api<SourceBrowseResult>('/sources/search', {
            query,
            topic,
            project,
            origin: status === 'imported' ? 'note_station' : 'all',
            limit: 20,
            offset: sourceOffset,
          })
        : Promise.resolve({ items: [], total: 0 }),
    [showSources, status, query, topic, project, sourceOffset, revision],
  );
  async function ask() {
    setAsking(true);
    setAskError('');
    try {
      setDigest(await api<Digest>('/answer', { ...request, offset: 0 }));
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }
  return (
    <>
      <SectionHeading
        eyebrow="YOUR COLLECTION"
        title="Knowledge library"
        description="What you know, where it came from, and how it connects."
        action={
          <button className="button primary" onClick={onCapture}>
            <Plus size={16} />
            Add knowledge
          </button>
        }
      />
      <div className="library-search">
        <Search size={20} />
        <input
          aria-label="Search library"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
            setSourceOffset(0);
            setDigest(null);
          }}
          placeholder="Search an idea, a topic, or a question…"
        />
        <button
          className="button small"
          disabled={!query.trim() || asking}
          onClick={() => void ask()}
        >
          <Sparkles size={15} />
          {asking ? 'Finding evidence…' : 'Ask your brain'}
          <ArrowRight size={14} />
        </button>
      </div>
      <div className="filter-bar">
        <div className="segmented library-tabs">
          <button
            className={status === 'all' ? 'selected' : ''}
            onClick={() => {
              setStatus('all');
              setOffset(0);
              setSourceOffset(0);
            }}
          >
            All
          </button>
          <button
            className={status === 'active' ? 'selected' : ''}
            onClick={() => {
              setStatus('active');
              setOffset(0);
            }}
          >
            Accepted
          </button>
          <button
            className={status === 'imported' ? 'selected' : ''}
            onClick={() => {
              setStatus('imported');
              setSourceOffset(0);
            }}
          >
            Imported notes
          </button>
          <button
            className={status === 'candidate' ? 'selected' : ''}
            onClick={() => {
              setStatus('candidate');
              setOffset(0);
            }}
          >
            Candidates
          </button>
          <button
            className={status === 'archived' ? 'selected' : ''}
            onClick={() => {
              setStatus('archived');
              setOffset(0);
            }}
          >
            Archived
          </button>
        </div>
        <select
          aria-label="Filter by topic"
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            setOffset(0);
            setSourceOffset(0);
          }}
        >
          <option value="">All topics</option>
          {dashboard?.topics.map((t) => (
            <option key={t.name}>{t.name}</option>
          ))}
        </select>
        {!!dashboard?.projects?.length && (
          <select
            aria-label="Filter by notebook or project"
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setOffset(0);
              setSourceOffset(0);
            }}
          >
            <option value="">All notebooks & projects</option>
            {dashboard.projects.map((project) => (
              <option key={project.name}>{project.name}</option>
            ))}
          </select>
        )}
        <button
          className={`button small ${advanced ? 'active-filter' : ''}`}
          onClick={() => setAdvanced(!advanced)}
        >
          <SlidersHorizontal size={14} />
          Filters
        </button>
      </div>
      {advanced && (
        <div className="advanced-search">
          <label>
            Kind
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {pretty(k)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Time perspective
            <select value={temporal} onChange={(e) => setTemporal(e.target.value)}>
              <option value="current">Current knowledge</option>
              <option value="historical">Historical applicability</option>
              <option value="all">All applicability dates</option>
            </select>
          </label>
          {temporal === 'historical' && (
            <label>
              Applies on
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
          )}
          <label>
            Recorded by
            <input type="date" value={recordedAt} onChange={(e) => setRecordedAt(e.target.value)} />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={includeStale}
              onChange={(e) => setIncludeStale(e.target.checked)}
            />
            Include unverified or overdue knowledge
          </label>
        </div>
      )}
      {(error || askError || sources.error) && (
        <div className="inline-error" role="alert">
          {error || askError || sources.error}
        </div>
      )}
      {digest && (
        <div className="answer-panel">
          <div className="answer-heading">
            <Sparkles size={18} />
            <strong>Your evidence digest</strong>
            <Badge>{digest.gap ? 'Knowledge gap' : 'Source grounded'}</Badge>
          </div>
          <p>{digest.summary}</p>
          <small>
            This view collects cited knowledge. It does not generate or certify new facts.
          </small>
          {digest.claims.map((c, i) => (
            <button key={c.id} className="answer-claim" onClick={() => onOpen(c.id)}>
              <span>[{i + 1}]</span>
              <div>
                <strong>{c.statement}</strong>
                <small>
                  {c.evidence[0]?.source_title || pretty(c.evidence_status)} · {pretty(c.freshness)}
                </small>
              </div>
              <ArrowRight size={15} />
            </button>
          ))}
          {digest.gap && (
            <button className="button small" onClick={onCapture}>
              Fill this knowledge gap
              <Plus size={14} />
            </button>
          )}
        </div>
      )}
      <div className="results-heading">
        <span>
          {status === 'imported'
            ? `${sources.data?.total || 0} imported notes`
            : data
              ? `${data.total} ${data.total === 1 ? 'item' : 'items'}${status === 'all' ? ` · ${sources.data?.total || 0} sources` : ''}`
              : 'Your collection'}
          {query ? ' matching your search' : ''}
        </span>
        {query && (
          <span className="search-mode">
            {data?.mode === 'hybrid' ? 'Semantic + keyword + connections' : 'Keyword search'}
          </span>
        )}
      </div>
      {status !== 'imported' &&
        (loading && !data ? (
          <Loading />
        ) : data?.items.length ? (
          <div className="knowledge-list">
            {data.items.map((k) => (
              <KnowledgeCard key={k.id} item={k} onOpen={onOpen} />
            ))}
          </div>
        ) : !showSources || (!sources.loading && !sources.data?.total) ? (
          <Empty
            title={query ? 'No accepted knowledge found' : 'A little knowledge goes a long way'}
            description={
              query
                ? 'Try another phrase, include candidates, or import a source to start building this topic.'
                : 'Capture something you learned, or bring in a source worth keeping.'
            }
            action={
              <button className="button primary" onClick={onCapture}>
                Capture knowledge
                <Plus size={15} />
              </button>
            }
          />
        ) : null)}
      {status !== 'imported' && data && data.total > 20 && (
        <div className="pagination">
          <button
            className="button small"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            <ChevronLeft size={14} />
            Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 20, data.total)} of {data.total}
          </span>
          <button
            className="button small"
            disabled={offset + 20 >= data.total}
            onClick={() => setOffset(offset + 20)}
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      {showSources && (
        <section className="library-imports">
          <div className="section-title">
            <h2>{status === 'imported' ? 'Your imported notes' : 'Imported notes & sources'}</h2>
            <span className="section-caption">{sources.data?.total || 0} retained sources</span>
          </div>
          <p className="section-caption">
            These originals are part of your collection. Imported content is available before any
            claims are accepted or verified.
          </p>
          {sources.loading && !sources.data ? (
            <Loading />
          ) : sources.data?.items.length ? (
            <div className="library-source-list">
              {sources.data.items.map((source) => (
                <button
                  className="library-source-card"
                  key={source.id}
                  onClick={() => onSource(source.id)}
                >
                  <div className="library-source-heading">
                    <FileText size={18} />
                    <h3>{source.title}</h3>
                    <ArrowRight size={15} />
                  </div>
                  <div className="knowledge-meta">
                    <Badge>{source.origin === 'note_station' ? 'Imported note' : 'Source'}</Badge>
                    <span>
                      {source.metadata?.notebook || source.project || 'Retained original'}
                    </span>
                    <span>Original source · Unverified</span>
                  </div>
                  <p>{source.excerpt}</p>
                  <div className="library-source-footer">
                    <div>
                      {source.tags.map((tag) => (
                        <span className="tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                    <span>{date(source.metadata?.modified_at || source.created_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title={query ? 'No imported notes or sources found' : 'No imported notes yet'}
              description="Import your notebooks or save a source to add original material to your collection."
            />
          )}
          {!!sources.data && sources.data.total > 20 && (
            <div className="pagination">
              <button
                className="button small"
                disabled={!sourceOffset}
                onClick={() => setSourceOffset((value) => Math.max(0, value - 20))}
              >
                <ChevronLeft size={14} />
                Previous sources
              </button>
              <span>
                {sourceOffset + 1}–{Math.min(sourceOffset + 20, sources.data.total)} of{' '}
                {sources.data.total}
              </span>
              <button
                className="button small"
                disabled={sourceOffset + 20 >= sources.data.total}
                onClick={() => setSourceOffset((value) => value + 20)}
              >
                Next sources
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </section>
      )}
      {!!data?.passages.length && (
        <section className="source-matches">
          <h2>
            <FileText size={17} /> From your sources
          </h2>
          <p className="section-caption">
            Original passages remain searchable before their claims are accepted.
          </p>
          {data.passages.map((p) => (
            <button className="passage-result" key={p.id} onClick={() => onSource(p.source_id)}>
              <strong>
                {p.source_title}
                <ArrowRight size={14} />
              </strong>
              <p>{p.text}</p>
              <small>{p.anchor}</small>
            </button>
          ))}
        </section>
      )}
      {query &&
        data?.warnings.map((w) => (
          <p className="search-warning" key={w}>
            {w}
          </p>
        ))}
    </>
  );
}
