import { describe, expect, it } from 'vitest';
import { globeArc, globePositions, type Point3 } from '../src/globe-layout';
import type { GraphNode } from '../shared/contracts';

describe('knowledge globe geometry', () => {
  it('clusters category members near their root and retains stable spherical positions', () => {
    const nodes: GraphNode[] = [
      { id: 'tech', label: 'Technology', type: 'category' },
      { id: 'data', label: 'Data & AI', type: 'category' },
      { id: 'life', label: 'Life', type: 'category' },
      { id: 'a', label: 'SQL', type: 'note' },
      { id: 'b', label: 'Travel', type: 'note' },
    ];
    const edges = [
      { id: '1', source: 'data', target: 'tech', type: 'category_parent' },
      { id: '2', source: 'a', target: 'data', type: 'categorized_as' },
      { id: '3', source: 'b', target: 'life', type: 'categorized_as' },
    ];
    const positions = globePositions(nodes, 1.62, edges);
    expect(globePositions([...nodes].reverse(), 1.62, [...edges].reverse())).toEqual(positions);
    for (const point of positions.values()) expect(Math.hypot(...point)).toBeCloseTo(1.62);
    const distance = (a: string, b: string) =>
      Math.hypot(...positions.get(a)!.map((value, i) => value - positions.get(b)![i]));
    expect(distance('a', 'tech')).toBeLessThan(distance('a', 'life'));
  });
  it('keeps API reorderings stable and places every node on the sphere', () => {
    const nodes: GraphNode[] = Array.from({ length: 150 }, (_, i) => ({
      id: `node-${i}`,
      label: `Idea ${i}`,
      type: 'note',
    }));
    const first = globePositions(nodes);
    expect(globePositions([...nodes].reverse())).toEqual(first);
    expect(first.size).toBe(nodes.length);
    for (const position of first.values()) expect(Math.hypot(...position)).toBeCloseTo(1.62);
    expect(globePositions([]).size).toBe(0);
  });
  it.each<[Point3, Point3]>([
    [
      [1.62, 0, 0],
      [0, 1.62, 0],
    ],
    [
      [1.62, 0, 0],
      [-1.62, 0, 0],
    ],
    [
      [0, 1.62, 0],
      [0, -1.62, 0],
    ],
    [
      [0, 0, 1.62],
      [0, 0, 1.62],
    ],
  ])('connects endpoints without crossing into the globe: %j → %j', (start, end) => {
    const points = globeArc(start, end);
    expect(points[0]).toEqual(start);
    expect(points.at(-1)).toEqual(end);
    for (const point of points) {
      expect(point.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...point)).toBeGreaterThanOrEqual(1.62 - 1e-10);
    }
    expect(Math.hypot(...points[Math.floor(points.length / 2)])).toBeGreaterThan(1.62);
  });
});
