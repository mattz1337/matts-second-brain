import { useState, type FormEvent } from 'react';
import { LockKeyhole, ArrowRight, Moon, Sun } from 'lucide-react';
import { api } from './api';
import { useAppearance } from './Appearance';
export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const appearance = useAppearance();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/session', { password });
      setPassword('');
      onSuccess();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <button
        className="icon-button login-appearance"
        aria-label={`Switch to ${appearance.resolved === 'dark' ? 'light' : 'dark'} appearance`}
        onClick={() => appearance.setAppearance(appearance.resolved === 'dark' ? 'light' : 'dark')}
      >
        {appearance.resolved === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </button>
      <section className="login-panel">
        <span className="login-icon glass-surface">
          <LockKeyhole size={27} />
        </span>
        <span className="eyebrow">Orbit</span>
        <h1>Welcome back.</h1>
        <p>Your knowledge, ready when you are.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="owner-password">Password</label>
          <input
            id="owner-password"
            autoFocus
            type="password"
            autoComplete="current-password"
            required
            maxLength={512}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary" disabled={busy || !password} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
            <ArrowRight size={16} />
          </button>
        </form>
        <small>Use the owner password configured for this workspace.</small>
      </section>
    </main>
  );
}
