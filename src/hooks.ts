import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useResource<T>(load: () => Promise<T>, deps: unknown[], poll = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let fetching = false;
    async function run() {
      if (fetching) return;
      fetching = true;
      try {
        const value = await load();
        if (alive) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load data.');
      } finally {
        fetching = false;
        if (alive) setLoading(false);
      }
    }
    setLoading(true);
    void run();
    const timer = poll ? setInterval(() => void run(), poll) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // Callers pass the complete set of values used by load.
  }, [...deps, attempt]);
  return { data, error, loading, retry: () => setAttempt((value) => value + 1) };
}
