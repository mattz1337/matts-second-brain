import { useState } from 'react';
import {
  Plug,
  Copy,
  Check,
  Download,
  Shield,
  Database,
  Eye,
  EyeOff,
  RefreshCw,
  FileUp,
} from 'lucide-react';
import { api, pretty } from './api';
import { useResource } from './hooks';
import { SectionHeading, Badge, Loading } from './components';
import type { ModelStatus } from '../shared/contracts';

interface Integrations {
  endpoint: string;
  assistant_token: string;
  reader_token: string;
  tools: { name: string; description: string; scope: string }[];
  profile: string;
}
export default function Settings({ onChanged }: { onChanged: () => void }) {
  const integrations = useResource(() => api<Integrations>('/integrations'), []);
  const models = useResource(() => api<ModelStatus>('/models'), [], 5000);
  const [show, setShow] = useState(false);
  const [scope, setScope] = useState('reader');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [restoreMessage, setRestoreMessage] = useState('');
  const token =
    scope === 'reader' ? integrations.data?.reader_token : integrations.data?.assistant_token;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        commonplace: {
          url: integrations.data?.endpoint,
          headers: { Authorization: `Bearer ${show ? token : 'YOUR_ACCESS_TOKEN'}` },
        },
      },
    },
    null,
    2,
  );
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setError('Clipboard is unavailable. Select and copy the text manually.');
    }
  }
  async function restore(file: File) {
    setError('');
    try {
      const isBundle = /\.zip$/i.test(file.name);
      const payload = isBundle ? new FormData() : JSON.parse(await file.text());
      if (isBundle) payload.append('file', file);
      const result = await api<{ restored: number; sources: number }>(
        isBundle ? '/restore/bundle' : '/restore',
        payload,
      );
      setRestoreMessage(
        `Restored ${result.restored} items and ${result.sources} sources with retained attachments. Search vectors are being rebuilt.`,
      );
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <SectionHeading
        eyebrow="MAKE IT YOURS"
        title="Connections & settings"
        description="Use your knowledge from other tools. Keep your data in your hands."
      />
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-icon">
            <Plug size={22} />
          </div>
          <div>
            <h2>Connect through MCP</h2>
            <p>Search your knowledge and contribute from an assistant or another app.</p>
          </div>
          <Badge tone="green">Local access</Badge>
        </div>
        {integrations.loading && !integrations.data ? (
          <Loading />
        ) : (
          integrations.data && (
            <>
              <label>
                Server endpoint
                <div className="copy-field">
                  <input readOnly value={integrations.data.endpoint} />
                  <button
                    className="icon-button"
                    aria-label="Copy MCP endpoint"
                    onClick={() => void copy(integrations.data!.endpoint, 'endpoint')}
                  >
                    {copied === 'endpoint' ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              </label>
              <label>
                Access level
                <select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="reader">Read only — search and inspect knowledge</option>
                  <option value="assistant">Read and contribute — propose notes and imports</option>
                </select>
              </label>
              <label>
                Access token
                <div className="copy-field">
                  <input type={show ? 'text' : 'password'} readOnly value={token || ''} />
                  <button
                    className="icon-button"
                    aria-label={show ? 'Hide token' : 'Show token'}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Copy access token"
                    onClick={() => void copy(token || '', 'token')}
                  >
                    {copied === 'token' ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              </label>
              <p className="security-note">
                <Shield size={15} /> Contributions enter review. These tokens cannot verify claims
                or delete data.
              </p>
              <details className="config-details">
                <summary>Example client configuration</summary>
                <pre>{snippet}</pre>
                <button
                  className="button small"
                  onClick={() =>
                    void copy(
                      JSON.stringify(
                        {
                          mcpServers: {
                            commonplace: {
                              url: integrations.data!.endpoint,
                              headers: { Authorization: `Bearer ${token}` },
                            },
                          },
                        },
                        null,
                        2,
                      ),
                      'config',
                    )
                  }
                >
                  {copied === 'config' ? <Check size={14} /> : <Copy size={14} />}Copy configuration
                </button>
                <small>
                  Client formats vary. A stdio bridge is also available with{' '}
                  <code>npm run mcp</code> while the app is running.
                </small>
              </details>
              <div className="tool-list">
                <h3>Available tools</h3>
                {integrations.data.tools.map((t) => (
                  <div key={t.name}>
                    <code>{t.name}</code>
                    <span>{t.description}</span>
                    <Badge>{t.scope.replace('brain:', '')}</Badge>
                  </div>
                ))}
              </div>
            </>
          )
        )}
      </section>
      <section className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-icon">
            <Database size={22} />
          </div>
          <div>
            <h2>Search & local inference</h2>
            <p>Your source text stays on this machine.</p>
          </div>
          <Badge tone={models.data?.state === 'ready' ? 'green' : 'amber'}>
            {pretty(models.data?.state || 'Loading')}
          </Badge>
        </div>
        <dl className="settings-facts">
          <div>
            <dt>Embedding model</dt>
            <dd>{models.data?.model || 'Loading…'}</dd>
          </div>
          <div>
            <dt>Indexed passages and claims</dt>
            <dd>{models.data?.indexed || 0}</dd>
          </div>
          <div>
            <dt>Waiting for indexing</dt>
            <dd>{models.data?.pending || 0}</dd>
          </div>
          <div>
            <dt>Claim extraction</dt>
            <dd>Exact source sentences; optional local LLM</dd>
          </div>
        </dl>
        {models.data?.error && (
          <div className="inline-error">
            {models.data.error}
            <button
              className="button small"
              onClick={() => void api('/models/retry', {}).catch((e) => setError(e.message))}
            >
              <RefreshCw size={14} />
              Retry loading
            </button>
          </div>
        )}
        <p className="section-caption">
          Search combines full-text matches, local vectors, and explicit connections. Keyword search
          remains available while indexing.
        </p>
      </section>
      <section className="settings-card">
        <div className="settings-card-heading">
          <div className="settings-icon">
            <Shield size={22} />
          </div>
          <div>
            <h2>Your data, your knowledge</h2>
            <p>Private local storage. Portable sources, claims, and history.</p>
          </div>
        </div>
        <div className="data-actions">
          <div>
            <h3>Export your second brain</h3>
            <p>
              Download a portable ZIP with claims, notes, evidence, source snapshots, graph edges,
              versions, and attachments.
            </p>
          </div>
          <a href="/api/export/bundle" className="button">
            <Download size={16} />
            Export backup
          </a>
        </div>
        <div className="data-actions">
          <div>
            <h3>Restore an export</h3>
            <p>
              Restore into an empty workspace. Start with a new data directory and sample notes
              disabled.
            </p>
          </div>
          <label className="button file-button">
            <FileUp size={16} />
            Restore backup
            <input
              type="file"
              accept=".json,.zip"
              aria-label="Restore export"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void restore(f);
              }}
            />
          </label>
        </div>
        {restoreMessage && <p role="status">{restoreMessage}</p>}
        <p className="local-note">
          This spike runs on loopback only. Remote publishing and OAuth authorization are not
          configured. Export files contain private knowledge; store them accordingly.
        </p>
      </section>
    </>
  );
}
