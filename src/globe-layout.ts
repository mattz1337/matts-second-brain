import type { GraphNode, GraphEdge } from '../shared/contracts';

export type Point3 = [number, number, number];

/** Evenly spaced logical positions, independent of API response ordering. */
export function globePositions(
  nodes: GraphNode[],
  radius = 1.62,
  edges: GraphEdge[] = [],
): Map<string, Point3> {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  if (edges.some((edge) => edge.type === 'categorized_as'))
    return categoryPositions(sorted, radius, edges);
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

function categoryPositions(
  nodes: GraphNode[],
  radius: number,
  edges: GraphEdge[],
): Map<string, Point3> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map(
    edges
      .filter((edge) => edge.type === 'category_parent')
      .map((edge) => [edge.source, edge.target]),
  );
  const groups = new Map<string, GraphNode[]>();
  const rootOf = (id: string) => {
    const visited = new Set<string>();
    while (parents.has(id) && byId.has(parents.get(id)!) && !visited.has(id)) {
      visited.add(id);
      id = parents.get(id)!;
    }
    return id;
  };
  for (const node of nodes) {
    // Prefer subject/custom classification over the parallel notebook hierarchy.
    const memberships = edges
      .filter((edge) => edge.source === node.id && edge.type === 'categorized_as')
      .sort(
        (a, b) =>
          Number(a.properties?.method === 'metadata') -
            Number(b.properties?.method === 'metadata') || a.target.localeCompare(b.target),
      );
    const category = node.type === 'category' ? node.id : memberships[0]?.target;
    const root = category && byId.has(category) ? rootOf(category) : '_context';
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(node);
  }
  const roots = [...groups.keys()].sort();
  const centers = globePositions(
    roots.map((id) => ({ id, label: id, type: 'category' })),
    1,
  );
  const result = new Map<string, Point3>();
  for (const root of roots) {
    const center = centers.get(root)!;
    const projection = Math.abs(center[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const dot = center.reduce((sum, value, i) => sum + value * projection[i], 0);
    const tangent = projection.map((value, i) => value - dot * center[i]);
    const norm = Math.hypot(...tangent);
    const u = tangent.map((value) => value / norm);
    const v = [
      center[1] * u[2] - center[2] * u[1],
      center[2] * u[0] - center[0] * u[2],
      center[0] * u[1] - center[1] * u[0],
    ];
    const members = groups
      .get(root)!
      .sort(
        (a, b) =>
          Number(b.id === root) - Number(a.id === root) ||
          Number(b.type === 'category') - Number(a.type === 'category') ||
          a.id.localeCompare(b.id),
      );
    const spread = Math.min(0.62, 1.25 / Math.sqrt(roots.length));
    members.forEach((node, i) => {
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      const distance = node.id === root ? 0 : spread * Math.sqrt((i + 0.5) / members.length);
      result.set(
        node.id,
        center.map(
          (value, j) =>
            radius *
            (value * Math.cos(distance) +
              (u[j] * Math.cos(angle) + v[j] * Math.sin(angle)) * Math.sin(distance)),
        ) as Point3,
      );
    });
  }
  return result;
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
