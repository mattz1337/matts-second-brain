import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GraphNode, GraphResult } from '../shared/contracts';
import { globeArc, globePositions } from './globe-layout';

export const globeColors: Record<GraphNode['type'], string> = {
  claim: '#6ddbb6',
  note: '#aac7ff',
  entity: '#8fc7f4',
  topic: '#be9ef1',
  project: '#e7b783',
  source: '#a4bccb',
  category: '#859eff',
};

export interface GlobeScene {
  motion: (enabled: boolean) => void;
  select: (id: string | null) => void;
  zoom: (factor: number) => void;
  reset: () => void;
  dispose: () => void;
}

export function createGlobeScene(
  container: HTMLDivElement,
  data: GraphResult,
  options: {
    compact: boolean;
    reducedMotion: boolean;
    moving: boolean;
    onPick: (node: GraphNode) => void;
    onHover: (node: GraphNode | null, x: number, y: number) => void;
    onFailure: () => void;
    onReady: () => void;
  },
): GlobeScene {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);
  const labelLayer = document.createElement('div');
  labelLayer.className = 'globe-labels';
  labelLayer.setAttribute('aria-hidden', 'true');
  container.appendChild(labelLayer);
  const scene = new THREE.Scene();
  const fieldOfView = options.compact ? 46 : 42;
  const camera = new THREE.PerspectiveCamera(fieldOfView, 1, 0.1, 40);
  const home = new THREE.Vector3(0, 0.3, options.compact ? 5.5 : 5.8);
  camera.position.copy(home);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !options.reducedMotion;
  controls.dampingFactor = 0.065;
  controls.enablePan = false;
  controls.enableZoom = !options.compact;
  controls.minDistance = 3.1;
  controls.maxDistance = 9;
  controls.autoRotateSpeed = 0.48;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.7;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI - 0.15;
  let moving = options.moving && !options.reducedMotion;
  let selected: string | null = null;
  let flight: { start: THREE.Vector3; end: THREE.Vector3; at: number } | null = null;
  let disposed = false;
  let visible = true;
  let frame = 0;
  let time = 0;
  let last = 0;
  let rendered = false;
  let dirty = true;

  // The sphere represents a logical knowledge space, with no geographic mapping.
  scene.add(new THREE.AmbientLight(0xb6caff, 1.6));
  const light = new THREE.DirectionalLight(0xd8e8ff, 3.2);
  light.position.set(-3, 4, 5);
  scene.add(light);
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.56, 64, 48),
    new THREE.MeshPhongMaterial({ color: 0x14223c, shininess: 38, specular: 0x324b75 }),
  );
  scene.add(sphere);
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.68, 48, 32),
    new THREE.ShaderMaterial({
      uniforms: { tint: { value: new THREE.Color('#89aaff') } },
      vertexShader:
        'varying vec3 normalView; varying vec3 positionView; void main(){ vec4 p = modelViewMatrix * vec4(position,1.0); normalView=normalize(normalMatrix*normal); positionView=p.xyz; gl_Position=projectionMatrix*p; }',
      fragmentShader:
        'uniform vec3 tint; varying vec3 normalView; varying vec3 positionView; void main(){ float rim=1.0-abs(dot(normalize(normalView),normalize(-positionView))); gl_FragColor=vec4(tint,pow(rim,4.0)*0.23); }',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(atmosphere);
  const gridMaterial = new THREE.LineBasicMaterial({
    color: 0x62779d,
    transparent: true,
    opacity: 0.3,
  });
  const gridPoints: THREE.Vector3[] = [];
  const gridRadius = 1.565;
  for (let latitude = -60; latitude <= 60; latitude += 20) {
    const phi = (latitude * Math.PI) / 180;
    for (let i = 0; i < 120; i++) {
      for (const j of [i, i + 1]) {
        const theta = (j / 120) * Math.PI * 2;
        gridPoints.push(
          new THREE.Vector3(
            Math.cos(phi) * Math.sin(theta),
            Math.sin(phi),
            Math.cos(phi) * Math.cos(theta),
          ).multiplyScalar(gridRadius),
        );
      }
    }
  }
  for (let longitude = 0; longitude < 180; longitude += 20) {
    const theta = (longitude * Math.PI) / 180;
    for (let i = 0; i < 120; i++) {
      for (const j of [i, i + 1]) {
        const phi = (j / 120) * Math.PI * 2;
        gridPoints.push(
          new THREE.Vector3(
            Math.sin(theta) * Math.cos(phi),
            Math.sin(phi),
            Math.cos(theta) * Math.cos(phi),
          ).multiplyScalar(gridRadius),
        );
      }
    }
  }
  scene.add(
    new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPoints), gridMaterial),
  );
  const orbit = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 160 }, (_, i) => {
        const theta = (i / 160) * Math.PI * 2;
        return new THREE.Vector3(
          Math.cos(theta) * 2.18,
          Math.sin(theta) * 0.62,
          Math.sin(theta) * 2.05,
        );
      }),
    ),
    new THREE.LineDashedMaterial({
      color: 0x82b9a6,
      transparent: true,
      opacity: 0.18,
      dashSize: 0.025,
      gapSize: 0.08,
    }),
  );
  orbit.computeLineDistances();
  scene.add(orbit);

  // Small decorative stars frame the scene; only colored spheres are knowledge nodes.
  const stars = Array.from({ length: 240 }, (_, i) => {
    const pseudo = (seed: number) => (Math.sin(seed * 127.1 + 311.7) * 43758.5453) % 1;
    return new THREE.Vector3(
      pseudo(i + 1) * 8,
      pseudo(i + 261) * 6,
      -3 - Math.abs(pseudo(i + 501)) * 4,
    );
  });
  scene.add(
    new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(stars),
      new THREE.PointsMaterial({
        color: 0xb1d7c8,
        size: 0.012,
        transparent: true,
        opacity: 0.38,
        sizeAttenuation: true,
      }),
    ),
  );
  const positions = globePositions(data.nodes, 1.62, data.edges);
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const nodeMeshes: THREE.Mesh[] = [];
  const nodeGeometry = new THREE.SphereGeometry(1, 16, 12);
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = haloCanvas.height = 64;
  const context = haloCanvas.getContext('2d')!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.25, '#ffffff80');
  gradient.addColorStop(1, '#ffffff00');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const glowTexture = new THREE.CanvasTexture(haloCanvas);
  const halos: { sprite: THREE.Sprite; base: number; index: number; id: string }[] = [];
  const labels: { node: GraphNode; element: HTMLDivElement; position: THREE.Vector3 }[] = [];
  const ringGeometry = new THREE.RingGeometry(0.082, 0.092, 40);
  const rings: THREE.Mesh[] = [];
  for (const [i, node] of data.nodes.entries()) {
    const position = new THREE.Vector3(...positions.get(node.id)!);
    const hub = ['topic', 'project', 'category'].includes(node.type);
    const overdue = ['stale', 'expired', 'review_due'].includes(node.freshness || '');
    const color = overdue ? '#efb879' : globeColors[node.type];
    const mesh = new THREE.Mesh(nodeGeometry, new THREE.MeshBasicMaterial({ color }));
    mesh.position.copy(position);
    mesh.scale.setScalar(node.type === 'category' ? 0.065 : hub ? 0.055 : 0.037);
    mesh.userData.node = node;
    scene.add(mesh);
    nodeMeshes.push(mesh);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color,
        transparent: true,
        opacity: hub ? 0.55 : 0.38,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.position.copy(position);
    const base = hub ? 0.34 : 0.23;
    halo.scale.set(base, base, 1);
    scene.add(halo);
    halos.push({ sprite: halo, base, index: i, id: node.id });
    const ring = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({
        color: overdue ? '#efb879' : color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
        wireframe: node.lifecycle === 'candidate',
      }),
    );
    ring.position.copy(position.clone().multiplyScalar(1.012));
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), position.clone().normalize());
    ring.visible = overdue || node.lifecycle === 'candidate';
    ring.userData.node = node;
    scene.add(ring);
    rings.push(ring);
    const element = document.createElement('div');
    element.className = 'globe-node-label';
    element.textContent = node.label;
    element.style.setProperty('--node-color', color);
    labelLayer.appendChild(element);
    labels.push({ node, element, position });
  }
  const edges = data.edges.flatMap((edge, i) => {
    const a = positions.get(edge.source),
      b = positions.get(edge.target);
    if (!a || !b) return [];
    const points = globeArc(a, b).map((point) => new THREE.Vector3(...point));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color:
          edge.type === 'category_parent'
            ? 0x859eff
            : edge.type === 'categorized_as'
              ? 0x9aace3
              : 0x85b6da,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    );
    scene.add(line);
    const bead = new THREE.Mesh(
      nodeGeometry,
      new THREE.MeshBasicMaterial({ color: 0xd8e8ff, transparent: true, opacity: 0.92 }),
    );
    bead.scale.setScalar(0.016);
    bead.position.copy(points[0]);
    scene.add(bead);
    return [{ edge, line, bead, points, offset: i * 0.19 }];
  });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let down: { x: number; y: number } | null = null;
  const pick = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(nodeMeshes)[0];
    const surface = raycaster.intersectObject(sphere)[0];
    return hit && (!surface || hit.distance < surface.distance)
      ? (hit.object.userData.node as GraphNode)
      : null;
  };
  const onMove = (event: PointerEvent) => {
    const node = down ? null : pick(event);
    renderer.domElement.style.cursor = node ? 'pointer' : down ? 'grabbing' : 'grab';
    const rect = container.getBoundingClientRect();
    options.onHover(node, event.clientX - rect.left, event.clientY - rect.top);
  };
  const onDown = (event: PointerEvent) => {
    down = { x: event.clientX, y: event.clientY };
    flight = null;
    options.onHover(null, 0, 0);
  };
  const onUp = (event: PointerEvent) => {
    const clicked = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 6;
    down = null;
    if (clicked) {
      const node = pick(event);
      if (node) options.onPick(node);
    }
  };
  const onLeave = () => {
    down = null;
    options.onHover(null, 0, 0);
  };
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointerleave', onLeave);
  const onLost = (event: Event) => {
    event.preventDefault();
    options.onFailure();
  };
  renderer.domElement.addEventListener('webglcontextlost', onLost);
  const fly = (end: THREE.Vector3) => {
    dirty = true;
    if (options.reducedMotion) {
      camera.position.copy(end);
      controls.update();
    } else flight = { start: camera.position.clone(), end, at: performance.now() };
  };
  let width = 1,
    height = 1;
  const resize = () => {
    dirty = true;
    width = container.clientWidth;
    height = container.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    // Preserve horizontal breathing room on portrait screens, rather than cropping the globe.
    camera.fov = THREE.MathUtils.radToDeg(
      2 *
        Math.atan(Math.tan(THREE.MathUtils.degToRad(fieldOfView) / 2) / Math.min(camera.aspect, 1)),
    );
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  const cameraDirection = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const render = (now: number) => {
    if (disposed || !visible || document.hidden) {
      frame = 0;
      last = 0;
      return;
    }
    const delta = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    if (moving) time += delta;
    controls.autoRotate = moving && !flight && !down;
    if (flight) {
      const t = Math.min(1, (now - flight.at) / 1100);
      const ease = t * t * (3 - 2 * t);
      // Spherical interpolation keeps the camera outside the globe during a flight.
      const from = flight.start.clone().normalize(),
        to = flight.end.clone().normalize();
      const quaternion = new THREE.Quaternion().setFromUnitVectors(from, to);
      camera.position
        .copy(from.applyQuaternion(new THREE.Quaternion().slerp(quaternion, ease)))
        .multiplyScalar(THREE.MathUtils.lerp(flight.start.length(), flight.end.length(), ease));
      if (t === 1) flight = null;
    }
    const changed = controls.update(delta);
    if (!moving && !flight && !changed && !dirty && rendered) {
      frame = requestAnimationFrame(render);
      return;
    }
    for (const { sprite, base, index, id } of halos) {
      const pulse = moving ? 1 + Math.sin(time * 1.5 + index) * 0.12 : 1;
      sprite.scale.setScalar(base * pulse * (id === selected ? 1.5 : 1));
    }
    for (const { edge, line, bead, points, offset } of edges) {
      const connected = edge.source === selected || edge.target === selected;
      line.material.opacity = selected ? (connected ? 0.85 : 0.09) : 0.36;
      bead.visible = moving && (!selected || connected);
      const progress = ((time * 0.12 + offset) % 1) * (points.length - 1);
      const index = Math.floor(progress);
      bead.position
        .copy(points[index])
        .lerp(points[Math.min(index + 1, points.length - 1)], progress - index);
    }
    cameraDirection.copy(camera.position).normalize();
    const candidates = labels.filter(
      ({ position, node }) =>
        position.clone().normalize().dot(cameraDirection) > 0.3 &&
        (node.id === selected ||
          !selected ||
          data.edges.some(
            (edge) =>
              (edge.source === selected && edge.target === node.id) ||
              (edge.target === selected && edge.source === node.id),
          )),
    );
    candidates.sort(
      (a, b) =>
        Number(b.node.id === selected) - Number(a.node.id === selected) ||
        Number(['category', 'topic', 'project'].includes(b.node.type)) -
          Number(['category', 'topic', 'project'].includes(a.node.type)),
    );
    const shown = new Set(candidates.slice(0, options.compact ? 3 : 7));
    for (const label of labels) {
      const show =
        shown.has(label) &&
        (!options.compact || ['category', 'topic', 'project'].includes(label.node.type));
      label.element.style.opacity = show ? '1' : '0';
      if (!show) continue;
      projected.copy(label.position).project(camera);
      label.element.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
      label.element.style.top = `${(-projected.y * 0.5 + 0.5) * height + 13}px`;
      label.element.classList.toggle('is-selected', label.node.id === selected);
    }
    renderer.render(scene, camera);
    dirty = false;
    if (!rendered) {
      rendered = true;
      options.onReady();
    }
    frame = requestAnimationFrame(render);
  };
  const resume = () => {
    if (!frame && !disposed && visible && !document.hidden) frame = requestAnimationFrame(render);
  };
  const intersection = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    resume();
  });
  intersection.observe(container);
  document.addEventListener('visibilitychange', resume);
  resume();
  return {
    motion(enabled) {
      moving = enabled && !options.reducedMotion;
      dirty = true;
    },
    select(id) {
      dirty = true;
      selected = id;
      for (const ring of rings) {
        const node = ring.userData.node as GraphNode;
        ring.visible =
          node.id === id ||
          node.lifecycle === 'candidate' ||
          ['stale', 'expired', 'review_due'].includes(node.freshness || '');
        ring.scale.setScalar(node.id === id ? 1.45 : 1);
      }
      if (id && byId.has(id))
        fly(new THREE.Vector3(...positions.get(id)!).normalize().multiplyScalar(4.8));
    },
    zoom(factor) {
      fly(
        camera.position
          .clone()
          .normalize()
          .multiplyScalar(
            THREE.MathUtils.clamp(
              camera.position.length() * factor,
              controls.minDistance,
              controls.maxDistance,
            ),
          ),
      );
    },
    reset() {
      selected = null;
      fly(home.clone());
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', resume);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      controls.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.Line ||
          object instanceof THREE.Points ||
          object instanceof THREE.Sprite
        ) {
          if ('geometry' in object) geometries.add(object.geometry);
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            materials.add(material);
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      glowTexture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labelLayer.remove();
    },
  };
}
