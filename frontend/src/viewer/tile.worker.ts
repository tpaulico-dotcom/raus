// Builds 3D geometry for a map tile off the main thread so walking/flying never stutters.
import { ShapeUtils, Vector2 } from "three";
import { apiGet, tileVersion } from "@/lib/api";
import type { TerrainGrid, TileData } from "@/lib/types";
import { sampleGrid } from "./terrain";
import type { BuildRequest, MeshArrays, RoadMat, TileBuild, WorkerReply, WorldPlace, WorldPoi } from "./buildTypes";
import { ROAD_MATS } from "./buildTypes";
import { TILE_Z } from "./geo";

const ctx = self as unknown as Worker;

// ---------- raw data cache (survives teleports: only the build depends on the origin) ----------
const raw = new Map<string, TileData>();
const pending = new Map<string, Promise<TileData>>();
function getTile(key: string, x: number, y: number, lod: "detail" | "coarse" = "detail"): Promise<TileData> {
  // La clé de cache porte le niveau de détail : la même tuile existe en version complète
  // (bâtiments) et en version allégée (terrain + grands axes), et les deux doivent coexister.
  const ck = `${key}|${lod}`;
  const hit = raw.get(ck);
  if (hit) {
    raw.delete(ck);
    raw.set(ck, hit);
    return Promise.resolve(hit);
  }
  let p = pending.get(ck);
  if (!p) {
    p = tileVersion()
      .then((v) => apiGet<TileData>(`/tiles/${TILE_Z}/${x}/${y}?v=${v}&lod=${lod}`))
      .then((d) => {
      raw.set(ck, d);
      if (raw.size > 80) raw.delete(raw.keys().next().value as string);
      return d;
    });
    p.finally(() => pending.delete(ck)).catch(() => undefined);
    pending.set(ck, p);
  }
  return p;
}

const terr = new Map<string, Float32Array>();
async function getTerrain(key: string, x: number, y: number): Promise<{ h: Float32Array; size: number }> {
  let h = terr.get(key);
  if (h === undefined) {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const g = await apiGet<TerrainGrid>(`/terrain/${TILE_Z}/${x}/${y}`);
        h = new Float32Array(g.heights);
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 350));
      }
    }
    if (!h) throw lastErr ?? new Error("terrain unavailable");
    terr.set(key, h);
    if (terr.size > 80) terr.delete(terr.keys().next().value as string);
  }
  return { h: h.slice(), size: Math.round(Math.sqrt(h.length)) };
}

// ---------- helpers ----------
class Acc {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c: number[]) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, w);
    this.col.push(c[0], c[1], c[2]);
  }
  out(): MeshArrays {
    return {
      pos: new Float32Array(this.pos),
      nor: new Float32Array(this.nor),
      uv: new Float32Array(this.uv),
      col: new Float32Array(this.col),
    };
  }
}

const lin = (hex: string): number[] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.pow(c / 255, 2.2));
};
const pal = (list: string[]) => list.map(lin);

const FACADES = pal(["#efe6d2", "#e8d8b8", "#f2e2c4", "#d9cbb0", "#ebcfa5", "#f0d7c8", "#dcdfd8", "#cdbb9f", "#e8e2d4", "#f3e9c6", "#d6c3a5"]);
const CITY_FACADES = pal(["#e6dcc8", "#dccfb7", "#e9e2d2", "#d2c6b0", "#c9c1b5"]);
const TILE_ROOFS = pal(["#9c4a32", "#8a3f2b", "#a5583a", "#7d4433", "#b0603f", "#6e3b2e", "#5d6168"]);
const FLAT_ROOFS = pal(["#8b8f93", "#7d8085", "#9a9a95", "#6f7377"]);
const CHURCH_WALL = lin("#d79f88");
const CHURCH_ROOF = lin("#66707b");
const SPIRE = lin("#5f6873");
const WHITE = [1, 1, 1];
const AREA_HEX: Record<string, string> = {
  residential: "#8fa66a", urban: "#b4b0a4", farmland: "#b9b37c", cemetery: "#8ea07a", wood: "#5a7d3c", grass: "#86ad5e",
  sand: "#e9d9a6", rock: "#a49e93", pitch: "#6aa955", park: "#79a656", plaza: "#d2c9b6",
};

const AREA_ORDER: Record<string, number> = {
  residential: 1, urban: 2, farmland: 3, cemetery: 4, wood: 5, grass: 6,
  // Le sable passe APRÈS l'eau : la plage d'OSM chevauche le polygone de mer, et peinte avant
  // elle disparaissait sous le bleu — la mer semblait venir buter sur les immeubles.
  rock: 6, pitch: 7, park: 8, plaza: 9, water: 10, sand: 11,
};

const ROAD_STYLE: Record<string, { mat: RoadMat; w: number; walk?: boolean; order: number; color: string; dashed?: boolean }> = {
  rail:       { mat: "rail",   w: 3.0, order: 0, color: "#7a7067" },
  path:       { mat: "gravel", w: 1.6, order: 1, color: "#b9a988" },
  track:      { mat: "gravel", w: 2.6, order: 2, color: "#b5a482" },
  pedestrian: { mat: "paving", w: 3.0, order: 3, color: "#c4bcad" },
  service:    { mat: "minor",  w: 2.8, order: 4, color: "#61656b" },
  minor:      { mat: "minor",  w: 4.2, walk: true, order: 5, color: "#5b5f65" },
  tertiary:   { mat: "major",  w: 6.0, walk: true, order: 6, color: "#53575d" },
  secondary:  { mat: "major",  w: 7.0, walk: true, order: 7, color: "#4f5359", dashed: true },
  primary:    { mat: "major",  w: 8.0, walk: true, order: 8, color: "#4c5056", dashed: true },
  trunk:      { mat: "major",  w: 11.0, order: 9, color: "#484c52", dashed: true },
  motorway:   { mat: "major",  w: 14.0, order: 10, color: "#45494f", dashed: true },
};
const WATERWAY_W: Record<string, number> = { river: 9, canal: 6, stream: 2.5, ditch: 1.5, drain: 1.5 };

function hash(a: number, b: number) {
  let h = (a * 73856093) ^ (b * 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];

function signedArea(r: Pt[]) {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function pointInRing(x: number, z: number, r: Pt[]) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function flatPolygon(acc: Acc, outer: Pt[], holes: Pt[][], y: number, c: number[]) {
  const contour = outer.map((p) => new Vector2(p[0], -p[1]));
  const hs = holes.map((h) => h.map((p) => new Vector2(p[0], -p[1])));
  let faces: number[][];
  try {
    faces = ShapeUtils.triangulateShape(contour, hs);
  } catch {
    return;
  }
  const all = [...outer, ...holes.flat()];
  for (const f of faces) {
    for (const idx of f) {
      const p = all[idx];
      acc.v(p[0], y, p[1], 0, 1, 0, p[0] / 4, p[1] / 4, c);
    }
  }
}

function wallLoop(acc: Acc, ring: Pt[], y0: number, y1: number, c: number[], plain: boolean, vOff = 0, us = 3.6, vs = 3.3) {
  let dist = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const nx = dz / len;
    const nz = -dx / len;
    const u0 = plain ? 0.04 : dist / us;
    const u1 = plain ? 0.04 : (dist + len) / us;
    const v0 = plain ? 0.04 : (y0 - vOff) / vs;
    const v1 = plain ? 0.04 : (y1 - vOff) / vs;
    // (a0, b1, b0) and (a0, a1, b1): counter-clockwise seen from outside
    acc.v(a[0], y0, a[1], nx, 0, nz, u0, v0, c);
    acc.v(b[0], y1, b[1], nx, 0, nz, u1, v1, c);
    acc.v(b[0], y0, b[1], nx, 0, nz, u1, v0, c);
    acc.v(a[0], y0, a[1], nx, 0, nz, u0, v0, c);
    acc.v(a[0], y1, a[1], nx, 0, nz, u0, v1, c);
    acc.v(b[0], y1, b[1], nx, 0, nz, u1, v1, c);
    dist += len;
  }
}

function tri(acc: Acc, A: number[], B: number[], C: number[], c: number[]) {
  const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
  const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-6) return;
  nx /= l; ny /= l; nz /= l;
  if (ny < 0) {
    [B, C] = [C, B];
    nx = -nx; ny = -ny; nz = -nz;
  }
  acc.v(A[0], A[1], A[2], nx, ny, nz, 0, 0, c);
  acc.v(B[0], B[1], B[2], nx, ny, nz, 0, 0, c);
  acc.v(C[0], C[1], C[2], nx, ny, nz, 0, 0, c);
}

