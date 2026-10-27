import { useEffect, useState, type FormEvent } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import { api } from './api';
import { useResource } from './hooks';
import type { PublicAssistantConfig } from '../shared/assistant';

export default function AssistantSettings() {
  const config = useResource(() => api<PublicAssistantConfig>('/assistant/config'), []);
  const [form, setForm] = useState({
    provider: 'builtin',
    model: 'google/gemini-3.1-flash-lite',
    daily_budget: 0.25,
    daily_calls: 60,
    garmin_url: '',
  });
  const [key, setKey] = useState(''),
    [token, setToken] = useState(''),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (config.data) {
      const { provider, model, daily_budget, daily_calls, garmin_url } = config.data;
      setForm({ provider, model, daily_budget, daily_calls, garmin_url });
    }
  }, [config.data]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api(
        '/assistant/config',
        { ...form, ...(key ? { api_key: key } : {}), ...(token ? { garmin_token: token } : {}) },
        'PUT',
      );
      setKey('');
      setToken('');
      setMessage(
        'Assistant settings saved. Cloud use stays under your control in each conversation.',
      );
      config.retry();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings-card assistant-settings">
      <div className="settings-card-heading">
        <div className="settings-icon">
          <Sparkles size={22} />
        </div>
        <div>
          <h2>Assistant & Garmin</h2>
          <p>A model that can work with your knowledge, with context you choose.</p>
        </div>
      </div>
      {config.error ? (
        <p role="alert" className="error">
          {config.error}
          <button onClick={config.retry}>Retry</button>
        </p>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <div className="assistant-settings-grid">
            <label>
              Answer mode
              <select
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
              >
                <option value="builtin">Local evidence search</option>
                <option value="openrouter">OpenRouter AI</option>
              </select>
            </label>
            <label>
              Model ID
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                required
              />
            </label>
            <label>
              OpenRouter API key
              <input
                type="password"
                autoComplete="new-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  config.data?.configured && config.data.provider === 'openrouter'
                    ? 'Configured · leave blank to keep'
                    : 'Paste your API key'
                }
              />
            </label>
            <label>
              Daily AI allowance (USD)
              <input
                type="number"
                min="0.01"
                max="20"
                step="0.01"
                value={form.daily_budget}
                onChange={(e) => setForm({ ...form, daily_budget: Number(e.target.value) })}
              />
            </label>
            <label>
              Daily model-call limit
              <input
                type="number"
                min="6"
                max="1000"
                value={form.daily_calls}
                onChange={(e) => setForm({ ...form, daily_calls: Number(e.target.value) })}
              />
            </label>
            <label>
              Garmin connector URL
              <input
                type="url"
                value={form.garmin_url}
                onChange={(e) => setForm({ ...form, garmin_url: e.target.value })}
                placeholder="http://127.0.0.1:4312"
              />
            </label>
            <label>
              Garmin connector token
              <input
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  config.data?.garmin_configured
                    ? 'Configured · leave blank to keep'
                    : 'Connector token'
                }
              />
            </label>
          </div>
          <p className="assistant-notice">
            Keys stay on the server. Cloud AI sends the context you select through OpenRouter to the
            chosen model provider. Eligible endpoints must support tools, disallow data collection,
            and meet zero-retention routing and price limits.
          </p>
          {config.data && (
            <p className="assistant-notice">
              Today: ${config.data.today_cost.toFixed(5)} / ${config.data.daily_budget.toFixed(2)} ·{' '}
              {config.data.today_calls} model calls. Includes reserved or conservatively estimated
              usage where provider accounting is unavailable.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          <button className="button primary" disabled={saving || config.loading}>
            {saving ? 'Saving…' : 'Save assistant settings'}
          </button>
        </form>
      )}
    </section>
  );
}
