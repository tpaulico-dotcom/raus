// Streams map tiles around the explorer and ANTICIPATES where they are heading:
// the 3x3 block around the player is always kept warm, and the tiles along the
// velocity vector (a few seconds ahead) are fetched and built before arrival.
import * as THREE from "three";
import type { MeshArrays, TileBuild, WorkerReply, WorldPlace, WorldPoi } from "./buildTypes";
import { ROAD_MATS } from "./buildTypes";
import type { Origin } from "./geo";
import { tileKey, worldToGlobal } from "./geo";
import { createGroundFacade, type Materials } from "./materials";
import { sampleGrid } from "./terrain";

export type TileStatus = "none" | "queued" | "anticipated" | "loading" | "ready" | "error";

const RAMP = 26; // longueur d'amorce d'un tablier (m), comme côté moteur

/** Part du tablier sous ce point : 0 hors du pont, 1 au milieu, moins sur la rampe.
 *  Le long du tablier, la hauteur suit le profil de rampe enregistré avec lui. */
function rampFactor(x: number, z: number, d: { pts: number[]; hw: number }): number {
  const reach = d.hw + 1.4;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i + 3 < d.pts.length; i += 2) {
    const l = Math.hypot(d.pts[i + 2] - d.pts[i], d.pts[i + 3] - d.pts[i + 1]);
    seg.push(l);
    total += l;
  }
  const tp = Math.min(RAMP, total / 2.6); // un pont court garde un milieu plat
  for (let i = 0, k = 0; i + 3 < d.pts.length; i += 2, k++) {
    const ax = d.pts[i], az = d.pts[i + 1], bx = d.pts[i + 2], bz = d.pts[i + 3];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) <= reach) {
      let along = seg[k] * t;
      for (let j = 0; j < k; j++) along += seg[j];
      const u = tp > 0 ? Math.min(1, Math.min(along, total - along) / tp) : 1;
      return u * u * (3 - 2 * u); // même lissage que le rendu : la marche suit la courbe
    }
  }
  return 0;
}

interface Entry {
  key: string;
  x: number;
  y: number;
  status: TileStatus;
  anticipated: boolean;
  priority: number;
  retries: number;
  retryAt: number;
  lod: "detail" | "coarse";
  trees: boolean;
  group?: THREE.Group;
  build?: TileBuild;
  minH?: number;
  bounds?: { minx: number; minz: number; maxx: number; maxz: number };
}

const coniferGeo = new THREE.ConeGeometry(1, 2.6, 7).translate(0, 1.3, 0);
const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 5).translate(0, 0.5, 0);
const poolGeo = new THREE.PlaneGeometry(13, 13);
poolGeo.rotateX(-Math.PI / 2);