interface Frame { ax: number; az: number; cu: number; cv: number; L: number; W: number }
function principalFrame(ring: Pt[]): Frame {
  let best = 0, ax = 1, az = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; ax = (b[0] - a[0]) / l; az = (b[1] - a[1]) / l; }
  }
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const p of ring) {
    const u = p[0] * ax + p[1] * az;
    const v = -p[0] * az + p[1] * ax;
    umin = Math.min(umin, u); umax = Math.max(umax, u);
    vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  return { ax, az, cu: (umin + umax) / 2, cv: (vmin + vmax) / 2, L: umax - umin, W: vmax - vmin };
}
const fromUV = (f: Frame, u: number, v: number): Pt => [u * f.ax - v * f.az, u * f.az + v * f.ax];

function hipRoof(acc: Acc, ring: Pt[], f: Frame, y: number, rh: number, c: number[]) {
  const half = Math.max(0, (f.L - f.W) / 2);
  const q = ring.map((p) => {
    const u = p[0] * f.ax + p[1] * f.az;
    const uc = Math.min(f.cu + half, Math.max(f.cu - half, u));
    const w = fromUV(f, uc, f.cv);
    return [w[0], y + rh, w[1]];
  });
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const pi = [ring[i][0], y, ring[i][1]];
    const pj = [ring[j][0], y, ring[j][1]];
    tri(acc, pi, pj, q[j], c);
    tri(acc, pi, q[j], q[i], c);
  }
}

function box(acc: Acc, cx: number, cz: number, w: number, ax: number, az: number, y0: number, y1: number, c: number[]) {
  const h = w / 2;
  const bx = -az, bz = ax;
  const ring: Pt[] = [
    [cx - ax * h - bx * h, cz - az * h - bz * h],
    [cx + ax * h - bx * h, cz + az * h - bz * h],
    [cx + ax * h + bx * h, cz + az * h + bz * h],
    [cx - ax * h + bx * h, cz - az * h + bz * h],
  ];
  if (signedArea(ring) < 0) ring.reverse();
  wallLoop(acc, ring, y0, y1, c, true);
  return ring;
}

/** Parallélépipède fermé sur le dessus, utilisé pour les croix et dalles de cimetière. */
function rectBox(acc: Acc, cx: number, cz: number, w: number, d: number, ax: number, az: number, y0: number, y1: number, c: number[]) {
  const hw = w / 2, hd = d / 2;
  const bx = -az, bz = ax;
  const r: Pt[] = [
    [cx - ax * hw - bx * hd, cz - az * hw - bz * hd],
    [cx + ax * hw - bx * hd, cz + az * hw - bz * hd],
    [cx + ax * hw + bx * hd, cz + az * hw + bz * hd],
    [cx - ax * hw + bx * hd, cz - az * hw + bz * hd],
  ];
  if (signedArea(r) < 0) r.reverse();
  wallLoop(acc, r, y0, y1, c, true);
  tri(acc, [r[0][0], y1, r[0][1]], [r[1][0], y1, r[1][1]], [r[2][0], y1, r[2][1]], c);
  tri(acc, [r[0][0], y1, r[0][1]], [r[2][0], y1, r[2][1]], [r[3][0], y1, r[3][1]], c);
}

type HFn = (x: number, z: number) => number;
let H: HFn = () => 0;

function densify(src: Pt[], step: number): Pt[] {
  const out: Pt[] = [src[0]];
  for (let i = 1; i < src.length; i++) {
    const [ax, az] = src[i - 1], [bx, bz] = src[i];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / step);
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

function ribbon(acc: Acc, rawPts: Pt[], w: number, y: number, vScale: number, c: number[], taper = 0, base?: number, down = false, step = 12) {
  if (rawPts.length < 2) return;
  const pts = densify(rawPts, step);
  const n = pts.length;
  if (n < 2) return;
  const hw = w / 2;
  const segN: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dz) || 1;
    segN.push([dz / l, -dx / l]);
  }
  const L: Pt[] = [], R: Pt[] = [], V: number[] = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const n1 = segN[Math.max(0, i - 1)], n2 = segN[Math.min(n - 2, i)];
    let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const k = hw / Math.max(0.45, mx * n2[0] + mz * n2[1]);
    L.push([pts[i][0] + mx * k, pts[i][1] + mz * k]);
    R.push([pts[i][0] - mx * k, pts[i][1] - mz * k]);
    if (i > 0) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    V.push(d / vScale);
  }
  // `taper` (m) : le tablier descend rejoindre le sol sur cette distance à chaque extrémité,
  // sinon il finit en falaise — vu de haut, un pont qui commence et s'arrête dans l'eau.
  const total = d;
  const tp = Math.min(taper, total / 2.6); // un pont court garde un milieu plat
  const prof = (i: number) => {
    if (tp <= 0) return 1;
    const k = Math.min(1, Math.min(V[i] * vScale, total - V[i] * vScale) / tp);
    return k * k * (3 - 2 * k); // lissé : une courbe, pas un angle en haut de rampe
  };
  // `base` = niveau des culées (le sol aux deux extrémités du pont) : une travée est PLATE et ne
  // suit pas les creux du terrain en dessous, sinon le pont plonge au-dessus de la rivière.
  const lift = (p: Pt, i: number) => {
    const k = prof(i), g = H(p[0], p[1]);
    return (base === undefined ? g : g * (1 - k) + base * k) + y * k;
  };
  const yl = L.map(lift), yr = R.map(lift);
  const ny = down ? -1 : 1; // `down` : face tournée vers le sol (le dessous d'un tablier)
  for (let i = 0; i < n - 1; i++) {
    const v6: [number, number, number, number, number][] = [
      [R[i][0], yr[i], R[i][1], 1, V[i]],
      [R[i + 1][0], yr[i + 1], R[i + 1][1], 1, V[i + 1]],
      [L[i + 1][0], yl[i + 1], L[i + 1][1], 0, V[i + 1]],
      [R[i][0], yr[i], R[i][1], 1, V[i]],
      [L[i + 1][0], yl[i + 1], L[i + 1][1], 0, V[i + 1]],
      [L[i][0], yl[i], L[i][1], 0, V[i]],
    ];
    for (const [x, yy, z, uu, vv] of (down ? [...v6].reverse() : v6)) acc.v(x, yy, z, 0, ny, 0, uu, vv, c);
  }
}

