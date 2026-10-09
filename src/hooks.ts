import { useEffect, useState } from 'react';

export function useResource<T>(load: () => Promise<T>, deps: unknown[], poll = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
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
  }, deps);
  return { data, error, loading };
}
