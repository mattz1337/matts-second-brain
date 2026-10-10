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
  Check,
  X,
  Moon,
  Sun,
  LogOut,
} from 'lucide-react';
import { useAppearance } from './Appearance';
import { api, date, resetApiSession } from './api';
import { useResource } from './hooks';
import { SectionHeading, KnowledgeCard, Loading, Empty, LinkAction } from './components';
import type {
  Dashboard,
  GraphResult,
  ModelStatus,
  Knowledge,
  CategorySummary,
  CategorizationStatus,
} from '../shared/contracts';
import CategoryBrowser from './CategoryBrowser';
import CategoryEditor from './CategoryEditor';
import Graph from './Graph';
import Capture from './Capture';
import Detail from './Detail';
import Library from './Library';
import Sources, { SourceDetail } from './Sources';
import Review from './Review';
import Settings from './Settings';
import EntityDetail from './Entity';
import Login from './Login';
import { updateLocation, useUrlState } from './navigation';

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
  const appearance = useAppearance();
  const [view] = useUrlState<View>('view', 'overview', [
    'overview',
    'library',
    'graph',
    'sources',
    'review',
    'settings',
  ]);
  const [ready, setReady] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [passwordMode, setPasswordMode] = useState(false);
  const [fatal, setFatal] = useState('');
  const [revision, setRevision] = useState(0);
  const [capture, setCapture] = useState<'note' | 'source' | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [categoryItem, setCategoryItem] = useState<string | null>(null);
  const [categoryReturn, setCategoryReturn] = useState<{
    id: string;
    type: 'knowledge' | 'source';
  } | null>(null);
  const [query, setQuery] = useUrlState('q', '');
  const [headerQuery, setHeaderQuery] = useState(query);
  const [latestImport, setLatestImport] = useState<string>();
  const [focus, setFocus] = useState<string | undefined>();
  const [toast, setToast] = useState('');
  const [savedItem, setSavedItem] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [entity, setEntity] = useState<string | null>(null);
  useEffect(() => setHeaderQuery(query), [query]);
  useEffect(() => {
    let alive = true;
    api<{ authenticated: boolean; mode: 'local' | 'password' }>('/session')
      .then(async (session) => {
        if (!alive) return;
        setPasswordMode(session.mode === 'password');
        if (session.authenticated) setReady(true);
        else if (session.mode === 'password') setNeedsLogin(true);
        else {
          await api('/session', {});
          if (alive) setReady(true);
        }
      })
      .catch((e) => setFatal(e.message));
    return () => {
      alive = false;
    };
  }, []);
  function signedOut() {
    resetApiSession();
    setReady(false);
    setNeedsLogin(true);
    setCapture(null);
    setDetail(null);
    setSource(null);
    setCategoryItem(null);
    setCategoryReturn(null);
    setEntity(null);
    setToast('');
    setSavedItem(null);
    setMobile(false);
  }
  useEffect(() => {
    const expired = () => {
      if (passwordMode) signedOut();
    };
    window.addEventListener('orbit:unauthorized', expired);
    return () => window.removeEventListener('orbit:unauthorized', expired);
  }, [passwordMode]);
  async function logout() {
    try {
      await api('/session', undefined, 'DELETE');
      signedOut();
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not sign out.');
    }
  }
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
    const timer = setTimeout(() => setToast(''), savedItem ? 8000 : 4500);
    return () => clearTimeout(timer);
  }, [toast, savedItem]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (!ready) return;
      if (document.querySelector('[role="dialog"]')) return;
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
        !categoryItem &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)
      ) {
        e.preventDefault();
        setCapture('note');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [capture, detail, source, categoryItem, ready]);
  function navigate(next: View) {
    setMobile(false);
    updateLocation({ view: next }, true);
  }
  function changed() {
    setRevision((x) => x + 1);
  }
  function saved(item?: Knowledge, jobId?: string) {
    setCapture(null);
    changed();
    setSavedItem(item?.id || null);
    setToast(item ? 'Knowledge saved.' : 'Source queued. Follow its progress in Sources.');
    if (!item) {
      setLatestImport(jobId);
      navigate('sources');
    }
  }
  function search(e: FormEvent) {
    e.preventDefault();
    updateLocation(
      {
        view: 'library',
        q: headerQuery.trim(),
        library_topic: null,
        library_project: null,
        library_status: null,
        library_kind: null,
        library_temporal: null,
        library_asof: null,
        library_recorded: null,
        library_fresh: null,
      },
      true,
    );
    setMobile(false);
  }
  function organize(id: string, returnTo?: 'knowledge' | 'source') {
    setCategoryReturn(returnTo ? { id, type: returnTo } : null);
    setDetail(null);
    setSource(null);
    setCategoryItem(id);
  }
  function closeCategories() {
    setCategoryItem(null);
    if (categoryReturn?.type === 'source') setSource(categoryReturn.id);
    if (categoryReturn?.type === 'knowledge') setDetail(categoryReturn.id);
    setCategoryReturn(null);
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
  if (needsLogin)
    return (
      <Login
        onSuccess={() => {
          resetApiSession();
          setNeedsLogin(false);
          setReady(true);
          setFatal('');
        }}
      />
    );
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="navigation-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar glass-surface ${mobile ? 'mobile-open' : ''}`}>
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
          <span>Orbit</span>
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
              aria-label={n.label}
              aria-current={view === n.id ? 'page' : undefined}
              onClick={() => {
                if (n.id === 'graph') setFocus(undefined);
                navigate(n.id);
              }}
            >
              <n.icon size={18} />
              <span>
                {n.id === 'library'
                  ? 'Library'
                  : n.id === 'graph'
                    ? 'Graph'
                    : n.id === 'review'
                      ? 'Review'
                      : n.label}
              </span>
              {n.id === 'review' && !!d?.candidates && (
                <span className="nav-count">{d.candidates}</span>
              )}
            </button>
          ))}
        </nav>
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
        <header className="topbar glass-surface">
          <button
            className="mobile-menu icon-button"
            aria-label="Toggle navigation"
            aria-expanded={mobile}
            onClick={() => setMobile(!mobile)}
          >
            <PanelLeft size={19} />
          </button>
          <div className="topbar-location">
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
            className="appearance-toggle icon-button"
            aria-label={
              appearance.resolved === 'dark'
                ? 'Switch to light appearance'
                : 'Switch to dark appearance'
            }
            title={`Appearance: ${appearance.appearance}`}
            onClick={() =>
              appearance.setAppearance(appearance.resolved === 'dark' ? 'light' : 'dark')
            }
          >
            {appearance.resolved === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button
            className="button primary toolbar-capture"
            aria-label="New note"
            onClick={() => setCapture('note')}
          >
            <Plus size={16} />
            <span>New note</span>
          </button>
          {passwordMode && (
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </button>
          )}
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
                    <span className="eyebrow">Your workspace</span>
                    <span>{date(new Date().toISOString())}</span>
                  </div>
                  <div className="overview-hero">
                    <div>
                      <h1>Your knowledge, connected.</h1>
                      <p>Your notes, evidence, and ideas. Ready when you need them.</p>
                      <button className="button primary" onClick={() => setCapture('note')}>
                        <Plus size={16} />
                        Capture an idea
                      </button>
                      <button className="hero-link" onClick={() => setCapture('source')}>
                        Import a source
                        <ArrowUpRight size={15} />
                      </button>
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
                        <h2>Recently added</h2>
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
                          <h2>A world of connections.</h2>
                          <p>Explore notes, categories, and evidence.</p>
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
                          <button
                            className="text-button"
                            onClick={() =>
                              updateLocation({ view: 'review', review_tab: 'due' }, true)
                            }
                          >
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
                  onGraph={openGraph}
                  onCategorize={organize}
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
                  onCategorize={organize}
                />
              )}
              {view === 'sources' && (
                <Sources
                  revision={revision}
                  onImport={() => setCapture('source')}
                  onOpen={setSource}
                  onChanged={changed}
                  latestImport={latestImport}
                  onBrowseImported={() =>
                    updateLocation(
                      {
                        view: 'library',
                        q: null,
                        library_status: 'imported',
                        library_topic: null,
                        library_project: null,
                      },
                      true,
                    )
                  }
                  onReview={() => updateLocation({ view: 'review', review_tab: null }, true)}
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
          onCategorize={(id) => organize(id, 'knowledge')}
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
          onCategorize={(id) => organize(id, 'source')}
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
      {categoryItem && (
        <CategoryEditor id={categoryItem} onClose={closeCategories} onChanged={changed} />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          {savedItem && toast === 'Knowledge saved.' && (
            <button
              className="toast-action"
              onClick={() => {
                setDetail(savedItem);
                setToast('');
              }}
            >
              Open note
            </button>
          )}
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
  onCategorize,
}: {
  data: GraphResult | null;
  error: string;
  loading: boolean;
  focus?: string;
  onFocus: (id?: string) => void;
  onSelect: (id: string, type: string) => void;
  revision: number;
  dashboard: Dashboard | null;
  onCategorize: (id: string) => void;
}) {
  const [topic, setTopic] = useState('');
  const [candidates, setCandidates] = useState(false);
  const [project, setProject] = useState('');
  const [category, setCategory] = useState('');
  const [scanRevision, setScanRevision] = useState(0);
  const [scanError, setScanError] = useState('');
  const [queuing, setQueuing] = useState(false);
  const categoryStatus = useResource(
    () => api<CategorizationStatus>('/categories/status'),
    [scanRevision],
    2000,
  );
  const scan = categoryStatus.data?.job;
  const busy = queuing || scan?.status === 'queued' || scan?.status === 'running';
  const scanSignature = `${scan?.id}:${scan?.status}:${scan?.result.scanned}`;
  const categories = useResource(
    () => api<CategorySummary[]>(`/categories?include_candidates=${candidates}`),
    [revision, candidates, scanSignature],
    8000,
  );
  async function rescan() {
    setQueuing(true);
    setScanError('');
    try {
      await api('/categories/rescan', {});
      setScanRevision((value) => value + 1);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Could not start categorization.');
    } finally {
      setQueuing(false);
    }
  }
  const filtered = useResource(
    () =>
      api<GraphResult>('/graph', {
        focus_id: focus,
        topic,
        project,
        category_id: category || undefined,
        include_candidates: candidates,
        hops: 2,
        limit: 150,
      }),
    [topic, project, category, candidates, focus, revision, scanSignature],
    8000,
  );
  const visible = filtered.data || (!category ? data : null);
  const hasFilters = !!(topic || project || category || focus || candidates);
  function resetGraph() {
    setTopic('');
    setProject('');
    setCategory('');
    setCandidates(false);
    onFocus(undefined);
  }
  return (
    <>
      <SectionHeading
        eyebrow="FOLLOW A THREAD"
        title="Knowledge graph"
        description="Ideas, evidence, and context. A graph that grows with you."
      />
      <div className="category-status">
        <div>
          <strong>Automatic organization</strong>
          <span>
            {categoryStatus.data?.model_state === 'ready'
              ? `Local semantic model · ${categoryStatus.data.semantic_pending} pending · ${categoryStatus.data.semantic_errors} errors · ${categoryStatus.data.needs_review} need category review · ${categoryStatus.data.broad_assigned || 0} broader subjects`
              : categoryStatus.data?.model_state === 'error'
                ? `Semantic model failed: ${categoryStatus.data.model_error}`
                : categoryStatus.data?.model_state === 'disabled'
                  ? 'Semantic model disabled · metadata and keyword fallback'
                  : 'Preparing local semantic model…'}
          </span>
          <span role="status">
            {busy
              ? `Categorizing · ${scan?.progress || 0}% · ${scan?.result.scanned || 0} scanned`
              : scan?.status === 'failed'
                ? `Scan failed: ${scan.error}`
                : scan?.status === 'completed'
                  ? `Scan complete · ${scan.result.scanned} scanned · ${scan.result.categorized || 0} categorized · ${scan.result.uncategorized || 0} uncategorized`
                  : `${categoryStatus.data?.scanned || 0} of ${categoryStatus.data?.total || 0} items categorized`}
          </span>
        </div>
        <button className="button small" disabled={busy} onClick={() => void rescan()}>
          Rescan categories
        </button>
        {categories.data?.some((item) => item.label === 'Uncategorized') && (
          <button
            className="button small"
            onClick={() => {
              resetGraph();
              setCategory(categories.data!.find((item) => item.label === 'Uncategorized')!.id);
            }}
          >
            Review uncategorized
          </button>
        )}
      </div>
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
        {hasFilters && (
          <button className="text-button" onClick={resetGraph}>
            Reset view
          </button>
        )}
        <span>Drag to orbit · Select a light to follow a connection</span>
      </div>
      {(error || filtered.error || scanError || categories.error || categoryStatus.error) && (
        <div className="inline-error" role="alert">
          {error || filtered.error || scanError || categories.error || categoryStatus.error}
        </div>
      )}
      <div className="categorized-graph">
        <CategoryBrowser
          categories={categories.data || []}
          selected={category}
          onSelect={(id) => {
            setCategory(id);
            onFocus(undefined);
          }}
        />
        <div className="full-graph globe-view">
          {(loading || filtered.loading) && !visible ? (
            <Loading />
          ) : visible && visible.nodes.length === 0 ? (
            <Empty
              title={hasFilters ? 'No connections in this view' : 'Your graph starts with an idea'}
              description={
                hasFilters
                  ? 'Try a different category or notebook, or reset the view to see your collection.'
                  : 'Capture a note or import a source to start connecting your knowledge.'
              }
              action={
                hasFilters ? (
                  <button className="button small" onClick={resetGraph}>
                    Show all connections
                  </button>
                ) : undefined
              }
            />
          ) : (
            visible && (
              <Graph
                data={visible}
                revision={revision}
                onSelect={(id, type) => {
                  if (type === 'category') {
                    setCategory(id);
                    onFocus(undefined);
                  } else onSelect(id, type);
                }}
                onFocus={onFocus}
                onCategorize={onCategorize}
              />
            )
          )}
        </div>
      </div>
      <div className="graph-explanation">
        <GitBranch size={18} />
        <details>
          <summary>How to read your graph</summary>
          <p>
            Connections say <strong>why</strong> two things belong together. The globe is a logical
            space: related items cluster around category hubs. Dotted rings await review; amber
            lights need a fresh check. Select a node to explore its connections and evidence.
            Imported originals appear as source nodes; review is required to turn extracted claims
            into accepted knowledge. Large collections show a bounded selection—filter by notebook
            or open a source's connections to explore further. Categories form broader/narrower
            branches. Local semantic suggestions use note content, tags and notebook context.
            Confidence is a model estimate; ambiguous suggestions need your review. Open Organize
            categories on a note to confirm, dismiss or add categories. Your corrections survive
            future rescans. Hierarchical tags supply explicit branches. Imported notebooks remain
            source context rather than subject categories.
          </p>
        </details>
      </div>
    </>
  );
}
