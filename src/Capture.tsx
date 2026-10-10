import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileText, Upload, Link2, PenLine, ArrowRight, ChevronDown, Check } from 'lucide-react';
import { Modal } from './components';
import { api, key, pretty } from './api';
import { kinds, type Detail, type Knowledge, type NsxPreview } from '../shared/contracts';

export default function Capture({
  onClose,
  onSaved,
  initialMode = 'note',
  existing,
}: {
  onClose: () => void;
  onSaved: (item?: Knowledge, jobId?: string) => void;
  initialMode?: 'note' | 'source';
  existing?: Detail;
}) {
  const [mode, setMode] = useState<'note' | 'source'>(initialMode);
  const [sourceMode, setSourceMode] = useState('text');
  const [title, setTitle] = useState(existing?.title || '');
  const [statement, setStatement] = useState(existing?.statement || '');
  const [kind, setKind] = useState(existing?.kind || 'personal_observation');
  const [tags, setTags] = useState(existing?.tags.join(', ') || '');
  const [project, setProject] = useState(existing?.project || '');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<NsxPreview | null>(null);
  const [notebooks, setNotebooks] = useState<string[]>([]);
  const [extractClaims, setExtractClaims] = useState(false);
  const pendingUpload = useRef<string | undefined>(undefined);
  const queued = useRef(false);
  const mounted = useRef(true);
  const isNsx = mode === 'source' && sourceMode === 'file' && /\.nsx$/i.test(file?.name || '');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pendingUpload.current && !queued.current)
        void api(`/uploads/${pendingUpload.current}`, {}, 'DELETE').catch(() => {});
    };
  }, []);
  const [advanced, setAdvanced] = useState(false);
  const [interval, setInterval] = useState(
    existing
      ? existing.review_interval_days === null
        ? ''
        : String(existing.review_interval_days)
      : initialMode === 'source'
        ? '90'
        : '180',
  );
  const [validFrom, setValidFrom] = useState(existing?.valid_from?.slice(0, 10) || '');
  const [validTo, setValidTo] = useState(existing?.valid_to?.slice(0, 10) || '');
  const [subject, setSubject] = useState(existing?.subject || '');
  const [predicate, setPredicate] = useState(existing?.predicate || '');
  const [object, setObject] = useState(existing?.object || '');
  const [context, setContext] = useState(existing?.context || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestKey] = useState(key);
  const [confirmClose, setConfirmClose] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const errorPanel = useRef<HTMLDivElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const snapshot = JSON.stringify({
    mode,
    sourceMode,
    title,
    statement,
    kind,
    tags,
    project,
    url,
    file: file?.name,
    interval,
    validFrom,
    validTo,
    subject,
    predicate,
    object,
    context,
  });
  const initialSnapshot = useRef(snapshot);
  const hasContent =
    !!existing ||
    !!file ||
    [
      title,
      statement,
      tags,
      project,
      url,
      subject,
      predicate,
      object,
      context,
      validFrom,
      validTo,
    ].some((value) => value.trim().length > 0);
  const dirty = hasContent && snapshot !== initialSnapshot.current;
  function requestClose() {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  }
  useEffect(() => {
    if (error) errorPanel.current?.focus();
  }, [error]);
  useEffect(() => {
    if (confirmClose) keepEditing.current?.focus();
  }, [confirmClose]);
  useEffect(() => {
    if (!dirty) return;
    const leaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, [dirty]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      setError('Give your note or source a title.');
      return;
    }
    if (validFrom && validTo && validTo < validFrom) {
      setError('The end date must be on or after the start date.');
      return;
    }
    setBusy(true);
    setConfirmClose(false);
    setError('');
    try {
      const common = {
        title: title.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        project,
        review_interval_days: interval ? Number(interval) : null,
      };
      if (mode === 'source' && !existing) {
        let upload_id: string | undefined;
        if (sourceMode === 'file') {
          if (!file) throw new Error('Choose a supported file.');
          if (pendingUpload.current) upload_id = pendingUpload.current;
          else {
            const data = new FormData();
            data.append('file', file);
            upload_id = (await api<{ id: string }>('/uploads', data)).id;
            pendingUpload.current = upload_id;
          }
          if (isNsx && !preview) {
            const result = await api<NsxPreview>(`/uploads/${upload_id}/preview`);
            if (!mounted.current) {
              void api(`/uploads/${upload_id}`, {}, 'DELETE').catch(() => {});
              return;
            }
            setPreview(result);
            setNotebooks(result.notebooks.map((notebook) => notebook.id));
            setBusy(false);
            return;
          }
        }
        const job = await api<{ id: string }>('/imports', {
          ...common,
          idempotency_key: requestKey,
          ...(sourceMode === 'text'
            ? { text: statement }
            : sourceMode === 'url'
              ? { url }
              : { upload_id }),
          ...(isNsx
            ? { note_station: { notebook_ids: notebooks, extract_claims: extractClaims } }
            : {}),
        });
        queued.current = true;
        onSaved(undefined, job.id);
      } else {
        const body = {
          ...common,
          statement,
          kind,
          subject,
          predicate,
          object,
          context,
          valid_from: validFrom
            ? validFrom === existing?.valid_from?.slice(0, 10)
              ? existing.valid_from
              : new Date(validFrom).toISOString()
            : null,
          valid_to: validTo
            ? validTo === existing?.valid_to?.slice(0, 10)
              ? existing.valid_to
              : new Date(validTo).toISOString()
            : null,
          ...(existing ? { expected_version: existing.version } : { idempotency_key: requestKey }),
        };
        const item = await api<Knowledge>(
          existing ? `/knowledge/${existing.id}` : '/knowledge',
          body,
          existing ? 'PATCH' : 'POST',
        );
        onSaved(item);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save knowledge.');
      setBusy(false);
    }
  }
  return (
    <Modal
      title={existing ? 'Edit knowledge' : 'Capture something worth keeping'}
      onClose={requestClose}
      closeDisabled={busy}
      initialFocus=".capture-form input"
      wide
    >
      <p className="modal-intro">Give it a home. Connect it as you learn more.</p>
      {error && (
        <div className="inline-error" ref={errorPanel} tabIndex={-1} role="alert">
          {error}
        </div>
      )}
      {confirmClose && (
        <div className="draft-confirm" aria-label="Unsaved changes">
          <strong>Keep your changes?</strong>
          <p>Your changes haven’t been saved. Continue editing, or discard this draft.</p>
          <div>
            <button
              ref={keepEditing}
              className="button small primary"
              onClick={() => setConfirmClose(false)}
            >
              Keep editing
            </button>
            <button className="button small" disabled={busy} onClick={onClose}>
              Discard changes
            </button>
          </div>
        </div>
      )}
      {!existing && (
        <div className="capture-tabs">
          <button
            disabled={busy}
            className={mode === 'note' ? 'active' : ''}
            onClick={() => setMode('note')}
          >
            <PenLine size={16} /> Write a note
          </button>
          <button
            disabled={busy}
            className={mode === 'source' ? 'active' : ''}
            onClick={() => {
              setMode('source');
              setInterval('90');
            }}
          >
            <FileText size={16} /> Import a source
          </button>
        </div>
      )}
      <form
        ref={form}
        onSubmit={submit}
        className="capture-form"
        aria-busy={busy}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            if (!busy) form.current?.requestSubmit();
          }
        }}
      >
        <fieldset className="capture-fields" disabled={busy}>
          <label>
            Title
            <input
              required
              maxLength={180}
              placeholder={mode === 'note' ? 'What is this about?' : 'A name for this source'}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          {mode === 'source' && !existing && (
            <div className="segmented full">
              <button
                type="button"
                className={sourceMode === 'text' ? 'selected' : ''}
                onClick={() => setSourceMode('text')}
              >
                <FileText size={14} />
                Paste text
              </button>
              <button
                type="button"
                className={sourceMode === 'file' ? 'selected' : ''}
                onClick={() => setSourceMode('file')}
              >
                <Upload size={14} />
                Upload file
              </button>
              <button
                type="button"
                className={sourceMode === 'url' ? 'selected' : ''}
                onClick={() => setSourceMode('url')}
              >
                <Link2 size={14} />
                Web page
              </button>
            </div>
          )}
          {mode === 'note' || sourceMode === 'text' || existing ? (
            <label>
              {mode === 'note' ? 'Your knowledge' : 'Source text'}
              <textarea
                aria-label={mode === 'note' ? 'Your knowledge' : 'Source text'}
                required
                minLength={3}
                rows={5}
                placeholder={
                  mode === 'note'
                    ? 'An idea, an observation, a decision, or something you learned…'
                    : 'Paste a document or article. Claims will enter your review queue.'
                }
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
              />
            </label>
          ) : sourceMode === 'url' ? (
            <label>
              Public URL
              <input
                type="url"
                required
                placeholder="https://example.com/article"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <small>Public pages only. A snapshot and source references are retained.</small>
            </label>
          ) : (
            <label className="file-picker">
              <Upload size={25} />
              <strong>{file ? file.name : 'Choose a source document'}</strong>
              <span>Documents up to 25 MB · Note Station (.nsx) up to 512 MB</span>
              <input
                aria-label="Source document"
                type="file"
                accept=".md,.markdown,.txt,.html,.htm,.pdf,.nsx"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  setPreview(null);
                  setNotebooks([]);
                  if (pendingUpload.current)
                    void api(`/uploads/${pendingUpload.current}`, {}, 'DELETE').catch(() => {});
                  pendingUpload.current = undefined;
                  const maxSize = /\.nsx$/i.test(f?.name || '') ? 512 : 25;
                  if (f && f.size > maxSize * 1024 * 1024) {
                    setFile(null);
                    setError(`This file is too large. Choose a file under ${maxSize} MB.`);
                    e.target.value = '';
                    return;
                  }
                  setError('');
                  setFile(f);
                  if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
                }}
              />
            </label>
          )}
          {isNsx && (
            <section className="nsx-preview" aria-label="Note Station import">
              <h3>Bring your Note Station notebooks with you.</h3>
              <p>
                Each note becomes a searchable source with its original dates, tags, notebook, and
                available attachments.
              </p>
              {preview ? (
                <>
                  <div className="nsx-summary">
                    <strong>{preview.notes} notes</strong>
                    <span>{preview.notebooks.length} notebooks</span>
                    <span>{preview.attachments} attachments</span>
                  </div>
                  <fieldset>
                    <legend>Notebooks to import</legend>
                    <div className="notebook-selection-actions">
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          setNotebooks(preview.notebooks.map((notebook) => notebook.id))
                        }
                      >
                        Select all
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setNotebooks([])}
                      >
                        Clear selection
                      </button>
                      <span>
                        {notebooks.length} selected ·{' '}
                        {preview.notebooks
                          .filter((notebook) => notebooks.includes(notebook.id))
                          .reduce((sum, notebook) => sum + notebook.notes, 0)}{' '}
                        notes
                      </span>
                    </div>
                    {!notebooks.length && (
                      <p className="section-caption">Select at least one notebook to import.</p>
                    )}
                    <div className="nsx-notebooks">
                      {preview.notebooks.map((notebook) => (
                        <label className="checkbox-label" key={notebook.id}>
                          <input
                            type="checkbox"
                            checked={notebooks.includes(notebook.id)}
                            onChange={(event) =>
                              setNotebooks((ids) =>
                                event.target.checked
                                  ? [...ids, notebook.id]
                                  : ids.filter((id) => id !== notebook.id),
                              )
                            }
                          />
                          <span>
                            {notebook.stack ? `${notebook.stack} / ` : ''}
                            {notebook.title} <small>({notebook.notes} notes)</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={extractClaims}
                      onChange={(event) => setExtractClaims(event.target.checked)}
                    />
                    Extract claim candidates for review
                  </label>
                  <small>
                    Leave this off to migrate your notes first. Imported source content is
                    searchable immediately; extraction never verifies a claim.
                  </small>
                  {preview.warnings.map((warning) => (
                    <p className="job-warning" key={warning}>
                      {warning}
                    </p>
                  ))}
                </>
              ) : (
                <small>
                  Preview the archive first, then choose the notebooks you want to import.
                </small>
              )}
            </section>
          )}
          <div className="form-grid">
            <label>
              Topics
              <input
                aria-label="Topics"
                placeholder="Learning, Making"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <small>Separate topics with commas.</small>
            </label>
            <label>
              Project <span className="optional">optional</span>
              <input
                aria-label="Project"
                placeholder="Give this some context"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            </label>
          </div>
          {mode === 'note' && (
            <label>
              Knowledge kind
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {pretty(k)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="text-button advanced-toggle"
            onClick={() => setAdvanced(!advanced)}
          >
            Time and structured context
            <ChevronDown size={15} />
          </button>
          {advanced && (
            <div className="advanced-fields">
              <div className="form-grid">
                <label>
                  Review every (days)
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    placeholder="No schedule"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                  />
                </label>
                {mode === 'note' && (
                  <label>
                    Applies from
                    <input
                      type="date"
                      value={validFrom}
                      onChange={(e) => setValidFrom(e.target.value)}
                    />
                  </label>
                )}
                {mode === 'note' && (
                  <label>
                    Applies until
                    <input
                      type="date"
                      value={validTo}
                      onChange={(e) => setValidTo(e.target.value)}
                    />
                  </label>
                )}
              </div>
              {mode === 'note' && (
                <>
                  <div className="form-grid">
                    <label>
                      Subject
                      <input
                        placeholder="e.g. Service X"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                      />
                    </label>
                    <label>
                      Predicate
                      <input
                        placeholder="e.g. supports"
                        value={predicate}
                        onChange={(e) => setPredicate(e.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    Object
                    <input
                      placeholder="e.g. Feature Y"
                      value={object}
                      onChange={(e) => setObject(e.target.value)}
                    />
                  </label>
                  <label>
                    Context
                    <input
                      placeholder="Version, jurisdiction, experiment setup…"
                      value={context}
                      onChange={(e) => setContext(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          )}
          <div className="modal-actions">
            <span className="form-hint">
              <Check size={14} />{' '}
              {mode === 'source'
                ? isNsx
                  ? 'Original notes are retained as sources, with no automatic verification.'
                  : 'Extracted claims are reviewed before acceptance.'
                : 'Personal notes are saved as self-reported knowledge.'}
            </span>
            <button
              className="button primary"
              disabled={busy || (isNsx && !!preview && !notebooks.length)}
            >
              {busy
                ? isNsx && !preview
                  ? 'Reading archive…'
                  : 'Saving…'
                : existing
                  ? 'Save changes'
                  : mode === 'source'
                    ? isNsx
                      ? preview
                        ? 'Import selected notebooks'
                        : 'Preview archive'
                      : 'Import source'
                    : 'Save knowledge'}
              <ArrowRight size={16} />
            </button>
          </div>
          <small className="save-shortcut">
            Ctrl / ⌘ + Enter to {isNsx && !preview ? 'preview' : 'save'}
          </small>
        </fieldset>
      </form>
    </Modal>
  );
}