// ---------- ponts et tunnels ----------
// Un pont pose son tablier au-dessus du sol (au-dessus de l'eau ou d'une autre voie) ; un
// tunnel passe dessous et ne laisse voir que ses débouchés.
// Un pont ne surélève pas la chaussée : il la maintient au niveau de la route et laisse la
// rivière (ou la voie franchie) en dessous. Seule l'épaisseur de la dalle passe sous le
// revêtement — sinon la route grimpe de plusieurs mètres et la traversée se voit.
const SLAB_H = 0.45; // épaisseur de dalle entre la chaussée et son dessous
const RAIL_H = 1.0; // garde-corps
const PORTAL_H = 3.8; // hauteur de l'ouverture d'un tunnel
const PORTAL_EDGE = 40; // en deçà du bord de tuile, une extrémité n'est qu'un découpage
const STONE = [0.78, 0.77, 0.73];
const DARK = [0.09, 0.09, 0.1];
const COVER = [0.6, 0.58, 0.54]; // couverture d'un tronçon enterré
const TAPER = 26; // longueur d'amorce : le tablier rejoint le sol en pente douce
const SKIRT = 0.3; // simple bord de dalle : le pont garde une épaisseur vue du sol, sans mur

function lineLen(pts: Pt[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

/** Point à la fraction `u` de la longueur, avec la direction locale de la voie. */
function pointAt(pts: Pt[], u: number): [number, number, number, number] {
  const last = pts.length - 1;
  const dx0 = pts[last][0] - pts[last - 1][0], dz0 = pts[last][1] - pts[last - 1][1];
  const l0 = Math.hypot(dx0, dz0) || 1;
  const want = lineLen(pts) * u;
  let d = 0;
  for (let i = 1; i <= last; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
    const l = Math.hypot(dx, dz);
    if (d + l >= want) {
      const t = l > 0 ? (want - d) / l : 0;
      const ll = l || 1;
      return [pts[i - 1][0] + dx * t, pts[i - 1][1] + dz * t, dx / ll, dz / ll];
    }
    d += l;
  }
  return [pts[last][0], pts[last][1], dx0 / l0, dz0 / l0];
}

/** Ligne décalée latéralement : sert aux garde-corps, de part et d'autre du tablier. */
function offsetLine(pts: Pt[], d: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    out.push([pts[i][0] + dz * d, pts[i][1] - dx * d]);
  }
  return out;
}

/** Joues d'un tablier : faces verticales sous les deux bords, pour que le pont ait une
 *  épaisseur — sans elles il n'a qu'une face supérieure et disparaît vu de la chaussée. */
function deckSkirt(acc: Acc, rawPts: Pt[], hw: number, y: number, depth: number, c: number[], taper: number, base: number) {
  const pts = densify(rawPts, 6);
  const n = pts.length;
  if (n < 2) return;
  let total = 0;
  const dist: number[] = [0];
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    dist.push(total);
  }
  const tp = Math.min(taper, total / 2.6);
  const lift = (i: number) => {
    const k = tp > 0 ? Math.min(1, Math.min(dist[i], total - dist[i]) / tp) : 1;
    const s = k * k * (3 - 2 * k), g = H(pts[i][0], pts[i][1]);
    return g * (1 - s) + base * s + y * s;
  };
  const emit = (ax: number, az: number, ay: number, bx: number, bz: number, by: number, nx: number, nz: number) => {
    for (const sgn of [1, -1]) {
      const n1: [number, number, number] = [nx * sgn, 0, nz * sgn];
      const tri = (p1: number[], p2: number[], p3: number[]) => {
        const q = sgn > 0 ? [p1, p2, p3] : [p1, p3, p2];
        for (const q1 of q) acc.v(q1[0], q1[1], q1[2], n1[0], n1[1], n1[2], 0, 0, c);
      };
      tri([ax, ay, az], [bx, by, bz], [bx, by - depth, bz]);
      tri([ax, ay, az], [bx, by - depth, bz], [ax, ay - depth, az]);
    }
  };
  for (let i = 0; i < n - 1; i++) {
    let dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const nx = dz, nz = -dx; // normale laterale
    const ay = lift(i), by = lift(i + 1);
    emit(pts[i][0] + nx * hw, pts[i][1] + nz * hw, ay, pts[i + 1][0] + nx * hw, pts[i + 1][1] + nz * hw, by, nx, nz);
    emit(pts[i][0] - nx * hw, pts[i][1] - nz * hw, ay, pts[i + 1][0] - nx * hw, pts[i + 1][1] - nz * hw, by, -nx, -nz);
  }
}

/** Face verticale au-dessus du sol, dessinée des deux côtés (matériaux à simple face). */
function faceQuad(acc: Acc, at: Pt, nx: number, nz: number, halfW: number, y0: number, y1: number, c: number[], ux: number, uz: number, push: number) {
  const gx = at[0] + ux * push, gz = at[1] + uz * push;
  const yg = H(at[0], at[1]);
  const ax = gx + nx * halfW, az = gz + nz * halfW;
  const bx = gx - nx * halfW, bz = gz - nz * halfW;
  const A0: [number, number, number] = [ax, yg + y0, az];
  const B0: [number, number, number] = [bx, yg + y0, bz];
  const B1: [number, number, number] = [bx, yg + y1, bz];
  const A1: [number, number, number] = [ax, yg + y1, az];
  const tri = (p1: [number, number, number], p2: [number, number, number], p3: [number, number, number], n: [number, number, number], flip: boolean) => {
    const [a, b, e] = flip ? [p1, p3, p2] : [p1, p2, p3];
    acc.v(a[0], a[1], a[2], n[0], n[1], n[2], 0, 0, c);
    acc.v(b[0], b[1], b[2], n[0], n[1], n[2], 1, 0, c);
    acc.v(e[0], e[1], e[2], n[0], n[1], n[2], 1, 1, c);
  };
  const nF: [number, number, number] = [-ux, 0, -uz];
  const nB: [number, number, number] = [ux, 0, uz];
  tri(A0, B0, B1, nF, false);
  tri(A0, B1, A1, nF, false);
  tri(A0, B0, B1, nB, true);
  tri(A0, B1, A1, nB, true);
}

