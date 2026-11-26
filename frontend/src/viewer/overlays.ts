// Lightweight 3D overlays (pins & GeoJSON/GPX tracks) anchored to real terrain elevation.
import * as THREE from "three";
import { lonLatToWorld, type Origin } from "./geo";

export interface PinOptions {
  id?: string;
  lat: number;
  lon: number;
  color?: string;
  label?: string;
  elevationOffset?: number;
}

export interface PinHandle {
  id: string;
  remove: () => void;
}

export interface TrackOptions {
  id?: string;
  color?: string;
  elevationOffset?: number;
}

export interface TrackHandle {
  id: string;
  points: number;
  remove: () => void;
}

export type GeoJSONInput =
  | { type: "LineString"; coordinates: number[][] }
  | { type: "MultiLineString"; coordinates: number[][][] }
  | { type: "Feature"; geometry: { type: string; coordinates: unknown } | null }
  | { type: "FeatureCollection"; features: Array<{ geometry: { type: string; coordinates: unknown } | null }> };

interface PinItem {
  id: string;
  lat: number;
  lon: number;
  offset: number;
  group: THREE.Group;
}

interface TrackItem {
  id: string;
  segments: Array<Array<[number, number]>>; // [lat, lon]
  offset: number;
  group: THREE.Group;
  mat: THREE.LineBasicMaterial;
}

const pinStemGeo = new THREE.CylinderGeometry(0.18, 0.04, 4.5, 8).translate(0, 2.25, 0);
const pinHeadGeo = new THREE.SphereGeometry(0.95, 12, 10).translate(0, 5.1, 0);

/** Extract [lat, lon] polylines from GeoJSON (LineString / MultiLineString / Feature / FeatureCollection) or GPX XML. */
export function parseTrackInput(input: GeoJSONInput | string): Array<Array<[number, number]>> {
  const segs: Array<Array<[number, number]>> = [];
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) return parseTrackInput(JSON.parse(trimmed) as GeoJSONInput);
    // GPX XML (<trkpt lat="..." lon="..."> or <rtept ...>)
    const re = /<(?:trkpt|rtept)\b[^>]*?\blat=["']([^"']+)["'][^>]*?\blon=["']([^"']+)["']|<\/(?:trkseg|rte)>/gi;
    let cur: Array<[number, number]> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed)) !== null) {
      if (m[1] !== undefined && m[2] !== undefined) {
        const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) cur.push([lat, lon]);
      } else if (cur.length >= 2) {
        segs.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) segs.push(cur);
    return segs;
  }
  const pushLine = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    const pts: Array<[number, number]> = [];
    for (const c of coords) {
      if (Array.isArray(c) && c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
        pts.push([c[1], c[0]]); // GeoJSON is [lon, lat]
      }
    }
    if (pts.length >= 2) segs.push(pts);
  };
  const visit = (g: { type: string; coordinates?: unknown; geometry?: { type: string; coordinates?: unknown } | null; features?: Array<{ geometry: { type: string; coordinates?: unknown } | null }> } | null) => {
    if (!g) return;
    if (g.type === "LineString") pushLine(g.coordinates);
    else if (g.type === "MultiLineString" && Array.isArray(g.coordinates)) g.coordinates.forEach(pushLine);
    else if (g.type === "Feature") visit(g.geometry ?? null);
    else if (g.type === "FeatureCollection" && Array.isArray(g.features)) g.features.forEach((f) => visit(f.geometry));
  };
  visit(input as never);
  return segs;
}

export class OverlayLayer {
  private root = new THREE.Group();
  private pins = new Map<string, PinItem>();
  private tracks = new Map<string, TrackItem>();
  private seq = 1;
  private getOrigin: () => Origin;
  private getHeight: (x: number, z: number) => number;

  constructor(scene: THREE.Scene, getOrigin: () => Origin, getHeight: (x: number, z: number) => number) {
    this.root.name = "rausmap-overlays";
    scene.add(this.root);
    this.getOrigin = getOrigin;
    this.getHeight = getHeight;
  }

  addPin(opts: PinOptions): PinHandle {
    const id = opts.id ?? `pin-${this.seq++}`;
    this.removePin(id);
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: opts.color ?? "#ef4444", roughness: 0.35, metalness: 0.1 });
    const stem = new THREE.Mesh(pinStemGeo, mat);
    const head = new THREE.Mesh(pinHeadGeo, mat);
    group.add(stem, head);
    this.root.add(group);
    const item: PinItem = { id, lat: opts.lat, lon: opts.lon, offset: opts.elevationOffset ?? 0, group };
    this.pins.set(id, item);
    this.placePin(item);
    return { id, remove: () => this.removePin(id) };
  }

  removePin(id: string) {
    const it = this.pins.get(id);
    if (!it) return;
    this.root.remove(it.group);
    it.group.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
    this.pins.delete(id);
  }

  clearPins() {
    for (const id of [...this.pins.keys()]) this.removePin(id);
  }

  addTrack(input: GeoJSONInput | string, opts?: TrackOptions): TrackHandle {
    const id = opts?.id ?? `track-${this.seq++}`;
    this.removeTrack(id);
    const segments = parseTrackInput(input);
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: opts?.color ?? "#06b6d4" });
    this.root.add(group);
    const item: TrackItem = { id, segments, offset: opts?.elevationOffset ?? 1.2, group, mat };
    this.tracks.set(id, item);
    this.rebuildTrack(item);
    const points = segments.reduce((acc, s) => acc + s.length, 0);
    return { id, points, remove: () => this.removeTrack(id) };
  }

  removeTrack(id: string) {
    const it = this.tracks.get(id);
    if (!it) return;
    this.root.remove(it.group);
    it.group.traverse((o) => { if (o instanceof THREE.Line) o.geometry.dispose(); });
    it.mat.dispose();
    this.tracks.delete(id);
  }

  clearTracks() {
    for (const id of [...this.tracks.keys()]) this.removeTrack(id);
  }

  /** Re-project all pins and tracks after a teleport or when new terrain tiles arrive. */
  sync() {
    if (!this.pins.size && !this.tracks.size) return;
    for (const p of this.pins.values()) this.placePin(p);
    for (const t of this.tracks.values()) this.rebuildTrack(t);
  }

  dispose() {
    this.clearPins();
    this.clearTracks();
    this.root.removeFromParent();
  }

  private placePin(p: PinItem) {
    const w = lonLatToWorld(this.getOrigin(), p.lat, p.lon);
    p.group.position.set(w.x, this.getHeight(w.x, w.z) + p.offset, w.z);
  }

  private rebuildTrack(t: TrackItem) {
    while (t.group.children.length) {
      const ch = t.group.children.pop()!;
      if (ch instanceof THREE.Line) ch.geometry.dispose();
    }
    const origin = this.getOrigin();
    for (const seg of t.segments) {
      const pos = new Float32Array(seg.length * 3);
      for (let i = 0; i < seg.length; i++) {
        const w = lonLatToWorld(origin, seg[i][0], seg[i][1]);
        pos[i * 3] = w.x;
        pos[i * 3 + 1] = this.getHeight(w.x, w.z) + t.offset;
        pos[i * 3 + 2] = w.z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      t.group.add(new THREE.Line(geo, t.mat));
    }
  }
}
