import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  LayoutDashboard,
  BookOpen,
  Network,
  Files,
  CheckCircle2,
  Settings as SettingsIcon,
  Plus,
  Search,
  ArrowUpRight,
  ArrowRight,
  Clock,
  ChevronDown,
  Command,
  PanelLeft,
  Lightbulb,
  GitBranch,
  FileText,
  Leaf,
  Check,
  X,
} from 'lucide-react';
import { api, date } from './api';
import { useResource } from './hooks';
import { SectionHeading, KnowledgeCard, Loading, Empty, LinkAction } from './components';
import type { Dashboard, GraphResult, ModelStatus, Knowledge } from '../shared/contracts';
import Graph from './Graph';
import Capture from './Capture';
import Detail from './Detail';
import Library from './Library';
import Sources, { SourceDetail } from './Sources';
import Review from './Review';
import Settings from './Settings';
import EntityDetail from './Entity';

type View = 'overview' | 'library' | 'graph' | 'sources' | 'review' | 'settings';
const navigation: { id: View; label: string; icon: typeof BookOpen }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'library', label: 'Knowledge library', icon: BookOpen },
  { id: 'graph', label: 'Knowledge graph', icon: Network },
  { id: 'sources', label: 'Sources', icon: Files },
  { id: 'review', label: 'Review queue', icon: CheckCircle2 },
];
function Logo() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M8 10L23 8M8 10L13 25M23 8L13 25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="10" r="4" fill="currentColor" />
      <circle cx="23" cy="8" r="4" fill="currentColor" />
      <circle cx="13" cy="25" r="4" fill="currentColor" />
    </svg>
  );
}
export default function App() {
  const initial = new URLSearchParams(window.location.search).get('view') as View;
  const [view, setView] = useState<View>(
    ['overview', 'library', 'graph', 'sources', 'review', 'settings'].includes(initial)
      ? initial
      : 'overview',
  );
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState('');
  const [revision, setRevision] = useState(0);
  const [capture, setCapture] = useState<'note' | 'source' | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [headerQuery, setHeaderQuery] = useState('');
  const [focus, setFocus] = useState<string | undefined>();
  const [toast, setToast] = useState('');
  const [mobile, setMobile] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [entity, setEntity] = useState<string | null>(null);
  useEffect(() => {
    api('/session', {})
      .then(() => setReady(true))
      .catch((e) => setFatal(e.message));
  }, []);
  const dashboard = useResource(
    () => (ready ? api<Dashboard>('/dashboard') : Promise.resolve(null)),
    [ready, revision],
    8000,
  );
  const models = useResource(
    () => (ready ? api<ModelStatus>('/models') : Promise.resolve(null)),
    [ready],
    5000,
  );
  const graph = useResource(
    () =>
      ready
        ? api<GraphResult>('/graph', {
            focus_id: focus,
            hops: 2,
            limit: view === 'overview' ? 60 : 150,
          })
        : Promise.resolve(null),
    [ready, revision, focus, view],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (
        e.key === 'n' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !capture &&
        !detail &&
        !source &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)
      ) {
        e.preventDefault();
        setCapture('note');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [capture, detail, source]);
  useEffect(() => {
    const listener = () => {
      const next = new URLSearchParams(window.location.search).get('view') as View;
      if (['overview', 'library', 'graph', 'sources', 'review', 'settings'].includes(next))
        setView(next);
    };
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  function navigate(next: View) {
    setView(next);
    setMobile(false);
    window.history.pushState({}, '', `?view=${next}`);
  }
  function changed() {
    setRevision((x) => x + 1);
  }
  function saved(item?: Knowledge) {
    setCapture(null);
    changed();
    setToast(item ? 'Knowledge saved.' : 'Source queued. Follow its progress in Sources.');
    if (!item) navigate('sources');
  }
  function search(e: FormEvent) {
    e.preventDefault();
    setQuery(headerQuery);
    navigate('library');
  }
  function openGraph(id?: string) {
    setFocus(id);
    navigate('graph');
  }
  function openNode(id: string, type: string) {
    if (['claim', 'note'].includes(type)) setDetail(id);
    else if (type === 'source') setSource(id);
    else if (type === 'entity') setEntity(id);
    else openGraph(id);
  }
  const d = dashboard.data;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
        <a
          href="?view=overview"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <span className="brand-mark">
            <Logo />
          </span>
          <span>
            commonplace<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">M</span>
          <div>
            <strong>Matt's second brain</strong>
            <span>Personal workspace</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <button className="capture-button" onClick={() => setCapture('note')}>
          <Plus size={17} />
          Capture knowledge<kbd>N</kbd>
        </button>
        <div className="nav-caption">YOUR WORKSPACE</div>
        <nav>
          {navigation.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${view === n.id ? 'active' : ''}`}
              onClick={() => {
                if (n.id === 'graph') setFocus(undefined);
                navigate(n.id);
              }}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.id === 'review' && !!d?.candidates && (
                <span className="nav-count">{d.candidates}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="sidebar-note-icon">
            <Leaf size={17} />
          </div>
          <strong>A little more connected.</strong>
          <p>Every idea you keep is a thread you can pick up later.</p>
          <div className="sidebar-note-footer">
            <span>{d?.active || 0} pieces of knowledge</span>
            <GitBranch size={14} />
          </div>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <SettingsIcon size={17} />
            <span>Connections & settings</span>
          </button>
          <div className="profile">
            <span className="profile-avatar">M</span>
            <div>
              <strong>Matt</strong>
              <span>
                <i />
                Private workspace
              </span>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-location">
            <button
              className="mobile-menu icon-button"
              aria-label="Toggle navigation"
              onClick={() => setMobile(!mobile)}
            >
              <PanelLeft size={19} />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <strong>
              {view === 'settings' ? 'Connections' : navigation.find((n) => n.id === view)?.label}
            </strong>
          </div>
          <form className="global-search" onSubmit={search}>
            <Search size={16} />
            <input
              ref={searchRef}
              aria-label="Search your knowledge"
              placeholder="Search your knowledge…"
              value={headerQuery}
              onChange={(e) => setHeaderQuery(e.target.value)}
            />
            <kbd>
              <Command size={10} />K
            </kbd>
          </form>
          <button
            className="topbar-avatar"
            aria-label="Open workspace settings"
            onClick={() => navigate('settings')}
          >
            M
          </button>
        </header>
        <main className={`main-content ${view === 'overview' ? 'overview' : ''}`}>
          {fatal ? (
            <div className="inline-error" role="alert">
              {fatal}
              <button className="button small" onClick={() => window.location.reload()}>
                Try again
              </button>
            </div>
          ) : !ready ? (
            <Loading />
          ) : (
            <>
              {dashboard.error && (
                <div className="inline-error" role="alert">
                  {dashboard.error}
                </div>
              )}
              {view === 'overview' && (
                <>
                  <div className="overview-greeting">
                    <span className="eyebrow">
                      <i /> ROOM TO THINK
                    </span>
                    <span>{date(new Date().toISOString())}</span>
                  </div>
                  <div className="overview-hero">
                    <div>
                      <h1>
                        A place for everything
                        <br />
                        you're <em>learning.</em>
                      </h1>
                      <p>
                        Keep the ideas that matter. Find the connections.
                        <br />
                        Build on what you know.
                      </p>
                      <button className="button primary" onClick={() => setCapture('note')}>
                        <Plus size={16} />
                        Capture an idea
                      </button>
                      <button className="hero-link" onClick={() => setCapture('source')}>
                        Import a source
                        <ArrowUpRight size={15} />
                      </button>
                    </div>
                    <div className="hero-aside">
                      <div className="hero-flower">
                        <Logo />
                      </div>
                      <p>
                        Collected with intention.
                        <br />
                        Connected over time.
                      </p>
                    </div>
                  </div>
                  <div className="stats-grid">
                    {[
                      {
                        label: 'Accepted knowledge',
                        value: d?.active || 0,
                        icon: BookOpen,
                        note: 'Accepted claims & personal notes',
                        view: 'library' as View,
                      },
                      {
                        label: 'Connections',
                        value: d?.connections || 0,
                        icon: GitBranch,
                        note: 'A growing web of context',
                        view: 'graph' as View,
                      },
                      {
                        label: 'Retained sources',
                        value: d?.sources || 0,
                        icon: Files,
                        note: 'The evidence behind your ideas',
                        view: 'sources' as View,
                      },
                      {
                        label: 'Ready to review',
                        value: d?.candidates || 0,
                        icon: CheckCircle2,
                        note: d?.due ? `${d.due} more due for a check` : 'Make new knowledge yours',
                        view: 'review' as View,
                      },
                    ].map((s) => (
                      <button className="stat-card" key={s.label} onClick={() => navigate(s.view)}>
                        <div>
                          <span>{s.label}</span>
                          <s.icon size={17} />
                        </div>
                        <strong>{s.value.toLocaleString()}</strong>
                        <p>{s.note}</p>
                      </button>
                    ))}
                  </div>
                  <div className="overview-columns">
                    <section className="recent-section">
                      <div className="section-title">
                        <h2>Recently connected</h2>
                        <LinkAction onClick={() => navigate('library')}>View library</LinkAction>
                      </div>
                      <p className="section-caption">Ideas you've kept, ready to build on.</p>
                      {dashboard.loading && !d ? (
                        <Loading />
                      ) : d?.recent.length ? (
                        <div className="recent-list">
                          {d.recent.slice(0, 5).map((k) => (
                            <KnowledgeCard key={k.id} item={k} onOpen={setDetail} compact />
                          ))}
                        </div>
                      ) : (
                        <Empty
                          title="Your first idea belongs here"
                          description="Capture something worth remembering."
                          action={
                            <button className="button small" onClick={() => setCapture('note')}>
                              Add knowledge
                            </button>
                          }
                        />
                      )}
                      <div className="sample-caption">
                        <Lightbulb size={14} />
                        <span>
                          A few starter notes show how it works. Make this space your own.
                        </span>
                      </div>
                    </section>
                    <div className="overview-right">
                      <section className="graph-preview globe-preview">
                        <div className="graph-preview-heading">
                          <div className="eyebrow">YOUR KNOWLEDGE, CONNECTED</div>
                          <h2>See the bigger picture.</h2>
                          <p>Follow a thread. Discover what fits together.</p>
                        </div>
                        {graph.data && <Graph data={graph.data} compact onSelect={openNode} />}
                        <button className="graph-preview-link" onClick={() => openGraph()}>
                          Explore your graph
                          <ArrowUpRight size={16} />
                        </button>
                      </section>
                      <section className="review-nudge">
                        <span className="review-nudge-icon">
                          <Clock size={20} />
                        </span>
                        <div>
                          <strong>
                            {d?.due
                              ? `${d.due} idea${d.due !== 1 ? 's' : ''} could use a fresh look.`
                              : 'Keep your knowledge alive.'}
                          </strong>
                          <p>A quick check keeps what you know useful.</p>
                          <button className="text-button" onClick={() => navigate('review')}>
                            Visit review queue
                            <ArrowRight size={14} />
                          </button>
                        </div>
                      </section>
                    </div>
                  </div>
                  <div className="overview-bottom">
                    <section className="topics-section">
                      <div className="section-title">
                        <h2>Threads you're following</h2>
                        <span className="section-caption">Your topics</span>
                      </div>
                      <div className="topic-cloud">
                        {d?.topics.length ? (
                          d.topics.map((t, i) => (
                            <button
                              key={t.name}
                              onClick={() => {
                                setQuery(t.name);
                                navigate('library');
                              }}
                            >
                              <span className={`topic-dot dot-${i % 4}`} />
                              {t.name}
                              <span>{t.count}</span>
                            </button>
                          ))
                        ) : (
                          <span className="section-caption">
                            Add topics to your first note to start connecting ideas.
                          </span>
                        )}
                      </div>
                    </section>
                    <section className="activity-section">
                      <div className="section-title">
                        <h2>Small steps, growing knowledge</h2>
                      </div>
                      {d?.activity.slice(0, 3).map((a) => (
                        <div className="activity-row" key={a.id}>
                          <span className="activity-marker" />
                          <p>
                            <strong>{a.title}</strong>
                            <span>
                              {a.action} · {date(a.created_at)}
                            </span>
                          </p>
                        </div>
                      ))}
                    </section>
                  </div>
                </>
              )}
              {view === 'library' && (
                <Library
                  query={query}
                  setQuery={setQuery}
                  revision={revision}
                  onOpen={setDetail}
                  onCapture={() => setCapture('note')}
                  onSource={setSource}
                  dashboard={d}
                />
              )}
              {view === 'graph' && (
                <GraphView
                  data={graph.data}
                  error={graph.error}
                  loading={graph.loading}
                  focus={focus}
                  onFocus={setFocus}
                  onSelect={openNode}
                  revision={revision}
                  dashboard={d}
                />
              )}
              {view === 'sources' && (
                <Sources
                  revision={revision}
                  onImport={() => setCapture('source')}
                  onOpen={setSource}
                  onChanged={changed}
                />
              )}
              {view === 'review' && (
                <Review revision={revision} onOpen={setDetail} onChanged={changed} />
              )}
              {view === 'settings' && <Settings onChanged={changed} />}
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>
            <Logo />A second brain, built one idea at a time.
          </span>
          <button onClick={() => navigate('settings')}>
            <i className={models.data?.state === 'ready' ? 'online' : ''} />
            {models.data?.state === 'ready'
              ? 'Local semantic search'
              : models.data?.state === 'loading'
                ? 'Preparing local search…'
                : 'Keyword search available'}
            <ArrowUpRight size={12} />
          </button>
        </footer>
      </div>
      {capture && (
        <Capture initialMode={capture} onClose={() => setCapture(null)} onSaved={saved} />
      )}
      {detail && (
        <Detail
          id={detail}
          onClose={() => setDetail(null)}
          onChanged={changed}
          onGraph={openGraph}
          onOpenSource={(id) => {
            setDetail(null);
            setSource(id);
          }}
        />
      )}
      {source && (
        <SourceDetail
          id={source}
          onClose={() => setSource(null)}
          onChanged={changed}
          onGraph={(id) => {
            setSource(null);
            openGraph(id);
          }}
        />
      )}
      {entity && (
        <EntityDetail
          id={entity}
          onClose={() => setEntity(null)}
          onChanged={changed}
          onGraph={openGraph}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function GraphView({
  data,
  error,
  loading,
  focus,
  onFocus,
  onSelect,
  revision,
  dashboard,
}: {
  data: GraphResult | null;
  error: string;
  loading: boolean;
  focus?: string;
  onFocus: (id?: string) => void;
  onSelect: (id: string, type: string) => void;
  revision: number;
  dashboard: Dashboard | null;
}) {
  const [topic, setTopic] = useState('');
  const [candidates, setCandidates] = useState(false);
  const [project, setProject] = useState('');
  const filtered = useResource(
    () =>
      api<GraphResult>('/graph', {
        focus_id: focus,
        topic,
        project,
        include_candidates: candidates,
        hops: 2,
        limit: 150,
      }),
    [topic, project, candidates, focus, revision],
  );
  const visible = topic || project || candidates ? filtered.data : data;
  return (
    <>
      <SectionHeading
        eyebrow="FOLLOW A THREAD"
        title="The shape of what you know."
        description="Ideas, evidence, and context. A graph that grows with you."
      />
      <div className="graph-filter-bar">
        <select aria-label="Graph topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
          <option value="">All topics</option>
          {dashboard?.topics.map((t) => (
            <option key={t.name}>{t.name}</option>
          ))}
        </select>
        {!!dashboard?.projects?.length && (
          <select
            aria-label="Graph notebook or project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">All notebooks & projects</option>
            {dashboard.projects.map((project) => (
              <option key={project.name}>{project.name}</option>
            ))}
          </select>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={candidates}
            onChange={(e) => setCandidates(e.target.checked)}
          />
          Show candidates
        </label>
        {focus && (
          <button className="button small" onClick={() => onFocus(undefined)}>
            Clear focus
            <X size={13} />
          </button>
        )}
        <span>Drag to orbit · Select a light to follow a connection</span>
      </div>
      {(error || filtered.error) && (
        <div className="inline-error" role="alert">
          {error || filtered.error}
        </div>
      )}
      <div className="full-graph globe-view">
        {loading && !visible ? (
          <Loading />
        ) : (
          visible && <Graph data={visible} onSelect={onSelect} onFocus={onFocus} />
        )}
      </div>
      <div className="graph-explanation">
        <GitBranch size={18} />
        <p>
          Connections say <strong>why</strong> two things belong together. The globe is a logical
          space: positions aren't geographic. Dotted rings await review; amber lights need a fresh
          check. Select a node to explore its connections and evidence. Imported originals appear as
          source nodes; review is required to turn extracted claims into accepted knowledge. Large
          collections show a bounded selection—filter by notebook or open a source's connections to
          explore further.
        </p>
      </div>
    </>
  );
}
