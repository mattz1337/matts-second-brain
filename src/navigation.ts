import { useEffect, useState } from 'react';

const navigationEvent = 'orbit:navigate';
export function updateLocation(values: Record<string, string | null>, push = false) {
  const url = new URL(window.location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === '') url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  if (url.href === window.location.href) return;
  window.history[push ? 'pushState' : 'replaceState']({}, '', url);
  window.dispatchEvent(new Event(navigationEvent));
}

/** URL state survives reloads, view changes and browser Back/Forward. */
export function useUrlState<T extends string = string>(
  name: string,
  fallback: string,
  allowed?: readonly string[],
) {
  const read = () => {
    const value = new URLSearchParams(window.location.search).get(name);
    return (value !== null && (!allowed || allowed.includes(value)) ? value : fallback) as T;
  };
  const [value, setValue] = useState<T>(read);
  const allowedKey = allowed?.join('|');
  useEffect(() => {
    const changed = () => setValue(read());
    changed();
    window.addEventListener('popstate', changed);
    window.addEventListener(navigationEvent, changed);
    return () => {
      window.removeEventListener('popstate', changed);
      window.removeEventListener(navigationEvent, changed);
    };
  }, [name, fallback, allowedKey]);
  return [
    value,
    (next: string) => updateLocation({ [name]: next === fallback ? null : next }),
  ] as const;
}
