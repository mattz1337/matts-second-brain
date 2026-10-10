import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
export type Appearance = 'system' | 'light' | 'dark';
const Context = createContext<{
  appearance: Appearance;
  resolved: 'light' | 'dark';
  setAppearance: (value: Appearance) => void;
  reduceTransparency: boolean;
  setReduceTransparency: (value: boolean) => void;
} | null>(null);
function saved(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    const value = saved('commonplace-appearance');
    return value === 'light' || value === 'dark' ? value : 'system';
  });
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [reduceTransparency, setReduceTransparency] = useState(
    () => saved('commonplace-reduce-transparency') === 'true',
  );
  const resolved = appearance === 'system' ? (dark ? 'dark' : 'light') : appearance;
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.transparency = reduceTransparency ? 'reduced' : 'normal';
    try {
      localStorage.setItem('commonplace-appearance', appearance);
      localStorage.setItem('commonplace-reduce-transparency', String(reduceTransparency));
    } catch {
      /* Appearance works when storage is unavailable. */
    }
  }, [appearance, resolved, reduceTransparency]);
  return (
    <Context.Provider
      value={{ appearance, resolved, setAppearance, reduceTransparency, setReduceTransparency }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAppearance() {
  const context = useContext(Context);
  if (!context) throw new Error('Appearance provider is missing.');
  return context;
}