function makeLampPoolTex(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  gr.addColorStop(0, "rgba(255,220,150,0.95)");
  gr.addColorStop(0.32, "rgba(255,178,86,0.48)");
  gr.addColorStop(0.7, "rgba(255,148,54,0.14)");
  gr.addColorStop(1, "rgba(255,130,40,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const CONIFER = ["#2f5a2e", "#2b4f2a", "#36622f"].map((c) => new THREE.Color(c));

function geometry(m: MeshArrays, withUv = true) {
  if (m.pos.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.nor, 3));
  if (withUv) g.setAttribute("uv", new THREE.BufferAttribute(m.uv, 2));
  g.setAttribute("color", new THREE.BufferAttribute(m.col, 3));
  g.computeBoundingSphere();
  return g;
}

export class TileManager {
  tiles = new Map<string, Entry>();
  origin: Origin;
  epoch = 0;
  private worker: Worker;
  private scene: THREE.Scene;
  private mats: Materials;
  private inflight = 0;
  private waiters = new Map<string, Array<() => void>>();
  private aniso = 8;
  private hideTrees = false;
  private groundMats = new Map<string, THREE.MeshStandardMaterial>();
  private monumentPool = new THREE.MeshBasicMaterial({ map: makeLampPoolTex(), color: "#ffd896", transparent: true, opacity: 0, visible: false, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
  onError?: (msg: string) => void;
  onTileAttached?: () => void;

  constructor(scene: THREE.Scene, mats: Materials, origin: Origin, aniso: number) {
    this.aniso = aniso;
    this.scene = scene;
    this.mats = mats;
    this.origin = origin;
    this.worker = new Worker(new URL("./tile.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onReply(e.data);
  }

  private groundMaterial(key: string): THREE.Material {
    let m = this.groundMats.get(key);
    if (m) return m;
    m = createGroundFacade(
      key === "shop"
        ? { kind: "vitrines", wall: "#d9cfbf", plinth: "#a89a88", frame: "#3b4046", sign: "#7a1f2b" }
        : { kind: "portes et fenêtres", wall: "#ffffff", plinth: "#b9a48c", frame: "#f4efe6", sign: "#7a1f2b" },
      this.aniso,
    );
    this.groundMats.set(key, m);
    return m;
  }

  /** Intensité de l'éclairage nocturne des bâtiments publics (0 = jour, 1 = nuit pleine). */
  setNightStrength(s: number) {
    const k = Math.max(0, Math.min(1, s));
    this.monumentPool.opacity = k * 0.92;
    this.monumentPool.visible = k > 0.04;
  }

  /** Retourne les N bâtiments publics les plus proches de (x, z) pour les lumières dynamiques nocturnes. */
  nearestMonuments(x: number, z: number, count: number): { x: number; y: number; z: number }[] {
    const found: { x: number; y: number; z: number; d2: number }[] = [];
    for (const b of this.near(x, z, 150)) {
      const M = b.monuments;
      for (let i = 0; i < M.length; i += 4) {
        const mx = M[i], my = M[i + 1], mz = M[i + 2];
        const d2 = (mx - x) * (mx - x) + (mz - z) * (mz - z);
        if (d2 < 140 * 140) found.push({ x: mx, y: my + 9, z: mz, d2 });
      }
    }
    found.sort((a, b) => a.d2 - b.d2);
    return found.slice(0, count);
  }

  /** Point le plus bas (m) parmi toutes les tuiles chargées, pour que le plan de fond ne noie jamais une vallée. */
  minHeight(): number | null {
    let m = Infinity;
    for (const e of this.tiles.values()) {
      if (e.minH !== undefined && e.minH < m) m = e.minH;
    }
    return Number.isFinite(m) ? m : null;
  }

  /** Real ground elevation (m) under a world point, or null when that tile is not loaded yet. */
  heightAt(x: number, z: number): number | null {
    const g = worldToGlobal(this.origin, x, z);
    const e = this.tiles.get(tileKey(Math.floor(g.gx), Math.floor(g.gy)));
    if (!e?.build) return null;
    const lx = g.gx - e.x, lz = g.gy - e.y; // unités de tuile (ce qu'attend la grille de relief)
    const base = sampleGrid(e.build.heights, e.build.hSize, lx, lz);
    // Sur un pont, on marche sur le tablier — pas au niveau de la rivière en dessous. Les tabliers
    // sont exprimés en mètres depuis le bord de la tuile, comme le relief l'est en unités de tuile.
    const mx = lx * this.origin.mpt, mz = lz * this.origin.mpt;
    for (const d of e.build.decks ?? []) {
      const k = rampFactor(mx, mz, d);
      if (k > 0) return base * (1 - k) + ((d.base ?? base) + d.y) * k; // plate entre les culées
    }
    return base;
  }

  dispose() {
    for (const m of this.groundMats.values()) { m.map?.dispose(); m.dispose(); }
    this.monumentPool.map?.dispose();
    this.monumentPool.dispose();
    this.worker.terminate();
    for (const e of this.tiles.values()) this.unload(e);
    this.tiles.clear();
  }

  reset(origin: Origin) {
    for (const e of this.tiles.values()) this.unload(e);
    this.tiles.clear();
    this.inflight = 0;
    this.epoch++;
    this.origin = origin;
  }

  tileAt(x: number, z: number) {
    const g = worldToGlobal(this.origin, x, z);
    return { tx: Math.floor(g.gx), ty: Math.floor(g.gy) };
  }

  /** Called a few times per second with the explorer's position, velocity (m/s), altitude, gaze (yaw) and fly flag. */
  update(pos: THREE.Vector3, vel: THREE.Vector3, altitude: number, yaw = 0, fly = false) {
    const now = performance.now();
    const { tx, ty } = this.tileAt(pos.x, pos.z);
    // Le mode survol démarre à 45 m : se fier à altitude > 160 bloquait le rayon à 1 tuile (~1,6 km).
    // En survol (ou en altitude), on porte à 4 tuiles devant (~6,5 km), 2 sur les côtés,
    // tout en gardant TOUJOURS les 9 tuiles immédiates (ring <= 1) intactes autour de soi.
    const isFly = fly || altitude > 35;
    // En survol, les arbres des forêts RESTENT : sans eux la forêt devient une plaque verte
    // plate. Ils sont construits sans tronc et plus serrés ; les arbres de ville, eux, ne sont
    // plus semés du tout (BuildRequest.trees = false). On ne masque donc plus rien au décollage.
    if (isFly !== this.hideTrees) this.hideTrees = isFly;
    // Le rayon de préchargement suit l'altitude : à 45 m en survol on ne voit pas à 6 km, et
    // charger 40 tuiles détaillées pour rien bloquait l'arrivée sur une grande ville.
    const radius = !isFly ? 1 : altitude > 400 ? 4 : altitude > 150 ? 2 : 1;
    const want = new Map<string, { x: number; y: number; pr: number; ant: boolean; lod: "detail" | "coarse"; trees: boolean }>();
    const mpt = this.origin.mpt;
    const capSur = Number.isFinite(yaw) ? yaw : 0;
    const fx = -Math.sin(capSur), fz = -Math.cos(capSur);
    const consider = (x: number, y: number, anticipated: boolean, bias: number) => {
      const k = tileKey(x, y);
      const g = worldToGlobal(this.origin, pos.x, pos.z);
      const dx = (x + 0.5 - g.gx) * mpt;
      const dz = (y + 0.5 - g.gy) * mpt;
      const dist = Math.hypot(dx, dz);
      const along = dist > 1 ? (dx * fx + dz * fz) / dist : 0;
      const ring = Math.max(Math.abs(x - tx), Math.abs(y - ty));
      if (!anticipated && ring > 1) {
        const maxRing = along > 0.25 ? radius : along > -0.25 ? 2 : 1;
        if (ring > maxRing) return;
      }
      const pr = dist - along * mpt * 2.0 + bias;
      // Au-delà de 3 km à la ronde : tuile allégée, plus 1 km de détail supplémentaire droit
      // devant (le regard porte loin). Les bâtiments restent dans les deux cas ; on retire le
      // travail fin (murs < 40 m², églises, sol 2048, arbres, cimetières, panneaux), invisible
      // à cette distance mais qui coûtait 3,5 s et 870 Ko par tuile.
      const lim = 3000 + 1000 * Math.max(0, along);
      const lod: "detail" | "coarse" = dist > lim ? "coarse" : "detail";
      const prev = want.get(k);
      if (!prev || pr < prev.pr) want.set(k, { x, y, pr, ant: anticipated && !(prev && !prev.ant), lod, trees: !isFly });
    };
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) consider(tx + dx, ty + dy, false, 0);

    // Anticipation : on ne préchauffe que la rangée de tuiles droit devant. Deux projections
    // à 3×3 chacune finissaient par charger 16 zones, soit une ville entière, alors qu'on ne
    // se déplace pas plus vite que le chargement : ça ne servait à rien.
    const speed = Math.hypot(vel.x, vel.z);
    // En mouvement on anticipe la trajectoire ; à l'arrêt (ou presque) on anticipe le regard,
    // sinon tourner la tête en survol ne préparait jamais rien.
    const bouge = speed > 0.6;
    if (bouge || isFly) {
      const horizon = bouge ? Math.min(25, 8 + speed * 0.6) : 25;
      const dirx = bouge ? vel.x / speed : fx, dirz = bouge ? vel.z / speed : fz;
      const a = this.tileAt(pos.x + dirx * horizon * 0.8, pos.z + dirz * horizon * 0.8);
      for (let dx = -1; dx <= 1; dx++) {
        const x = a.tx + dx, y = a.ty;
        if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) <= radius) continue;
        consider(x, y, true, -200);
      }
    }

    for (const [k, w] of want) {
      let e = this.tiles.get(k);
      if (!e) {
        e = { key: k, x: w.x, y: w.y, status: w.ant ? "anticipated" : "queued", anticipated: w.ant, priority: w.pr, retries: 0, retryAt: 0, lod: w.lod, trees: w.trees };
        this.tiles.set(k, e);
      } else {
        e.priority = w.pr;
        if (e.status === "error" && now > e.retryAt && e.retries < 4) e.status = "queued";
        // Changement de niveau de détail : on reconstruit la tuile (le bâti apparaît ou
        // disparaît). Jamais pendant qu'elle se construit, sinon on jette son travail.
        if (e.lod !== w.lod && e.status !== "loading") {
          e.lod = w.lod;
          e.status = "queued";
          e.retries = 0;
        }
        // Retour au sol : les tuiles construites en survol n'ont pas d'arbres, on les refait.
        // L'inverse (décoller) ne reconstruit rien : on masque les arbres existants.
        if (w.trees && !e.trees && e.status !== "loading") {
          e.trees = true;
          e.status = "queued";
        }
      }
    }

    // Unload tiles well outside the warm zone (with hysteresis so we never thrash at borders)
    for (const e of [...this.tiles.values()]) {
      const d = Math.max(Math.abs(e.x - tx), Math.abs(e.y - ty));
      // Hystérésis : on ne décharge qu'une rangée après la limite de chargement, sinon
      // reculer d'un cran efface tout ce qu'on vient de voir.
      if (!want.has(e.key) && d > radius + 2 && e.status !== "loading") {
        this.unload(e);
        this.tiles.delete(e.key);
      } else if (!want.has(e.key) && (e.status === "queued" || e.status === "anticipated")) {
        this.unload(e);
        this.tiles.delete(e.key);
      }
    }

    // Dispatch by priority
    const queue = [...this.tiles.values()]
      .filter((e) => e.status === "queued" || e.status === "anticipated")
      .sort((a, b) => a.priority - b.priority);
    while (this.inflight < 4 && queue.length) {
      const e = queue.shift()!;
      e.status = "loading";
      this.inflight++;
      this.worker.postMessage({ type: "build", key: e.key, x: e.x, y: e.y, epoch: this.epoch, origin: { gx0: this.origin.gx0, gy0: this.origin.gy0, mpt }, lod: e.lod, trees: e.trees });
    }
  }

  waitReady(key: string, timeoutMs: number): Promise<void> {
    const e = this.tiles.get(key);
    if (e && (e.status === "ready" || e.status === "error")) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push(resolve);
      this.waiters.set(key, list);
      setTimeout(resolve, timeoutMs);
    });
  }

  private release(key: string) {
    this.waiters.get(key)?.forEach((r) => r());
    this.waiters.delete(key);
  }

  private onReply(msg: WorkerReply) {
    const epoch = msg.type === "built" ? msg.build.epoch : msg.epoch;
    if (epoch !== this.epoch) return;
    this.inflight = Math.max(0, this.inflight - 1);
    const key = msg.type === "built" ? msg.build.key : msg.key;
    const e = this.tiles.get(key);
    if (!e) return;
    if (msg.type === "error") {
      e.status = "error";
      e.retries++;
      e.retryAt = performance.now() + 4000 * e.retries;
      if (e.retries === 1) this.onError?.("Une zone cartographique n'a pas pu être chargée, nouvel essai en cours…");
      this.release(key);
      return;
    }
    this.unload(e); // background restyle: swap the old meshes for the new ones
    this.attach(e, msg.build);
    e.status = "ready";
    this.release(key);
  }

  private attach(e: Entry, b: TileBuild) {
    let m = Infinity;
    for (let i = 0; i < b.heights.length; i++) if (b.heights[i] < m) m = b.heights[i];
    e.minH = Number.isFinite(m) ? m : undefined;
    const g = new THREE.Group();
    g.name = e.key;
    const add = (arr: MeshArrays, mat: THREE.Material, cast: boolean, uv = true) => {
      const geo = geometry(arr, uv);
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
    };
    // Terrain with this tile's painted land cover
    const tgeo = geometry(b.terrain);
    if (tgeo) {
      let tmat: THREE.MeshStandardMaterial;
      if (b.groundImage) {
        const tx = new THREE.Texture(b.groundImage);
        tx.flipY = false;
        tx.colorSpace = THREE.SRGBColorSpace;
        tx.anisotropy = this.aniso;
        tx.needsUpdate = true;
        tmat = new THREE.MeshStandardMaterial({ map: tx, roughness: 1 });
      } else tmat = new THREE.MeshStandardMaterial({ color: "#97a771", roughness: 1 });
      const tm = new THREE.Mesh(tgeo, tmat);
      tm.name = "terrain";
      tm.receiveShadow = true;
      tm.userData.own = true;
      tm.matrixAutoUpdate = false;
      g.add(tm);
    }
    for (const m of ROAD_MATS) add(b.roads[m], this.mats.roads[m], false);
    add(b.walls, this.mats.walls, true);
    for (const w of b.groundWalls) add(w.arrays, this.groundMaterial(w.key), true);
    if (b.stationAtlas && b.stationSigns.pos.length) {
      const geo = geometry(b.stationSigns);
      if (geo) {
        const tx = new THREE.Texture(b.stationAtlas);
        tx.flipY = false;
        tx.colorSpace = THREE.SRGBColorSpace;
        tx.anisotropy = this.aniso;
        tx.needsUpdate = true;
        const sm = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tx, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        sm.userData.own = true;
        sm.matrixAutoUpdate = false;
        g.add(sm);
      }
    }

    add(b.plainWalls, this.mats.stone, true);
    add(b.roofs, this.mats.roofs, true, false);

    const n = b.trees.length / 6;
    if (n > 0) {
      // Un seul type d'arbre : le sapin. Deux essences coûtaient un InstancedMesh de plus par
      // tuile (matrices + couleurs) pour un détail invisible à distance en survol.
      // En survol on ne construit pas les troncs : invisible d'en haut, un InstancedMesh de
      // moins par tuile sur les 40 tuiles de la couronne.
      const withTrunk = !this.hideTrees;
      const trunks = withTrunk ? new THREE.InstancedMesh(trunkGeo, this.mats.trunk, n) : null;
      const conifer = new THREE.InstancedMesh(coniferGeo, this.mats.leaves, n);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      if (trunks) {
        for (let i = 0; i < n; i++) {
          const x = b.trees[i * 6], y = b.trees[i * 6 + 1], z = b.trees[i * 6 + 2], sc = b.trees[i * 6 + 3];
          m4.compose(p.set(x, y, z), q.identity(), s.set(sc, 4 * sc, sc));
          trunks.setMatrixAt(i, m4);
        }
      }
      for (let i = 0; i < n; i++) {
        const x = b.trees[i * 6], y = b.trees[i * 6 + 1], z = b.trees[i * 6 + 2], sc = b.trees[i * 6 + 3] * 2.6, sh = b.trees[i * 6 + 5];
        m4.compose(p.set(x, y + 1.5 * (sc / 2.6), z), q.identity(), s.set(sc, sc * 1.6, sc));
        conifer.setMatrixAt(i, m4);
        conifer.setColorAt(i, CONIFER[Math.floor(sh * CONIFER.length)]);
      }
      conifer.count = n;
      for (const im of trunks ? [trunks, conifer] : [conifer]) {
        // Pas d'ombre portée : c'était la vraie dépense GPU des arbres (passes d'ombre par tuile).
        im.castShadow = false;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        im.userData.tree = true;
        g.add(im);
      }
    }

    // Éclairage nocturne uniquement sur les bâtiments publics (églises, châteaux, mairies, gares, écoles…)
    const nm = Math.floor(b.monuments.length / 4);
    if (nm > 0) {
      const mPools = new THREE.InstancedMesh(poolGeo, this.monumentPool, nm);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pt = new THREE.Vector3();
      for (let i = 0; i < nm; i++) {
        const mx = b.monuments[i * 4], my = b.monuments[i * 4 + 1], mz = b.monuments[i * 4 + 2], rad = b.monuments[i * 4 + 3];
        const k = rad / 6.5;
        m4.compose(pt.set(mx, my + 0.15, mz), q, sc.set(k, 1, k));
        mPools.setMatrixAt(i, m4);
      }
      mPools.computeBoundingSphere();
      mPools.renderOrder = 3;
      g.add(mPools);
    }
    const o = this.origin;
    e.bounds = {
      minx: (e.x - o.gx0) * o.mpt, minz: (e.y - o.gy0) * o.mpt,
      maxx: (e.x + 1 - o.gx0) * o.mpt, maxz: (e.y + 1 - o.gy0) * o.mpt,
    };
    e.group = g;
    e.build = b;
    this.stitchEdges(e);
    this.scene.add(g);
    this.onTileAttached?.();
  }

  /** Soude les bords du maillage terrain avec les 4 tuiles voisines déjà chargées (0,00 m de marche). */
  private stitchEdges(e: Entry) {
    const b = e.build;
    const mesh = e.group?.getObjectByName("terrain") as THREE.Mesh | undefined;
    if (!b || !mesh) return;
    const s = b.hSize, n = s - 1;
    if (s < 2) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const arr = pos.array as Float32Array;
    let changed = false;

    const syncEdge = (nx: number, ny: number, edge: "W" | "E" | "N" | "S") => {
      const nb = this.tiles.get(tileKey(nx, ny))?.build;
      if (!nb || nb.hSize !== s) return;
      for (let k = 0; k < s; k++) {
        const myIdx = edge === "W" ? k * s : edge === "E" ? k * s + n : edge === "N" ? k : n * s + k;
        const nbIdx = edge === "W" ? k * s + n : edge === "E" ? k * s : edge === "N" ? n * s + k : k;
        const h = nb.heights[nbIdx];
        if (Math.abs(b.heights[myIdx] - h) > 1e-4) {
          b.heights[myIdx] = h;
          changed = true;
        }
      }
    };
    syncEdge(e.x - 1, e.y, "W");
    syncEdge(e.x + 1, e.y, "E");
    syncEdge(e.x, e.y - 1, "N");
    syncEdge(e.x, e.y + 1, "S");
    if (!changed) return;

    // Met à jour les sommets de bord de la grille (cellules 0..n-1, 6 sommets par cellule)
    const setCell = (i: number, j: number) => {
      const base = (j * n + i) * 18;
      const h00 = b.heights[j * s + i], h01 = b.heights[(j + 1) * s + i];
      const h10 = b.heights[j * s + i + 1], h11 = b.heights[(j + 1) * s + i + 1];
      arr[base + 1] = h00; arr[base + 4] = h01; arr[base + 7] = h10;
      arr[base + 10] = h10; arr[base + 13] = h01; arr[base + 16] = h11;
    };
    for (let k = 0; k < n; k++) {
      setCell(k, 0); setCell(k, n - 1);
      setCell(0, k); setCell(n - 1, k);
    }
    pos.needsUpdate = true;
  }

  private unload(e: Entry) {
    if (!e.group) return;
    this.scene.remove(e.group);
    e.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      else if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        if (o.userData.own) {
          const m = o.material as THREE.MeshStandardMaterial;
          (m.map?.image as ImageBitmap | undefined)?.close?.();
          m.map?.dispose();
          m.dispose();
        }
      }
    });
    e.group = undefined;
    e.build = undefined;
  }

  private near(x: number, z: number, pad: number) {
    const out: TileBuild[] = [];
    for (const e of this.tiles.values()) {
      if (!e.build || !e.bounds) continue;
      const b = e.bounds;
      if (x >= b.minx - pad && x <= b.maxx + pad && z >= b.minz - pad && z <= b.maxz + pad) out.push(e.build);
    }
    return out;
  }

  /** Index of the building footprint containing (x,z), or null. Returns its bounding box radius. */
  buildingAt(x: number, z: number): { r: number; cx: number; cz: number } | null {
    for (const b of this.near(x, z, 80)) {
      const nb = b.fpBoxes.length / 4;
      for (let i = 0; i < nb; i++) {
        const minx = b.fpBoxes[i * 4], minz = b.fpBoxes[i * 4 + 1], maxx = b.fpBoxes[i * 4 + 2], maxz = b.fpBoxes[i * 4 + 3];
        if (x < minx || x > maxx || z < minz || z > maxz) continue;
        const s = b.fpStarts[i], end = b.fpStarts[i + 1];
        let inside = false;
        for (let a = s, c = end - 1; a < end; c = a++) {
          const xi = b.fpCoords[a * 2], zi = b.fpCoords[a * 2 + 1], xj = b.fpCoords[c * 2], zj = b.fpCoords[c * 2 + 1];
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
        if (inside) return { r: Math.hypot(maxx - minx, maxz - minz) / 2, cx: (minx + maxx) / 2, cz: (minz + maxz) / 2 };
      }
    }
    return null;
  }

  /** Vrai si un tronc se trouve à moins de 0,6 m : en forêt on slalome entre les arbres. */
  trunkAt(x: number, z: number): boolean {
    for (const b of this.near(x, z, 8)) {
      const t = b.trees, n = t.length / 6;
      for (let i = 0; i < n; i++) {
        const dx = x - t[i * 6], dz = z - t[i * 6 + 2];
        if (dx * dx + dz * dz < 0.36) return true;
      }
    }
    return false;
  }

  streetAt(x: number, z: number): string | null {
    let best = 28, name: string | null = null;
    for (const b of this.near(x, z, 30)) {
      const s = b.nameSegs;
      for (let i = 0; i < s.length; i += 5) {
        const ax = s[i], az = s[i + 1], bx = s[i + 2], bz = s[i + 3];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        if (d < best) { best = d; name = b.nameList[s[i + 4]]; }
      }
    }
    return name;
  }

  nearestPoi(x: number, z: number): { poi: WorldPoi; d: number } | null {
    let best: { poi: WorldPoi; d: number } | null = null;
    for (const b of this.near(x, z, 150)) {
      for (const p of b.pois) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < 150 && (!best || d < best.d)) best = { poi: p, d };
      }
    }
    return best;
  }

  /** Villes et villages proches, pour les étiquettes affichées en vue aérienne. */
  placesNear(x: number, z: number, radius: number): (WorldPlace & { d: number })[] {
    const out: (WorldPlace & { d: number })[] = [];
    for (const b of this.near(x, z, radius)) {
      for (const p of b.places ?? []) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= radius) out.push({ ...p, d });
      }
    }
    // les lieux les plus notables d'abord (rank 1 = métropole), puis les plus proches
    out.sort((a, c) => a.rank - c.rank || a.d - c.d);
    return out;
  }

  /** A street point 15–120 m from a building with a clear line of sight to it (no other house in between). */
  viewpointOf(x: number, z: number, target: { cx: number; cz: number; r: number }): { x: number; z: number } | null {
    const cands: { x: number; z: number; d: number }[] = [];
    for (const b of this.near(x, z, 200)) {
      const s = b.spawnPts;
      for (let i = 0; i < s.length; i += 2) {
        const d = Math.hypot(s[i] - x, s[i + 1] - z);
        if (d >= target.r + 12 && d <= target.r + 120) cands.push({ x: s[i], z: s[i + 1], d });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    let tested = 0;
    for (const c of cands) {
      if (this.buildingAt(c.x, c.z)) continue;
      if (++tested > 60) break;
      const steps = Math.ceil(c.d / 2);
      let clear = true;
      for (let k = 1; k < steps; k++) {
        const px = c.x + ((x - c.x) * k) / steps, pz = c.z + ((z - c.z) * k) / steps;
        const hit = this.buildingAt(px, pz);
        if (!hit) continue;
        if (Math.abs(hit.cx - target.cx) < 0.01 && Math.abs(hit.cz - target.cz) < 0.01) break; // reached the target
        clear = false;
        break;
      }
      if (clear) return { x: c.x, z: c.z };
    }
    return null;
  }

  /** A walkable street point near (x,z), at least `minD` metres away. */
  spawnNear(x: number, z: number, minD: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null, bd = Infinity;
    for (const b of this.near(x, z, 200)) {
      const s = b.spawnPts;
      for (let i = 0; i < s.length; i += 2) {
        const d = Math.hypot(s[i] - x, s[i + 1] - z);
        if (d >= minD && d < bd && !this.buildingAt(s[i], s[i + 1])) { bd = d; best = { x: s[i], z: s[i + 1] }; }
      }
    }
    return best;
  }

  grid(cx: number, cy: number, r = 2): TileStatus[] {
    const out: TileStatus[] = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const e = this.tiles.get(tileKey(cx + dx, cy + dy));
        out.push(e ? (e.status === "loading" && e.anticipated ? "anticipated" : e.status) : "none");
      }
    return out;
  }

  counts() {
    let ready = 0, loading = 0, queued = 0, anticipated = 0, buildings = 0;
    for (const e of this.tiles.values()) {
      if (e.status === "ready") { ready++; buildings += e.build?.stats.buildings ?? 0; }
      else if (e.status === "loading") loading++;
      else if (e.status === "queued") queued++;
      if (e.anticipated && e.status !== "ready" && e.status !== "error") anticipated++;
    }
    return { ready, loading, queued, anticipated, buildings };
  }
}
