import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Globe2,
  List,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  X,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import type { GraphNode, GraphResult } from '../shared/contracts';
import { pretty } from './api';
import { createGlobeScene, globeColors, type GlobeScene } from './globe-scene';
import './globe.css';
import GraphNodePreview from './GraphNodePreview';

export default function Graph({
  data,
  compact = false,
  onSelect,
  onFocus,
  onCategorize,
  revision = 0,
}: {
  data: GraphResult;
  compact?: boolean;
  onSelect: (id: string, type: string) => void;
  onFocus?: (id: string) => void;
  onCategorize?: (id: string) => void;
  revision?: number;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const nativeFullscreen = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<GlobeScene | null>(null);
  const [list, setList] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [moving, setMoving] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const callbacks = useRef({ choose: (_node: GraphNode) => {} });
  useEffect(() => {
    const changed = () => {
      if (document.fullscreenElement === frame.current) {
        nativeFullscreen.current = true;
        setFullscreen(true);
      } else if (nativeFullscreen.current) {
        nativeFullscreen.current = false;
        setFullscreen(false);
        fullscreenButton.current?.focus();
      }
    };
    document.addEventListener('fullscreenchange', changed);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (document.fullscreenElement === frame.current)
        void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void leaveFullscreen();
      }
      if (event.key === 'Tab') {
        const elements = [
          ...(frame.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),select:not(:disabled),a[href]',
          ) || []),
        ].filter((element) => element.getClientRects().length > 0);
        const first = elements[0],
          last = elements.at(-1);
        if (
          !frame.current?.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener('keydown', key);
    };
  }, [fullscreen]);
  async function leaveFullscreen() {
    if (document.fullscreenElement === frame.current)
      await document.exitFullscreen().catch(() => {});
    setFullscreen(false);
    fullscreenButton.current?.focus();
  }
  async function toggleFullscreen() {
    if (fullscreen) return leaveFullscreen();
    setFullscreen(true);
    try {
      await frame.current?.requestFullscreen?.();
    } catch {
      /* Keep the viewport-filling mode when the browser blocks native fullscreen. */
    }
  }
  async function openSelected(id: string, type: string) {
    await leaveFullscreen();
    onSelect(id, type);
  }
  async function categorizeSelected(id: string) {
    await leaveFullscreen();
    onCategorize?.(id);
  }
  const movingRef = useRef(moving);
  movingRef.current = moving;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const node = data.nodes.find((item) => item.id === selected);
  const connections = useMemo(
    () =>
      data.edges
        .filter((edge) => edge.source === selected || edge.target === selected)
        .sort(
          (a, b) =>
            Number(b.type === 'category_parent' || b.type === 'categorized_as') -
            Number(a.type === 'category_parent' || a.type === 'categorized_as'),
        ),
    [data.edges, selected],
  );
  // Polling returns new object identities. Rebuild only when graph content changes.
  const signature = JSON.stringify({
    nodes: [...data.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...data.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
  const choose = (item: GraphNode) => {
    if (compact) {
      onSelect(item.id, item.type);
      return;
    }
    setSelected(item.id);
    setMoving(false);
    instance.current?.motion(false);
    instance.current?.select(item.id);
    setHover(null);
  };
  callbacks.current = { choose };
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReducedMotion(query.matches);
      if (query.matches) setMoving(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!container.current || list || failed) return;
    setReady(false);
    const onFailure = () => {
      setFailed(true);
      if (!compact) setList(true);
    };
    try {
      instance.current = createGlobeScene(container.current, data, {
        compact,
        reducedMotion,
        moving: movingRef.current,
        onPick: (item) => callbacks.current.choose(item),
        onHover: (item, x, y) => setHover(item && !compact ? { node: item, x, y } : null),
        onFailure,
        onReady: () => setReady(true),
      });
      if (selectedRef.current && data.nodes.some((item) => item.id === selectedRef.current))
        instance.current.select(selectedRef.current);
    } catch {
      onFailure();
    }
    return () => {
      instance.current?.dispose();
      instance.current = null;
    };
  }, [signature, compact, list, failed, reducedMotion]);
  useEffect(() => {
    instance.current?.motion(moving);
  }, [moving]);
  const reset = () => {
    setSelected(null);
    instance.current?.select(null);
    instance.current?.reset();
  };
  return (
    <div
      ref={frame}
      data-fullscreen={fullscreen}
      className={`graph-component knowledge-globe ${compact ? 'compact' : ''} ${list ? 'list-mode' : ''} ${fullscreen ? 'graph-fullscreen' : ''} ${!compact && node ? 'has-preview' : ''}`}
    >
      {!compact && (
        <div className="globe-toolbar">
          <div className="globe-switch" aria-label="Graph presentation">
            <button
              aria-pressed={!list}
              onClick={() => {
                setList(false);
                setFailed(false);
              }}
            >
              <Globe2 size={15} /> Globe
            </button>
            <button
              aria-pressed={list}
              onClick={() => {
                setList(true);
                setHover(null);
              }}
            >
              <List size={15} /> List
            </button>
          </div>
          {!list && (
            <div className="globe-actions">
              <button
                className="globe-motion"
                aria-label={moving ? 'Pause animation' : 'Resume animation'}
                aria-pressed={moving}
                disabled={reducedMotion}
                onClick={() => setMoving((value) => !value)}
              >
                {moving ? <Pause size={14} /> : <Play size={14} />}
                <span>{reducedMotion ? 'Reduced motion' : moving ? 'Orbiting' : 'Paused'}</span>
              </button>
              <span className="globe-divider" />
              <button aria-label="Zoom in" onClick={() => instance.current?.zoom(0.85)}>
                <Plus size={16} />
              </button>
              <button aria-label="Zoom out" onClick={() => instance.current?.zoom(1.18)}>
                <Minus size={16} />
              </button>
              <button aria-label="Reset globe" onClick={reset}>
                <RotateCcw size={15} />
              </button>
            </div>
          )}
          <button
            ref={fullscreenButton}
            className="globe-fullscreen-button"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            aria-pressed={fullscreen}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
          </button>
        </div>
      )}
      {list && (
        <div className="globe-list">
          {failed && (
            <p className="globe-fallback" role="status">
              3D rendering is unavailable in this browser. Your knowledge is available below.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th scope="col">Knowledge</th>
                <th scope="col">Type</th>
                <th scope="col">Connections</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      className="text-button"
                      aria-pressed={item.id === selected}
                      onClick={() => choose(item)}
                    >
                      <i style={{ background: globeColors[item.type] }} />
                      {item.label}
                    </button>
                  </td>
                  <td>{pretty(item.type)}</td>
                  <td>
                    {
                      data.edges.filter(
                        (edge) => edge.source === item.id || edge.target === item.id,
                      ).length
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div
        className="globe-stage"
        hidden={list}
        data-motion={moving ? 'running' : 'paused'}
        data-ready={ready}
      >
        <div
          ref={container}
          className="globe-renderer"
          role="img"
          aria-label="Interactive knowledge graph"
          aria-describedby={!compact ? 'globe-instructions' : undefined}
        />
        {!compact && (
          <>
            <div className="globe-scene-heading">
              <span className="globe-eyebrow">
                <i /> YOUR KNOWLEDGE UNIVERSE
              </span>
              <p>Everything is connected.</p>
              <span>Follow a signal. Find a new perspective.</span>
            </div>
            <label className="globe-finder">
              <Search size={14} />
              <select
                aria-label="Find a graph node"
                value={node?.id || ''}
                onChange={(event) => {
                  const item = data.nodes.find((item) => item.id === event.target.value);
                  if (item) choose(item);
                  else reset();
                }}
              >
                <option value="">Find a node…</option>
                {[...data.nodes]
                  .sort((a, b) => a.label.localeCompare(b.label))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {pretty(item.type)}
                    </option>
                  ))}
              </select>
            </label>
            <div className="globe-compass" aria-hidden="true">
              <span>N</span>
              <i />
              <span>S</span>
            </div>
            {!node && (
              <div className="globe-caption">
                <Globe2 size={18} />
                <div>
                  <strong>A world built from what you know.</strong>
                  <span>Each light is an idea. Each arc is a relationship.</span>
                </div>
              </div>
            )}
            <div className="globe-instructions" id="globe-instructions">
              <span>Drag to rotate</span>
              <i /> <span>Scroll to zoom</span>
              <i />
              <span>Select a light to explore</span>
            </div>
            <span role="status" className="sr-only">
              {node
                ? `Selected ${node.label}. ${connections.length} connections.`
                : 'Knowledge globe. Use Find a graph node or List to explore with a keyboard.'}
            </span>
          </>
        )}
        {hover && (
          <div
            className="globe-tooltip"
            style={{
              left: Math.max(
                10,
                Math.min(hover.x + 14, (container.current?.clientWidth || 400) - 225),
              ),
              top: Math.max(
                10,
                Math.min(hover.y + 14, (container.current?.clientHeight || 400) - 80),
              ),
            }}
          >
            <span>{pretty(hover.node.type)}</span>
            <strong>{hover.node.label}</strong>
          </div>
        )}
        {failed && compact && (
          <p className="globe-fallback">Explore your knowledge and its connections.</p>
        )}
        {!data.nodes.length && (
          <div className="globe-empty">
            Your universe starts with one idea.
            <span>Add or accept knowledge to make your first connection.</span>
          </div>
        )}
      </div>
      {!compact && node && (
        <aside className="graph-reading-panel" aria-label="Selected graph node">
          <div className="node-preview-heading">
            <div>
              <span className="globe-selection-type">
                {pretty(node.type)}
                {node.lifecycle === 'candidate' ? ' · Candidate' : ''}
              </span>
              <h3>{node.label}</h3>
            </div>
            <button
              className="node-preview-close"
              aria-label="Clear node selection"
              onClick={reset}
            >
              <X size={18} />
            </button>
          </div>
          <div className="node-preview-body">
            {['claim', 'note', 'source'].includes(node.type) && (
              <GraphNodePreview key={node.id} node={node} revision={revision} />
            )}
            <details
              className="node-connections"
              open={!['claim', 'note', 'source'].includes(node.type)}
            >
              <summary>
                {connections.length} {connections.length === 1 ? 'connection' : 'connections'} in
                this view
              </summary>
              <div className="globe-connection-chips">
                {connections.slice(0, 8).map((edge) => {
                  const target = data.nodes.find(
                    (item) => item.id === (edge.source === node.id ? edge.target : edge.source),
                  );
                  return (
                    target && (
                      <button
                        key={edge.id}
                        title={edge.properties?.rationale}
                        onClick={() => choose(target)}
                      >
                        {pretty(edge.type)} <span>{target.label}</span>
                      </button>
                    )
                  );
                })}
              </div>
              {connections
                .filter((edge) => edge.source === node.id && edge.type === 'categorized_as')
                .slice(0, 3)
                .map((edge) => (
                  <p className="category-reason" key={edge.id}>
                    {data.nodes.find((item) => item.id === edge.target)?.label}:{' '}
                    {edge.properties?.rationale}
                  </p>
                ))}
            </details>
          </div>
          <div className="node-preview-actions">
            <button
              className="button small primary"
              onClick={() => void openSelected(node.id, node.type)}
            >
              {node.type === 'category'
                ? 'Explore category'
                : node.type === 'source'
                  ? 'Open source'
                  : node.type === 'entity'
                    ? 'Open entity'
                    : 'Open knowledge'}
              <ArrowUpRight size={14} />
            </button>
            {onFocus && (
              <button className="button small" onClick={() => onFocus(node.id)}>
                Focus connections
              </button>
            )}
            {onCategorize && ['claim', 'note', 'source'].includes(node.type) && (
              <button className="button small" onClick={() => void categorizeSelected(node.id)}>
                Organize categories
              </button>
            )}
          </div>
        </aside>
      )}
      {!compact && (
        <div className="globe-footer">
          <div className="globe-legend">
            {Object.entries(globeColors).map(([name, color]) => (
              <span key={name}>
                <i style={{ background: color }} />
                {pretty(name)}
              </span>
            ))}
          </div>
          <span>
            {data.nodes.length} nodes · {data.edges.length} connections
            {data.truncated ? ` · Showing ${data.nodes.length} of ${data.total_nodes}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}
