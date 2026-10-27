import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  MessageCircle,
  Plus,
  Send,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api } from './api';
import { useResource } from './hooks';
import { Badge, Modal } from './components';
import DocumentContent from './DocumentContent';
import type {
  AssistantAction,
  AssistantCitation,
  ChatMessage,
  Conversation,
  GarminResult,
  PublicAssistantConfig,
} from '../shared/assistant';
import './assistant.css';

async function streamMessage(
  conversation: string,
  body: unknown,
  signal: AbortSignal,
  receive: (event: string, data: unknown) => void,
) {
  const response = await fetch(`/api/assistant/conversations/${conversation}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body)
    throw Error('The assistant could not connect. Reload or sign in again.');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffered = '',
    completed = false;
  const frame = (value: string) => {
    const type = value
      .split(/\r?\n/)
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const text = value
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!type || !text) return;
    const data = JSON.parse(text);
    if (type === 'error') throw Error(data.message || 'The response could not complete.');
    if (type === 'result') completed = true;
    receive(type, data);
  };
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    buffered += decoder.decode(part.value, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
      frame(buffered.slice(0, boundary.index));
      buffered = buffered.slice(boundary.index + boundary[0].length);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) frame(buffered);
  if (!completed) throw Error('The response was interrupted. Retry the question.');
}

function MetricChart({ result }: { result: GarminResult }) {
  const chart = result.chart;
  if (!chart?.points.length) return null;
  const points = chart.points.filter((p) => Number.isFinite(p.value));
  const stride = Math.max(1, Math.ceil(points.length / 80));
  const shown = points.filter((_, i) => i % stride === 0 || i === points.length - 1);
  const maximum = Math.max(1, ...points.map((p) => p.value));
  const start = Date.parse(points[0].date),
    end = Date.parse(points.at(-1)!.date);
  const bar = Math.max(1, Math.min(15, 520 / Math.max(1, shown.length) - 2));
  return (
    <figure className="assistant-chart">
      <figcaption>
        <strong>{chart.title}</strong>
        <span>{chart.unit}</span>
      </figcaption>
      <svg viewBox="0 0 600 176" role="img" aria-label={chart.title}>
        <line x1="40" y1="145" x2="580" y2="145" stroke="var(--border)" />
        <text x="5" y="24" fill="var(--muted)" fontSize="11">
          {maximum.toFixed(1)}
        </text>
        <text x="24" y="145" fill="var(--muted)" fontSize="11">
          0
        </text>
        {shown.map((point, i) => {
          const date = Date.parse(point.date),
            x =
              Number.isFinite(date) && end > start
                ? 45 + ((date - start) / (end - start)) * 520
                : 45 + i * (520 / Math.max(1, shown.length - 1));
          const h = Math.max(1, (point.value / maximum) * 115);
          return (
            <rect
              key={`${point.date}-${i}`}
              x={x}
              y={145 - h}
              width={bar}
              height={h}
              rx="2"
              fill="var(--accent)"
            >
              <title>
                {point.date}: {point.value} {chart.unit}
              </title>
            </rect>
          );
        })}
        <text x="40" y="169" fill="var(--muted)" fontSize="11">
          {points[0].date}
        </text>
        <text x="580" y="169" textAnchor="end" fill="var(--muted)" fontSize="11">
          {points.at(-1)!.date}
        </text>
      </svg>
      {points.length > shown.length && (
        <small>
          Showing {shown.length} of {points.length} recorded points. The source snapshot retains the
          complete series.
        </small>
      )}
      <small>{chart.note}</small>
    </figure>
  );
}

export default function Assistant({
  onOpen,
  onSource,
  onChanged,
  onSettings,
}: {
  onOpen: (id: string) => void;
  onSource: (id: string) => void;
  onChanged: () => void;
  onSettings: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const config = useResource(() => api<PublicAssistantConfig>('/assistant/config'), [revision]);
  const conversations = useResource(
    () => api<Conversation[]>('/assistant/conversations'),
    [revision],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const thread = useResource(
    async () => ({
      id: selected,
      messages: selected ? await api<ChatMessage[]>(`/assistant/conversations/${selected}`) : [],
    }),
    [selected, revision],
  );
  const [text, setText] = useState(''),
    [scope, setScope] = useState<'knowledge' | 'garmin' | 'both'>('knowledge');
  const [cloud, setCloud] = useState(false),
    [general, setGeneral] = useState(false);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [partial, setPartial] = useState('');
  const [error, setError] = useState(''),
    [actionBusy, setActionBusy] = useState<string | null>(null);
  const [citation, setCitation] = useState<AssistantCitation | null>(null);
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0);
  const end = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const messages = thread.data?.id === selected ? thread.data.messages : [];
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!selected && conversations.data?.length) setSelected(conversations.data[0].id);
  }, [conversations.data]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [messages.length, status]);
  function choose(id: string | null) {
    generation.current++;
    controller.current?.abort();
    setBusy(false);
    setSelected(id);
    setError('');
    setPartial('');
    setStatus('');
    setText('');
    composer.current?.focus();
  }
  async function create() {
    const item = await api<Conversation>('/assistant/conversations', {});
    setSelected(item.id);
    setRevision((v) => v + 1);
    return item.id;
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setError('');
    setBusy(true);
    setPartial('');
    setStatus('Preparing your question…');
    const current = ++generation.current,
      abort = new AbortController();
    controller.current = abort;
    const question = text.trim();
    try {
      const conversation = selected || (await create());
      setText('');
      setRevision((v) => v + 1);
      await streamMessage(
        conversation,
        { content: question, request_id: crypto.randomUUID(), scope, cloud, general },
        abort.signal,
        (type, data) => {
          if (generation.current !== current) return;
          if (type === 'status') setStatus(String(data));
          if (type === 'token') setPartial((v) => v + String(data));
          if (type === 'result') {
            setPartial('');
            setRevision((v) => v + 1);
          }
        },
      );
    } catch (e) {
      if (generation.current === current) {
        setError(
          abort.signal.aborted
            ? 'Response stopped. Your conversation is retained.'
            : (e as Error).message,
        );
        setText(question);
      }
    } finally {
      if (generation.current === current) {
        setBusy(false);
        setStatus('');
        setPartial('');
        setRevision((v) => v + 1);
        controller.current = null;
      }
    }
  }
  async function decide(action: AssistantAction, decision: 'apply' | 'dismiss') {
    setActionBusy(action.id);
    setError('');
    try {
      await api(`/assistant/actions/${action.id}`, { decision });
      setRevision((v) => v + 1);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionBusy(null);
    }
  }
  async function remove() {
    if (!selected) return;
    if (
      !window.confirm(
        'Delete this conversation and its saved chat snapshots? Saved knowledge stays in your library.',
      )
    )
      return;
    try {
      await api(`/assistant/conversations/${selected}`, undefined, 'DELETE');
      choose(null);
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="assistant-heading">
        <div>
          <span className="eyebrow">THINK WITH YOUR KNOWLEDGE</span>
          <h1>Ask Orbit</h1>
          <p>Follow a thought. Find the evidence. Turn useful answers into knowledge.</p>
        </div>
        <button className="button small" onClick={onSettings}>
          <Settings2 size={16} />
          Assistant settings
        </button>
      </div>
      <section className="assistant-workspace" aria-label="Orbit assistant">
        <aside className="assistant-threads" aria-label="Conversations">
          <button className="button primary" onClick={() => choose(null)} disabled={busy}>
            <Plus size={16} />
            New conversation
          </button>
          {conversations.error && (
            <p role="alert">
              Could not load conversations.<button onClick={conversations.retry}>Retry</button>
            </p>
          )}
          <div>
            {conversations.data?.map((item) => (
              <button
                key={item.id}
                className={selected === item.id ? 'selected' : ''}
                aria-pressed={selected === item.id}
                onClick={() => choose(item.id)}
                disabled={busy}
              >
                <MessageCircle size={15} />
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        </aside>
        <div className="assistant-thread">
          <header>
            <span>
              <MessageCircle size={17} />
              {selected
                ? conversations.data?.find((c) => c.id === selected)?.title || 'Conversation'
                : 'New conversation'}
            </span>
            {selected && (
              <button
                aria-label="Delete conversation"
                onClick={() => void remove()}
                disabled={busy}
              >
                <Trash2 size={16} />
              </button>
            )}
          </header>
          <div className="assistant-messages" aria-label="Conversation messages" aria-busy={busy}>
            {thread.error && (
              <p className="error" role="alert">
                {thread.error}
                <button onClick={thread.retry}>Try again</button>
              </p>
            )}
            {!messages.length && !busy && (
              <div className="assistant-welcome">
                <span>
                  <MessageCircle size={30} />
                </span>
                <h2>What would you like to explore?</h2>
                <p>
                  Ask about your saved notes, compare Garmin activity, or draft something worth
                  remembering.
                </p>
                <div>
                  {[
                    'What have I saved about learning?',
                    'Help me turn an idea into a useful note.',
                    'Find connections between my notes.',
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setText(prompt);
                        composer.current?.focus();
                      }}
                    >
                      {prompt}
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`assistant-message ${message.role}`}>
                <div className="assistant-message-label">
                  {message.role === 'user' ? 'You' : 'Orbit'}
                  {message.role === 'assistant' && (
                    <Badge>{message.payload.cloud ? 'AI answer' : 'Local evidence'}</Badge>
                  )}
                </div>
                <DocumentContent text={message.content} />
                {message.payload.citations?.length ? (
                  <div className="assistant-citations" aria-label="Sources read">
                    {message.payload.citations.map((ref) => (
                      <button key={ref.ref} onClick={() => setCitation(ref)}>
                        <BookOpen size={13} />
                        <strong>[{ref.ref}]</strong>
                        <span>{ref.title}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {message.payload.citations
                  ?.filter((ref) => ref.snapshot)
                  .map((ref) => (
                    <MetricChart key={ref.ref} result={ref.snapshot!} />
                  ))}
                {message.payload.actions?.map((action) => (
                  <section
                    className="assistant-action"
                    key={action.id}
                    aria-label="Proposed change"
                  >
                    <header>
                      <strong>
                        {action.kind === 'edit'
                          ? 'Proposed edit'
                          : action.kind === 'import'
                            ? 'Source import'
                            : 'Draft note'}
                      </strong>
                      <Badge>{action.status}</Badge>
                    </header>
                    <h3>{action.title}</h3>
                    {action.arguments.statement != null && (
                      <div className="assistant-action-content">
                        <DocumentContent text={String(action.arguments.statement)} />
                      </div>
                    )}
                    {action.kind === 'import' && <p>{String(action.arguments.url)}</p>}
                    {action.kind === 'edit' && (
                      <small>
                        Applies to version {String(action.arguments.expected_version)}. Evidence
                        verification is reassessed after an edit.
                      </small>
                    )}
                    {action.status === 'proposed' && (
                      <footer>
                        <button
                          className="button primary small"
                          disabled={actionBusy !== null}
                          onClick={() => void decide(action, 'apply')}
                        >
                          {action.kind === 'edit'
                            ? 'Apply edit'
                            : action.kind === 'import'
                              ? 'Queue import'
                              : 'Save note'}
                        </button>
                        <button
                          className="button small"
                          disabled={actionBusy !== null}
                          onClick={() => void decide(action, 'dismiss')}
                        >
                          Dismiss
                        </button>
                      </footer>
                    )}
                    {action.status === 'applied' && (
                      <p className="assistant-saved">
                        <Check size={14} />
                        Saved
                        {action.result?.kind === 'knowledge' && (
                          <button onClick={() => onOpen(action.result!.id)}>
                            Open note <ArrowUpRight size={13} />
                          </button>
                        )}
                      </p>
                    )}
                  </section>
                ))}
                {message.payload.notices?.map((notice, i) => (
                  <p className="assistant-notice" key={i}>
                    {notice}
                  </p>
                ))}
                {message.payload.tools?.length ? (
                  <details className="assistant-tool-trace">
                    <summary>Activity · {message.payload.tools.length} tool calls</summary>
                    {message.payload.tools.map((call, i) => (
                      <p key={i}>
                        {call.name.replaceAll('_', ' ')} · {call.status}
                      </p>
                    ))}
                  </details>
                ) : null}
                {!!message.payload.usage?.calls && (
                  <small className="assistant-cost">
                    {message.payload.usage.model} ·{' '}
                    {message.payload.usage.estimated ? 'Estimated ' : ''}$
                    {message.payload.usage.cost.toFixed(5)} · {message.payload.usage.calls} model
                    calls
                  </small>
                )}
              </article>
            ))}
            {busy && (
              <article className="assistant-message assistant provisional">
                <div className="assistant-message-label">Orbit · {status}</div>
                {partial ? (
                  <DocumentContent text={partial} />
                ) : (
                  <div className="assistant-thinking">
                    <i />
                    <i />
                    <i />
                  </div>
                )}
              </article>
            )}
            <div ref={end} />
          </div>
          <form className="assistant-composer" onSubmit={(event) => void send(event)}>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="assistant-context">
              <label>
                Context
                <select
                  aria-label="Assistant context"
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value as typeof scope);
                    setCloud(false);
                  }}
                  disabled={busy}
                >
                  <option value="knowledge">My knowledge</option>
                  <option value="garmin" disabled={!config.data?.garmin_configured}>
                    Garmin
                  </option>
                  <option value="both" disabled={!config.data?.garmin_configured}>
                    Knowledge + Garmin
                  </option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={cloud}
                  onChange={(event) => setCloud(event.target.checked)}
                  disabled={
                    busy || !config.data?.configured || config.data?.provider !== 'openrouter'
                  }
                />
                Use cloud AI
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={general}
                  onChange={(event) => setGeneral(event.target.checked)}
                  disabled={busy || !cloud}
                />
                Allow general background
              </label>
            </div>
            <div className="assistant-input">
              <textarea
                ref={composer}
                aria-label="Message Orbit"
                placeholder="Ask a question, follow up, or ask to save an idea…"
                value={text}
                maxLength={4000}
                rows={3}
                onChange={(event) => setText(event.target.value)}
                disabled={busy}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (text.trim() && !busy) event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {busy ? (
                <button
                  key="stop"
                  type="button"
                  className="button"
                  onClick={(event) => {
                    event.preventDefault();
                    controller.current?.abort();
                    if (selected)
                      void api(`/assistant/conversations/${selected}/cancel`, {}).catch(() => {});
                  }}
                >
                  <Square size={15} />
                  Stop
                </button>
              ) : (
                <button
                  key="send"
                  type="submit"
                  className="button primary"
                  aria-label="Send"
                  disabled={!text.trim()}
                >
                  <Send size={16} />
                  <span>Send</span>
                </button>
              )}
            </div>
            <small>
              {cloud
                ? scope === 'knowledge'
                  ? 'Selected note excerpts and this conversation context will be sent to the model provider.'
                  : 'Selected note excerpts and calculated Garmin summaries will be sent to the model provider.'
                : 'Local evidence mode. Enable cloud AI for conversational answers and drafts.'}
            </small>
            {config.data && !config.data.configured && (
              <button className="assistant-setup-link" type="button" onClick={onSettings}>
                Configure your model to start using AI
              </button>
            )}
          </form>
        </div>
      </section>
      {citation && (
        <Modal title={`Source [${citation.ref}]`} onClose={() => setCitation(null)}>
          <h2>{citation.title}</h2>
          <p className="assistant-notice">{citation.quality}</p>
          {citation.snapshot ? (
            <>
              <MetricChart result={citation.snapshot} />
              <details>
                <summary>Retained calculation snapshot</summary>
                <pre>{JSON.stringify(citation.snapshot, null, 2)}</pre>
              </details>
            </>
          ) : (
            <>
              <DocumentContent text={citation.excerpt || 'No excerpt retained.'} />
              <small>Retained revision: {citation.revision || 'unknown'}</small>
              <button
                className="button"
                onClick={() => {
                  const current = citation;
                  setCitation(null);
                  current.kind === 'knowledge' ? onOpen(current.id) : onSource(current.id);
                }}
              >
                Open full item <ArrowUpRight size={15} />
              </button>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
