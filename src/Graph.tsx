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
} from 'lucide-react';
import type { GraphNode, GraphResult } from '../shared/contracts';
import { pretty } from './api';
import { createGlobeScene, globeColors, type GlobeScene } from './globe-scene';
import './globe.css';

export default function Graph({
  data,
  compact = false,
  onSelect,
  onFocus,
}: {
  data: GraphResult;
  compact?: boolean;
  onSelect: (id: string, type: string) => void;
  onFocus?: (id: string) => void;
}) {
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
  const movingRef = useRef(moving);
  movingRef.current = moving;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const node = data.nodes.find((item) => item.id === selected);
  const connections = useMemo(
    () => data.edges.filter((edge) => edge.source === selected || edge.target === selected),
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
      className={`graph-component knowledge-globe ${compact ? 'compact' : ''} ${list ? 'list-mode' : ''}`}
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
                    <button className="text-button" onClick={() => onSelect(item.id, item.type)}>
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
            {node ? (
              <div className="globe-selection" key={node.id}>
                <button className="globe-close" aria-label="Clear node selection" onClick={reset}>
                  <X size={15} />
                </button>
                <div className="globe-selection-type">
                  <i style={{ background: globeColors[node.type] }} />
                  {pretty(node.type)}
                  {node.lifecycle === 'candidate' && ' · Candidate'}
                  {node.freshness &&
                    !['current', 'unknown'].includes(node.freshness) &&
                    ` · ${pretty(node.freshness)}`}
                </div>
                <h3>{node.label}</h3>
                <p>
                  {connections.length} {connections.length === 1 ? 'connection' : 'connections'} in
                  this view
                </p>
                <div className="globe-connection-chips">
                  {connections.slice(0, 3).map((edge) => {
                    const target = data.nodes.find(
                      (item) => item.id === (edge.source === node.id ? edge.target : edge.source),
                    );
                    return (
                      target && (
                        <button
                          key={edge.id}
                          title={`${pretty(edge.type)}: ${target.label}`}
                          onClick={() => choose(target)}
                        >
                          {pretty(edge.type)} <span>{target.label}</span>
                        </button>
                      )
                    );
                  })}
                </div>
                <div className="globe-selection-actions">
                  <button onClick={() => onSelect(node.id, node.type)}>
                    Open knowledge <ArrowUpRight size={14} />
                  </button>
                  {onFocus && <button onClick={() => onFocus(node.id)}>Focus connections</button>}
                </div>
              </div>
            ) : (
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
