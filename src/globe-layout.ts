import type { GraphNode } from '../shared/contracts';

export type Point3 = [number, number, number];

/** Evenly spaced logical positions, independent of API response ordering. */
export function globePositions(nodes: GraphNode[], radius = 1.62): Map<string, Point3> {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return new Map(
    sorted.map((node, i) => {
      const y = 1 - (2 * (i + 0.5)) / sorted.length;
      const angle = i * Math.PI * (3 - Math.sqrt(5)) + 0.65;
      const ring = Math.sqrt(1 - y * y);
      return [
        node.id,
        [Math.sin(angle) * ring * radius, y * radius, Math.cos(angle) * ring * radius],
      ];
    }),
  );
}

/** A lifted great-circle arc. Handles coincident and antipodal endpoints. */
export function globeArc(start: Point3, end: Point3, segments = 64): Point3[] {
  const radius = Math.hypot(...start);
  const a = start.map((v) => v / radius) as Point3;
  const endRadius = Math.hypot(...end);
  const b = end.map((v) => v / endRadius) as Point3;
  const dot = Math.max(
    -1,
    Math.min(
      1,
      a.reduce((sum, v, i) => sum + v * b[i], 0),
    ),
  );
  const angle = Math.acos(dot);
  let tangent = b.map((v, i) => v - dot * a[i]) as Point3;
  let length = Math.hypot(...tangent);
  if (length < 1e-6) {
    const axis: Point3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const projection = a.reduce((sum, v, i) => sum + v * axis[i], 0);
    tangent = axis.map((v, i) => v - projection * a[i]) as Point3;
    length = Math.hypot(...tangent);
  }
  tangent = tangent.map((v) => v / length) as Point3;
  return Array.from({ length: segments + 1 }, (_, i) => {
    if (i === 0) return [...start];
    if (i === segments) return [...end];
    const t = i / segments;
    const height =
      radius + (endRadius - radius) * t + Math.sin(Math.PI * t) * (0.12 + angle * 0.14);
    return a.map(
      (v, j) => (v * Math.cos(angle * t) + tangent[j] * Math.sin(angle * t)) * height,
    ) as Point3;
  });
}
