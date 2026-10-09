import type { CategorySummary } from '../shared/contracts';
import type { ReactNode } from 'react';

export default function CategoryBrowser({
  categories,
  selected,
  onSelect,
}: {
  categories: CategorySummary[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const branch = (parent: string | null, visited: Set<string> = new Set()): ReactNode => (
    <ul>
      {categories
        .filter((category) => category.parent_id === parent)
        .map((category) => {
          if (visited.has(category.id)) return null;
          const children = categories.some((child) => child.parent_id === category.id);
          const button = (
            <button
              className={selected === category.id ? 'is-selected' : ''}
              onClick={() => onSelect(category.id)}
              aria-pressed={selected === category.id}
            >
              <span>{category.label}</span>
              <small>{category.count}</small>
            </button>
          );
          return (
            <li key={category.id}>
              {children ? (
                <details open>
                  <summary>{button}</summary>
                  {branch(category.id, new Set([...visited, category.id]))}
                </details>
              ) : (
                button
              )}
            </li>
          );
        })}
    </ul>
  );
  return (
    <nav className="category-browser" aria-label="Knowledge categories">
      <h2>Categories</h2>
      <p>Choose a branch to explore its notes and knowledge.</p>
      <button
        className={!selected ? 'is-selected' : ''}
        onClick={() => onSelect('')}
        aria-pressed={!selected}
      >
        All categories
      </button>
      {categories.length ? branch(null) : <p>No categorized content in this view yet.</p>}
    </nav>
  );
}