// ---------- main build ----------
function build(req: BuildRequest, t: TileData, ter: { h: Float32Array; size: number }): TileBuild {
  const t0 = performance.now();
  // Tuile allégée : vue lointaine. Le backend n'a envoyé ni bâtiment, ni POI, ni nom de rue ;
  // ici on se contente d'un sol moins fin et on supprime arbres et cimetières.
  const coarse = req.lod === "coarse";
  const { gx0, gy0, mpt } = req.origin;
  const ext = t.extent;
  const toW = (flat: number[]): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push([(t.x + flat[i] / ext - gx0) * mpt, (t.y + flat[i + 1] / ext - gy0) * mpt]);
    }
    return out;
  };
  const ring = (flat: number[]): Pt[] => {
    const r = toW(flat);
    if (r.length > 1) {
      const a = r[0], b = r[r.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) r.pop();
    }
    return r;
  };

  const walls = new Acc(), plainWalls = new Acc(), roofs = new Acc();
  const roads = Object.fromEntries(ROAD_MATS.map((m) => [m, new Acc()])) as Record<RoadMat, Acc>;
  const trees: number[] = [];
  const fpCoords: number[] = [], fpStarts: number[] = [], fpBoxes: number[] = [];
  const spawn: number[] = [];

  // Land cover, waterways, sidewalks, and road under-paint on a 2048x2048 groundImage (0.8 m/px).
  // Road carriageways are rendered as crisp textured 3D ribbons above sidewalks (no sidewalk ever crosses a junction).
  H = (x: number, z: number) => sampleGrid(ter.h, ter.size, x / mpt + gx0 - t.x, z / mpt + gy0 - t.y);
  let groundImage: ImageBitmap | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    const paint = (R: number): OffscreenCanvas => {
    const k = R / ext, pxPerM = R / mpt;
    const cv = new OffscreenCanvas(R, R);
    const g = cv.getContext("2d")!;
    g.fillStyle = "#97a771";
    g.fillRect(0, 0, R, R);

    // 1. Land cover / landuse / parks / water polygons
    const order = [...t.areas].sort((a, b) => (AREA_ORDER[a.kind] ?? 5) - (AREA_ORDER[b.kind] ?? 5));
    for (const a of order) {
      const hex = a.kind === "water" ? "#3f82ab" : AREA_HEX[a.kind];
      if (!hex) continue;
      g.fillStyle = hex;
      g.beginPath();
      for (const r of a.rings) {
        for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, r[i] * k, r[i + 1] * k);
        g.closePath();
      }
      g.fill("evenodd");
    }

    // Forêt : vert profond + moucheture de feuillage. OSM répertorie ces zones (landcover=wood),
    // on s'en sert pour les assombrir et les texturer — c'est ce qui distingue une forêt d'un pré.
    const wg = rng(t.x * 7919 + t.y * 131);
    for (const a of t.areas) {
      if (a.kind !== "wood") continue;
      const r0 = a.rings[0];
      if (!r0 || r0.length < 6) continue;
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (let i = 0; i < r0.length; i += 2) {
        if (r0[i] < minx) minx = r0[i];
        if (r0[i] > maxx) maxx = r0[i];
        if (r0[i + 1] < minz) minz = r0[i + 1];
        if (r0[i + 1] > maxz) maxz = r0[i + 1];
      }
      const bw = (maxx - minx) * k, bh = (maxz - minz) * k;
      if (bw < 2 || bh < 2) continue;
      g.save();
      g.beginPath();
      for (const r of a.rings) {
        for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, r[i] * k, r[i + 1] * k);
        g.closePath();
      }
      g.clip("evenodd");
      g.fillStyle = "#2c4723";
      g.fillRect(0, 0, R, R);
      // Une moucheture tous les ~30 px : la densité suit la surface de la forêt, donc une
      // grande forêt n'est pas plus lisse qu'un petit bois.
      const sc = R / 2048;
      const n = Math.min(700, Math.max(30, Math.floor((bw * bh) / 900)));
      for (let i = 0; i < n; i++) {
        g.fillStyle = wg() < 0.5 ? "rgba(20,38,16,0.42)" : "rgba(78,116,56,0.34)";
        g.beginPath();
        g.arc((minx * k) + wg() * bw, (minz * k) + wg() * bh, (5 + wg() * 15) * sc, 0, 6.2832);
        g.fill();
      }
      g.restore();
    }

    // Subtle organic texture on terrain (fast 2x2 block noise on 2048x2048)
    const img = g.getImageData(0, 0, R, R);
    const d = img.data, nr = rng(t.x * 31 + t.y * 17);
    for (let i = 0; i < d.length; i += 4) {
      const n = (nr() - 0.5) * 18;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
    g.putImageData(img, 0, 0);

    const strokePts = (pts: number[]) => {
      if (pts.length < 4) return;
      g.beginPath();
      g.moveTo(pts[0] * k, pts[1] * k);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] * k, pts[i + 1] * k);
      g.stroke();
    };
    g.lineCap = "round";
    g.lineJoin = "round";

    // 2. Waterways (rivers, canals, streams)
    g.strokeStyle = "#3f82ab";
    for (const w of t.waterways) {
      g.lineWidth = Math.max(2, (WATERWAY_W[w.kind] ?? 3) * pxPerM);
      strokePts(w.pts);
    }

    // 3. Sidewalks + road under-paint (seals T-junctions & curves cleanly under 3D road ribbons)
    const groundRoads = t.roads
      .filter((r) => !r.bridge && !r.tunnel && ROAD_STYLE[r.kind])
      .sort((a, b) => ROAD_STYLE[a.kind].order - ROAD_STYLE[b.kind].order);

    // Pass 1: Sidewalks (painted on groundImage so zero sidewalk ever cuts across an intersection)
    g.strokeStyle = "#c8c0b2";
    for (const r of groundRoads) {
      const st = ROAD_STYLE[r.kind];
      if (!st.walk || r.kind === "minor") continue;
      g.lineWidth = Math.max(3, (st.w + 2.6) * pxPerM);
      strokePts(r.pts);
    }

    // Pass 2: Road base under-paint (fills rounded intersection corners cleanly)
    for (const r of groundRoads) {
      const st = ROAD_STYLE[r.kind];
      g.strokeStyle = st.color;
      g.lineWidth = Math.max(2, st.w * pxPerM);
      strokePts(r.pts);
    }

    return cv;
    };
    // 2048 px = 0,8 m/px : net à hauteur d'œil. Mais sur une tuile très dense (Marseille,
    // 5 378 bâtiments) la construction de l'ImageBitmap échoue faute de mémoire vidéo, et la
    // tuile entière était perdue — un trou définitif dans la ville. On refait la peinture en
    // 1024 puis 512 au lieu d'abandonner : mieux vaut un sol un peu moins net que pas de sol.
    const base = coarse ? 512 : 2048;
    for (const scale of [base, base / 2, 256]) {
      try {
        groundImage = paint(scale).transferToImageBitmap();
        break;
      } catch {
        /* mémoire vidéo insuffisante à cette résolution : on essaie la suivante */
      }
    }
  }

  // Trees
  const rand = rng(t.x * 92821 + t.y);
  // Au sol : toutes les zones (forêts, parcs, cimetières) et budget large, il faut du volume.
  // En survol : seulement les forêts, budget serré — une forêt sans un seul arbre fait une
  // plaque verte plate, mais les arbres de ville, eux, ne se voient pas d'en haut.
  const allTrees = !coarse && req.trees !== false;
  let treeBudget = coarse ? 0 : allTrees ? 20000 : 6000;
  t.areas.forEach((a) => {
    if (!allTrees && a.kind !== "wood") return;
    const density = a.kind === "wood" ? 1 / 25 : a.kind === "park" ? 1 / 320 : a.kind === "cemetery" ? 1 / 500 : 0;
    if (!density || treeBudget <= 0) return;
    const outer = ring(a.rings[0]);
    if (outer.length < 3) return;
    const area = Math.abs(signedArea(outer));
    let count = Math.min(treeBudget, Math.floor(area * density));
    treeBudget -= count;
    // Contour décimé : tirer 20 000 points au hasard dans un anneau de 5 000 sommets coûtait
    // des minutes (pointInRing est linéaire). À 160 sommets l'erreur de contour reste < 2 m,
    // invisible pour un semis d'arbres.
    let poly = outer;
    if (poly.length > 160) {
      const step = Math.ceil(poly.length / 160);
      const dec: [number, number][] = [];
      for (let i = 0; i < poly.length; i += step) dec.push(poly[i]);
      poly = dec;
    }
    let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
    for (const p of poly) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
    let guard = count * 2;
    while (count > 0 && guard-- > 0) {
      const x = minx + rand() * (maxx - minx), z = minz + rand() * (maxz - minz);
      if (!pointInRing(x, z, poly)) continue;
      trees.push(x, H(x, z), z, 0.6 + rand() * 0.9, 1, rand());
      count--;
    }
  });

  // Cimetières : rangées de dalles et de croix alignées sur l'axe principal du terrain.
  // Tout part dans plainWalls (aucun draw call supplémentaire, budget borné par tuile).
  const CROSS_STONES = [lin("#f3f2ee"), lin("#dfddd7"), lin("#c4c2bc"), lin("#9e9d97"), lin("#767672")];
  const SLAB_STONES = [lin("#b6b4ae"), lin("#9a9993"), lin("#7d7c77"), lin("#5c5c58")];
  const CRYPT_ROOF = lin("#5c5e63");
  const CRYPT_DOOR = lin("#2e3034");
  const CEM_WALL = lin("#b5b0a6");
  const CEM_TILE = lin("#a64b35");
  let crossBudget = coarse ? 0 : 2200;
  for (const a of t.areas) {
    if (a.kind !== "cemetery" || crossBudget <= 0) continue;
    const outer = ring(a.rings[0]);
    if (outer.length < 3) continue;
    // Mur d'enceinte en pierre (2,70 m de haut) surmonté d'un chaperon à 2 pans en tuiles.
    for (let i = 0; i < outer.length; i++) {
      const p0 = outer[i], p1 = outer[(i + 1) % outer.length];
      const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.8) continue;
      const ax = dx / len, az = dz / len;
      const bx = -az, bz = ax;
      const segs = Math.max(1, Math.ceil(len / 8));
      const slen = len / segs;
      for (let s = 0; s < segs; s++) {
        const tMid = (s + 0.5) / segs;
        const mx = p0[0] + dx * tMid, mz = p0[1] + dz * tMid;
        const ym = H(mx, mz);
        const top = ym + 2.7;
        rectBox(plainWalls, mx, mz, slen + 0.15, 0.44, ax, az, ym - 0.6, top, CEM_WALL);
        // Chaperon en tuiles (2 pans inclinés débordants de 0,68 m de large, faîte +0,28 m)
        const hl = (slen + 0.2) / 2, hd = 0.34;
        const yE = top - 0.04, yR = top + 0.28;
        const a0 = [mx - ax * hl, yR, mz - az * hl];
        const a1 = [mx + ax * hl, yR, mz + az * hl];
        const l0 = [mx - ax * hl - bx * hd, yE, mz - az * hl - bz * hd];
        const l1 = [mx + ax * hl - bx * hd, yE, mz + az * hl - bz * hd];
        const r0 = [mx - ax * hl + bx * hd, yE, mz - az * hl + bz * hd];
        const r1 = [mx + ax * hl + bx * hd, yE, mz + az * hl + bz * hd];
        tri(roofs, l0, l1, a1, CEM_TILE); tri(roofs, l0, a1, a0, CEM_TILE);
        tri(roofs, r1, r0, a0, CEM_TILE); tri(roofs, r1, a0, a1, CEM_TILE);
      }
    }
    if (crossBudget <= 0) continue;
    const f = principalFrame(outer);
    const bx = -f.az, bz = f.ax;
    // Grille dense jusqu'aux murs (pas d'espace vide) : si le cimetière est immense, on ajuste
    // légèrement le pas pour couvrir 100 % de la surface au lieu de couper en plein milieu.
    const areaCem = Math.abs(signedArea(outer));
    const est = areaCem / (3.1 * 2.8);
    const kPas = est > crossBudget ? Math.sqrt(est / crossBudget) * 1.05 : 1;
    const stepU = 3.1 * kPas, stepV = 2.8 * kPas;
    const u0 = f.cu - f.L / 2 + 1.4, u1 = f.cu + f.L / 2 - 1.4;
    const v0 = f.cv - f.W / 2 + 1.4, v1 = f.cv + f.W / 2 - 1.4;
    for (let u = u0; u <= u1 && crossBudget > 0; u += stepU) {
      if (Math.abs(u - f.cu) < 1.1) continue;
      for (let v = v0; v <= v1 && crossBudget > 0; v += stepV) {
        const [x, z] = fromUV(f, u, v);
        if (!pointInRing(x, z, outer)) continue;
        const y = H(x, z);
        const kind = rand();
        const col = CROSS_STONES[Math.floor(rand() * CROSS_STONES.length)];
        const slab = SLAB_STONES[Math.floor(rand() * SLAB_STONES.length)];
        if (kind < 0.085) {
          // Crypte / petite chapelle funéraire simplifiée avec toit à 2 pans et petite croix
          const cw = 1.9 + rand() * 0.4, cd = 2.2 + rand() * 0.4, ch = 2.6 + rand() * 0.7;
          rectBox(plainWalls, x, z, cw, cd, f.ax, f.az, y - 0.3, y + ch, col);
          // Porte sombre en façade
          rectBox(plainWalls, x + bx * (cd / 2 + 0.03), z + bz * (cd / 2 + 0.03), 0.75, 0.08, f.ax, f.az, y + 0.05, y + 1.85, CRYPT_DOOR);
          // Toit à 2 pans en ardoise/pierre sombre
          const hw = cw / 2 + 0.14, hd = cd / 2 + 0.14;
          const yE = y + ch - 0.03, yR = y + ch + 0.65;
          const a0 = [x - bx * hd, yR, z - bz * hd], a1 = [x + bx * hd, yR, z + bz * hd];
          const l0 = [x - f.ax * hw - bx * hd, yE, z - f.az * hw - bz * hd];
          const l1 = [x - f.ax * hw + bx * hd, yE, z - f.az * hw + bz * hd];
          const r0 = [x + f.ax * hw - bx * hd, yE, z + f.az * hw - bz * hd];
          const r1 = [x + f.ax * hw + bx * hd, yE, z + f.az * hw + bz * hd];
          tri(roofs, l0, l1, a1, CRYPT_ROOF); tri(roofs, l0, a1, a0, CRYPT_ROOF);
          tri(roofs, r1, r0, a0, CRYPT_ROOF); tri(roofs, r1, a0, a1, CRYPT_ROOF);
          // Petite croix au sommet du fronton
          const fx = x + bx * (hd - 0.15), fz = z + bz * (hd - 0.15);
          rectBox(plainWalls, fx, fz, 0.14, 0.14, f.ax, f.az, yR - 0.05, yR + 0.65, col);
          rectBox(plainWalls, fx, fz, 0.48, 0.14, f.ax, f.az, yR + 0.34, yR + 0.46, col);
        } else {
          // Dalle + croix (tailles variées, dont ~20 % de grandes croix monumentales sur socle)
          const grande = kind < 0.28;
          const hCroix = grande ? 2.35 + rand() * 0.55 : 1.45 + rand() * 0.45;
          const ep = grande ? 0.28 : 0.21;
          const bras = grande ? 1.25 : 0.90;
          rectBox(plainWalls, x, z, 1.05, 1.85, f.ax, f.az, y - 0.2, y + (grande ? 0.38 : 0.24), slab);
          const hx = x - bx * 0.64, hz = z - bz * 0.64;
          if (grande) {
            rectBox(plainWalls, hx, hz, 0.68, 0.56, f.ax, f.az, y + 0.36, y + 0.85, col);
          }
          const yBase = grande ? y + 0.82 : y + 0.22;
          rectBox(plainWalls, hx, hz, ep, ep, f.ax, f.az, yBase, yBase + hCroix, col);
          rectBox(plainWalls, hx, hz, bras, ep, f.ax, f.az, yBase + hCroix * 0.64, yBase + hCroix * 0.64 + ep, col);
        }
        crossBudget--;
      }
    }
  }

  // 3D road carriageways (nettes à pied), vrais ponts et portails de tunnels.
  const decks: { pts: number[]; y: number; hw: number; base: number }[] = [];
  const mouths: { p: Pt; dir: Pt; w: number }[] = [];
  for (const r of t.roads) {
    const st = ROAD_STYLE[r.kind];
    if (!st) continue;
    const pts = toW(r.pts);
    if (r.tunnel) {
      const couvre = lineLen(pts);
      if (pts.length >= 2 && couvre >= 25) {
        for (const first of [true, false]) {
          const i = first ? 0 : pts.length - 1, j = first ? 1 : pts.length - 2;
          const q = pts[i];
          if (q[0] < PORTAL_EDGE || q[1] < PORTAL_EDGE || q[0] > mpt - PORTAL_EDGE || q[1] > mpt - PORTAL_EDGE) continue;
          const dx = q[0] - pts[j][0], dz = q[1] - pts[j][1];
          const l = Math.hypot(dx, dz) || 1;
          mouths.push({ p: q, dir: [dx / l, dz / l], w: st.w });
        }
      }
      continue;
    }
    if (r.bridge) {
      const dy = SLAB_H;
      const hw = st.w / 2;
      const abut = Math.max(H(pts[0][0], pts[0][1]), H(pts[pts.length - 1][0], pts[pts.length - 1][1]));
      ribbon(roads[st.mat], pts, st.w, dy, st.mat === "major" ? 9 : st.mat === "paving" ? 2 : 6, WHITE, TAPER, abut, false, 6);
      ribbon(roads.paving, offsetLine(pts, hw - 0.18), 0.36, dy + RAIL_H, 3, WHITE, TAPER, abut, false, 6);
      ribbon(roads.paving, offsetLine(pts, -(hw - 0.18)), 0.36, dy + RAIL_H, 3, WHITE, TAPER, abut, false, 6);
      deckSkirt(roads.paving, pts, hw, dy, SKIRT, WHITE, TAPER, abut);
      ribbon(roads.paving, pts, st.w + 0.2, dy - SKIRT, 4, COVER, TAPER, abut, true, 6);
      const ox = (t.x - gx0) * mpt, oy = (t.y - gy0) * mpt;
      const flat: number[] = [];
      for (const p of pts) flat.push(p[0] - ox, p[1] - oy);
      decks.push({ pts: flat, y: dy, hw, base: abut });
    } else {
      // Chaussée 3D nette à pied (texture asphalte/pavé/gravier/rail), sans trottoir 3D
      // (les trottoirs sont peints sur groundImage dessous) et hiérarchisée en Y pour des carrefours propres.
      const dy = 0.09 + st.order * 0.012;
      ribbon(roads[st.mat], pts, st.w, dy, st.mat === "major" ? 9 : st.mat === "paving" ? 2 : 6, WHITE, 0, undefined, false, 12);
    }
    if (r.kind !== "motorway" && r.kind !== "trunk" && r.kind !== "rail") {
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const l = Math.hypot(bx - ax, bz - az);
        if (l < 0.01) continue;
        const dx = (bx - ax) / l, dz = (bz - az) / l;
        for (let s = 0; s < l; s += 4) spawn.push(ax + dx * s, az + dz * s);
      }
    }
  }

  // Monuments & bâtiments publics : châteaux, gares, mairies, églises, écoles, hôpitaux, musées, bibliothèques
  const monuments: number[] = []; // stride 4: x, y, z, radius
  const stationSigns: { name: string; x: number; y: number; z: number; nx: number; nz: number; w: number }[] = [];
  const CASTLE_WALL = lin("#b9b09c");
  const CASTLE_ROOF = lin("#3b424d");
  const STATION_WALL = lin("#e4dcc9");
  const STATION_BASE = lin("#9f9a90");
  const STATION_ROOF = lin("#424b57");
  const STATION_CANOPY = lin("#6d869e");
  const CLOCK_FACE = lin("#f7f6f0");
  const CLOCK_RING = lin("#2e333a");

  const PUBLIC_KINDS = new Set(["townhall", "town_hall", "school", "college", "hospital", "library", "museum", "theatre", "stadium"]);
  const castlePois: { name: string; x: number; z: number; used: boolean }[] = [];
  const stationPois: { name: string; x: number; z: number; used: boolean }[] = [];
  const publicPois: { name: string; x: number; z: number }[] = [];
  for (const p of t.pois ?? []) {
    const [w] = toW([p.x, p.y]);
    const nm = p.name || "";
    if (p.kind === "castle" || ((p.kind === "historic" || p.kind === "monument" || p.kind === "attraction") && /ch[aâ]teau|fort|citadelle|donjon|palais/i.test(nm))) {
      castlePois.push({ name: nm, x: w[0], z: w[1], used: false });
    } else if (p.kind === "railway" || p.kind === "station" || /^gare\b/i.test(nm)) {
      stationPois.push({ name: nm || "Gare", x: w[0], z: w[1], used: false });
    } else if (PUBLIC_KINDS.has(p.kind) || /mairie|h[oô]tel de ville/i.test(nm)) {
      publicPois.push({ name: nm, x: w[0], z: w[1] });
    }
  }

  /** Tour octogonale + toit conique pointu pour les châteaux. */
  const castleTower = (tx: number, tz: number, r: number, y0: number, y1: number, coneH: number) => {
    const pts: Pt[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push([tx + Math.cos(a) * r, tz + Math.sin(a) * r]);
    }
    if (signedArea(pts) < 0) pts.reverse();
    wallLoop(plainWalls, pts, y0, y1, CASTLE_WALL, true);
    const apex = [tx, y1 + coneH, tz];
    for (let i = 0; i < 8; i++) {
      const a = pts[i], c = pts[(i + 1) % 8];
      tri(roofs, [a[0], y1, a[1]], [c[0], y1, c[1]], apex, CASTLE_ROOF);
    }
  };

  /** Construit un château complet (corps + 4 tours d'angle + donjon + éclairage nocturne). */
  const buildCastle = (outer: Pt[], base: number, relH: number) => {
    const f = principalFrame(outer);
    const hBody = Math.max(relH, 13);
    const top = base + hBody;
    wallLoop(plainWalls, outer, base, top, CASTLE_WALL, true);
    hipRoof(roofs, outer, f, top, Math.min(f.W * 0.35, 6), CASTLE_ROOF);
    const tr = Math.min(4.2, Math.max(2.4, Math.min(f.L, f.W) * 0.16));
    const hu = Math.max(2, f.L / 2 - tr * 0.4), hv = Math.max(2, f.W / 2 - tr * 0.4);
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
      const [tx, tz] = fromUV(f, f.cu + su * hu, f.cv + sv * hv);
      castleTower(tx, tz, tr, base, top + 5.5, tr * 2.2);
    }
    const [cx, cz] = fromUV(f, f.cu, f.cv);
    const dr = Math.min(6.5, Math.max(3.8, Math.min(f.L, f.W) * 0.25));
    castleTower(cx, cz, dr, base, top + 10.5, dr * 1.9);
    monuments.push(cx, base + 0.3, cz, Math.max(28, Math.min(46, f.L * 0.9)));
    monuments.push(cx, top + 6, cz, 22);
  };

  /** Construit une gare voyageurs spéciale (toit ardoise, marquise, horloge, panneau GARE + éclairage). */
  const buildStation = (outer: Pt[], base: number, relH: number, name: string) => {
    const f = principalFrame(outer);
    const bx = -f.az, bz = f.ax;
    const hBody = Math.max(8.5, Math.min(13, relH < 7 ? 9.5 : relH));
    const top = base + hBody;
    wallLoop(plainWalls, outer, base, base + 2.4, STATION_BASE, true);
    wallLoop(plainWalls, outer, base + 2.4, top, STATION_WALL, true);
    hipRoof(roofs, outer, f, top, Math.min(f.W * 0.45, 5.2), STATION_ROOF);
    const [cx, cz] = fromUV(f, f.cu, f.cv);
    for (const sv of [-1, 1]) {
      const [ax, az] = fromUV(f, f.cu, f.cv + sv * (f.W / 2 + 1.4));
      rectBox(plainWalls, ax, az, Math.max(6, f.L * 0.78), 2.8, f.ax, f.az, base + 3.6, base + 3.95, STATION_CANOPY);
    }
    const panelW = Math.min(14, Math.max(6.5, f.L * 0.5));
    // Horloge bien visible au fronton + grand panneau « GARE » en haut de façade, devant ET derrière
    for (const sv of [-1, 1]) {
      const [fx, fz] = fromUV(f, f.cu, f.cv + sv * (f.W / 2 + 0.16));
      const nx = bx * sv, nz = bz * sv;
      rectBox(plainWalls, fx, fz, 2.4, 0.35, f.ax, f.az, top - 0.4, top + 2.0, CLOCK_RING);
      rectBox(plainWalls, fx + nx * 0.12, fz + nz * 0.12, 1.9, 0.22, f.ax, f.az, top - 0.15, top + 1.75, CLOCK_FACE);
      if (stationSigns.length < 24) stationSigns.push({ name, x: fx + nx * 0.22, y: top - 2.6, z: fz + nz * 0.22, nx, nz, w: panelW });
    }
    monuments.push(cx, base + 0.3, cz, Math.max(24, f.L * 0.8));
  };
  // Debouchés de tunnel : cadre de pierre et ouverture sombre, debout face à la voie.
  for (const m of mouths) {
    const hw = m.w / 2, ux = m.dir[0], uz = m.dir[1];
    faceQuad(roads.paving, m.p, uz, -ux, hw + 1.4, 0, PORTAL_H + 1.6, STONE, ux, uz, -0.4);
    faceQuad(roads.paving, m.p, uz, -ux, hw, 0, PORTAL_H, DARK, ux, uz, 0.12);
  }
  const ground = new Map<string, Acc>();
  const groundAcc = (k: string) => {
    let a = ground.get(k);
    if (!a) { a = new Acc(); ground.set(k, a); }
    return a;
  };

  // Buildings (sitting on the terrain: base = lowest ground point of the footprint)
  for (const b of t.buildings) {
    const outer = ring(b.rings[0]);
    if (outer.length < 3) continue;
    if (signedArea(outer) < 0) outer.reverse();
    const holes = b.rings.slice(1).map(ring).filter((h) => h.length >= 3);
    for (const h of holes) if (signedArea(h) > 0) h.reverse();
    const seed = hash(b.rings[0][0], b.rings[0][1]);
    const area = Math.abs(signedArea(outer));
    let gMin = Infinity;
    for (const p of outer) gMin = Math.min(gMin, H(p[0], p[1]));
    // OSM often has no height: French town houses are 2-3 storeys, not 5 m boxes
    let rel = b.h;
    if (!b.church && b.h <= 5 && b.mh < 0.5 && area > 35) rel = 7 + seed * 3.6;
    const top = gMin + rel;
    const base = b.mh > 0.5 ? gMin + b.mh : gMin - 0.8;

    if (b.mh < 2) {
      fpStarts.push(fpCoords.length / 2);
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (const p of outer) {
        fpCoords.push(p[0], p[1]);
        minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]);
      }
      fpBoxes.push(minx, minz, maxx, maxz);
    }

    const bcx = (outer[0][0] + outer[Math.floor(outer.length / 2)][0]) / 2;
    const bcz = (outer[0][1] + outer[Math.floor(outer.length / 2)][1]) / 2;

    if (b.church) {
      const f = principalFrame(outer);
      wallLoop(plainWalls, outer, base, top, CHURCH_WALL, true);
      hipRoof(roofs, outer, f, top, Math.min(f.W * 0.6, 14), CHURCH_ROOF);
      const [mcx, mcz] = fromUV(f, f.cu, f.cv);
      monuments.push(mcx, base + 0.3, mcz, Math.max(24, f.L * 0.9));
      if (rel < 30 && f.L >= 12) {
        const tw = Math.min(9, Math.max(4.5, f.W * 0.5));
        const e1 = fromUV(f, f.cu - f.L / 2 + tw / 2, f.cv);
        const e2 = fromUV(f, f.cu + f.L / 2 - tw / 2, f.cv);
        const [cx, cz] = e1[0] < e2[0] ? e1 : e2; // bell tower on the west front
        const th = gMin + Math.max(rel * 2.2, 30);
        const tr = box(plainWalls, cx, cz, tw, f.ax, f.az, base, th, CHURCH_WALL);
        const apex = [cx, th + tw * 2.6, cz];
        for (let i = 0; i < 4; i++) {
          const a = tr[i], c = tr[(i + 1) % 4];
          tri(roofs, [a[0], th, a[1]], [c[0], th, c[1]], apex, SPIRE);
        }
        monuments.push(cx, th * 0.55 + base * 0.45, cz, 18);
      }
      continue;
    }

    // Château détecté par POI : toutes les ailes dans un rayon de 45 m prennent le style château
    // `used` : un POI ne doit habiller QU'UN bâtiment. Sans ce filtre, chaque maison à moins
    // de 55 m d'un arrêt de tram devenait une « gare » — et la planche de panneaux, une ligne
    // de 140 px par panneau, grossissait jusqu'à ne plus pouvoir être convertie en ImageBitmap
    // (tuile entière perdue : le trou de Marseille).
    const castleHit = castlePois.find((p) => !p.used && (pointInRing(p.x, p.z, outer) || Math.hypot(p.x - bcx, p.z - bcz) < 45));
    if (castleHit) {
      castleHit.used = true;
      buildCastle(outer, base, rel);
      continue;
    }

    // Gare détectée par POI : tout le complexe voyageurs + halle dans un rayon de 55 m prend le style gare
    const stationHit = stationPois.find((p) => !p.used && (pointInRing(p.x, p.z, outer) || Math.hypot(p.x - bcx, p.z - bcz) < 55));
    if (stationHit) {
      stationHit.used = true;
      buildStation(outer, base, rel, stationHit.name);
      continue;
    }

    // Bâtiment public (mairie, école, hôpital, bibliothèque, musée…) : éclairage nocturne
    const pubHit = publicPois.find((p) => pointInRing(p.x, p.z, outer) || Math.hypot(p.x - bcx, p.z - bcz) < 22);
    if (pubHit) {
      monuments.push(bcx, base + 0.3, bcz, 24);
    }

    const city = rel > 15;
    const facade = (city ? CITY_FACADES : FACADES)[Math.floor(seed * (city ? CITY_FACADES.length : FACADES.length))];
    const hasGround = !coarse && rel >= 5 && b.mh < 0.5;
    const split = gMin + 3.6;
    if (hasGround) {
      const ga = groundAcc(city ? "shop" : "d");
      wallLoop(ga, outer, base, split, facade, false, gMin, 7.2, 3.6);
      for (const h of holes) wallLoop(ga, h, base, split, facade, false, gMin, 7.2, 3.6);
    }
    wallLoop(walls, outer, hasGround ? split : base, top, facade, false, gMin);
    for (const h of holes) wallLoop(walls, h, hasGround ? split : base, top, facade, false, gMin);

    const pitched = holes.length === 0 && b.mh < 0.5 && area > 12 && area < 650 && rel <= 18 && outer.length <= 40;
    const roofPick = hash(seed * 1e6, 7);
    if (pitched) {
      const f = principalFrame(outer);
      const rh = Math.min(f.W * 0.5, 7);
      const rc = TILE_ROOFS[Math.floor(roofPick * TILE_ROOFS.length)];
      hipRoof(roofs, outer, f, top, rh, rc);
    } else {
      const rc = FLAT_ROOFS[Math.floor(seed * FLAT_ROOFS.length)];
      flatPolygon(roofs, outer, holes, top, rc);
    }
  }
  fpStarts.push(fpCoords.length / 2);

  // Terrain mesh (65x65 grid, same triangulation as sampleGrid) + skirts hiding seams between tiles
  const terrain = new Acc();
  {
    const n = ter.size - 1;
    const P = (i: number, j: number): number[] => {
      const x = (t.x + i / n - gx0) * mpt, z = (t.y + j / n - gy0) * mpt;
      return [x, ter.h[j * ter.size + i], z];
    };
    const nrm = (i: number, j: number) => {
      const a = P(Math.max(0, i - 1), j), b = P(Math.min(n, i + 1), j), c = P(i, Math.max(0, j - 1)), d = P(i, Math.min(n, j + 1));
      const dx = b[0] - a[0], dhx = b[1] - a[1], dz = d[2] - c[2], dhz = d[1] - c[1];
      const nx = -dhx / dx, nz = -dhz / dz, l = Math.hypot(nx, 1, nz);
      return [nx / l, 1 / l, nz / l];
    };
    const V = (i: number, j: number, dy = 0) => {
      const p = P(i, j), q = nrm(i, j);
      terrain.v(p[0], p[1] + dy, p[2], q[0], q[1], q[2], i / n, j / n, WHITE);
    };
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        // (00,01,10) and (10,01,11): counter-clockwise seen from above
        V(i, j); V(i, j + 1); V(i + 1, j);
        V(i + 1, j); V(i, j + 1); V(i + 1, j + 1);
      }
    const skirt = (i0: number, j0: number, i1: number, j1: number) => {
      V(i0, j0); V(i1, j1); V(i1, j1, -2.5);
      V(i0, j0); V(i1, j1, -2.5); V(i0, j0, -2.5);
    };
    for (let k = 0; k < n; k++) { skirt(k, 0, k + 1, 0); skirt(k + 1, n, k, n); skirt(0, k + 1, 0, k); skirt(n, k, n, k + 1); }
  }

  // Châteaux et gares repérés en POI sans emprise bâtiment OSM (ex. château sur colline)
  for (const cp of castlePois) {
    if (cp.used) continue;
    const y0 = H(cp.x, cp.z);
    const r: Pt[] = [[cp.x - 13, cp.z - 10], [cp.x + 13, cp.z - 10], [cp.x + 13, cp.z + 10], [cp.x - 13, cp.z + 10]];
    buildCastle(r, y0 - 1.2, 14);
  }
  for (const sp of stationPois) {
    if (sp.used) continue;
    const y0 = H(sp.x, sp.z);
    const r: Pt[] = [[sp.x - 11, sp.z - 5], [sp.x + 11, sp.z - 5], [sp.x + 11, sp.z + 5], [sp.x - 11, sp.z + 5]];
    buildStation(r, y0 - 0.8, 9.5, sp.name);
  }

  // Street names
  const nameList: string[] = [];
  const nameIdx = new Map<string, number>();
  const nameSegs: number[] = [];
  for (const n of t.names) {
    if (!n.name) continue;
    let idx = nameIdx.get(n.name);
    if (idx === undefined) {
      idx = nameList.length;
      nameList.push(n.name);
      nameIdx.set(n.name, idx);
    }
    const pts = toW(n.pts);
    for (let i = 0; i < pts.length - 1; i++) nameSegs.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], idx);
  }

  const pois: WorldPoi[] = (t.pois ?? []).map((p) => {
    const [w] = toW([p.x, p.y]);
    return { name: p.name, kind: p.kind, x: w[0], z: w[1] };
  });

  // Panneaux « GARE » sur les bâtiments ferroviaires
  const stationSignAcc = new Acc();
  let stationAtlas: ImageBitmap | null = null;
  if (stationSigns.length && typeof OffscreenCanvas !== "undefined") {
    const W_S = 512, H_S = 140;
    const cv = new OffscreenCanvas(W_S, H_S * stationSigns.length);
    const g = cv.getContext("2d")!;
    stationSigns.forEach((s, k) => {
      const y = k * H_S;
      g.fillStyle = "#14376d";
      g.fillRect(0, y, W_S, H_S);
      g.strokeStyle = "#ffffff";
      g.lineWidth = 8;
      g.strokeRect(8, y + 8, W_S - 16, H_S - 16);
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = "900 58px sans-serif";
      g.fillText("GARE", W_S / 2, y + 50);
      const sub = s.name.replace(/^gare\s*(de\s*|d')?/i, "").trim().slice(0, 26);
      if (sub) {
        g.font = "600 30px sans-serif";
        g.fillStyle = "#dbeafe";
        g.fillText(sub, W_S / 2, y + 104);
      }
      const half = s.w / 2, ph = 2.15;
      const rx = s.nz, rz = -s.nx;
      const bx = s.x - rx * half, bz = s.z - rz * half;
      const ex = s.x + rx * half, ez = s.z + rz * half;
      const vTop = k / stationSigns.length, vBot = (k + 1) / stationSigns.length;
      const n3: [number, number, number] = [s.nx, 0, s.nz];
      const addT = (p1: number[], p2: number[], p3: number[]) => {
        for (const v of [p1, p2, p3]) stationSignAcc.v(v[0], v[1], v[2], n3[0], n3[1], n3[2], v[3], v[4], WHITE);
      };
      addT([bx, s.y, bz, 0, vBot], [ex, s.y, ez, 1, vBot], [ex, s.y + ph, ez, 1, vTop]);
      addT([bx, s.y, bz, 0, vBot], [ex, s.y + ph, ez, 1, vTop], [bx, s.y + ph, bz, 0, vTop]);
    });
    try {
      stationAtlas = cv.transferToImageBitmap();
    } catch {
      stationAtlas = null; // panneau perdu, tuile conservée
    }
  }

  const places: WorldPlace[] = (t.places ?? []).map((p) => {
    const [w] = toW([p.x, p.y]);
    return { name: p.name, kind: p.kind, rank: p.rank, x: w[0], z: w[1] };
  });

  return {
    key: req.key,
    epoch: req.epoch,
    x: req.x,
    y: req.y,
    walls: walls.out(),
    groundWalls: [...ground].map(([key, a]) => ({ key, arrays: a.out() })),
    stationSigns: stationSignAcc.out(),
    stationAtlas,
    terrain: terrain.out(),
    groundImage,
    heights: ter.h,
    hSize: ter.size,
    monuments: new Float32Array(monuments),
    plainWalls: plainWalls.out(),
    roofs: roofs.out(),
    roads: Object.fromEntries(ROAD_MATS.map((m) => [m, roads[m].out()])) as Record<RoadMat, MeshArrays>,
    decks,
    trees: new Float32Array(trees),
    fpCoords: new Float32Array(fpCoords),
    fpStarts: new Int32Array(fpStarts),
    fpBoxes: new Float32Array(fpBoxes),
    nameSegs: new Float32Array(nameSegs),
    nameList,
    spawnPts: new Float32Array(spawn),
    pois,
    places,
    stats: { buildings: t.buildings.length, roads: t.roads.length, buildMs: Math.round((performance.now() - t0) * 10) / 10 },
  };
}

function transferables(b: TileBuild): Transferable[] {
  const list: ArrayBufferLike[] = [];
  const add = (m: MeshArrays) => list.push(m.pos.buffer, m.nor.buffer, m.uv.buffer, m.col.buffer);
  [b.walls, b.terrain, b.stationSigns, ...b.groundWalls.map((g) => g.arrays), b.plainWalls, b.roofs, ...ROAD_MATS.map((m) => b.roads[m])].forEach(add);
  list.push(b.heights.buffer, b.monuments.buffer, b.trees.buffer, b.fpCoords.buffer, b.fpStarts.buffer, b.fpBoxes.buffer, b.nameSegs.buffer, b.spawnPts.buffer);
  const out = list as unknown as Transferable[];
  if (b.groundImage) out.push(b.groundImage);
  if (b.stationAtlas) out.push(b.stationAtlas);
  return out;
}

ctx.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const req = e.data;
  if (req.type !== "build") return;
  try {
    const [data, ter] = await Promise.all([getTile(req.key, req.x, req.y, req.lod ?? "detail"), getTerrain(req.key, req.x, req.y)]);
    const b = build(req, data, ter);
    const reply: WorkerReply = { type: "built", build: b };
    ctx.postMessage(reply, transferables(b));
  } catch (err) {
    const reply: WorkerReply = { type: "error", key: req.key, epoch: req.epoch, message: String(err) };
    ctx.postMessage(reply);
  }
};
