import { describe, expect, it } from 'vitest';
import { globeArc, globePositions, type Point3 } from '../src/globe-layout';
import type { GraphNode } from '../shared/contracts';

describe('knowledge globe geometry', () => {
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
