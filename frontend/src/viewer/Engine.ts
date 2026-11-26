// Three.js engine: daylight scene, first-person walk + fly controls, streaming world.
import * as THREE from "three";
import { createMaterials, type Materials } from "./materials";
import { TileManager, type TileStatus } from "./TileManager";
import { lonLatToWorld, makeOrigin, tileKey, worldToLonLat } from "./geo";
import { fallbackWeather, fetchLiveWeather, type LiveWeather } from "./weather";
import { WeatherFx } from "./weatherFx";
import { OverlayLayer, type GeoJSONInput, type PinHandle, type PinOptions, type TrackHandle, type TrackOptions } from "./overlays";

export type Mode = "walk" | "fly";
export type TimeOfDay = "live" | "morning" | "noon" | "golden" | "dusk" | "night";
export type TeleportPhase = "leaving" | "loading" | "arriving" | "done";

export interface MoveEvent {
  lat: number;
  lon: number;
  heading: number;
  altitude: number;
  elevation: number;
  speedKmh: number;
  mode: Mode;
}

export interface HudState {
  lat: number;
  lon: number;
  heading: number;
  speedKmh: number;
  altitude: number;
  elevation: number;
  mode: Mode;
  street: string | null;
  poi: { name: string; kind: string; d: number } | null;
  grid: TileStatus[];
  ready: number;
  loading: number;
  queued: number;
  anticipated: number;
  buildings: number;
  fps: number;
  locked: boolean;
  tile: string;
  weatherLabel: string | null;
  isNight: boolean;
}

export interface EngineCallbacks {
  onHud: (s: HudState) => void;
  onTeleport: (phase: TeleportPhase, label: string) => void;
  onError: (msg: string) => void;
  onLockChange: (locked: boolean) => void;
}

const EYE = 1.75;
type SkyPreset = { elev: number; az: number; sun: string; sunI: number; sky: string; gnd: string; hemiI: number; top: string; horizon: string; exposure: number; lantern: number };
const TIMES: Record<Exclude<TimeOfDay, "live">, SkyPreset> = {
  morning: { elev: 22, az: 110, sun: "#fff0d8", sunI: 2.7, sky: "#c4dcf2", gnd: "#8a8466", hemiI: 1.9, top: "#5a92d4", horizon: "#d6e4ee", exposure: 1.0, lantern: 0.25 },
  noon: { elev: 58, az: 175, sun: "#ffffff", sunI: 3.0, sky: "#cfe3f7", gnd: "#8f8a6e", hemiI: 2.0, top: "#3d7dd0", horizon: "#c3dbef", exposure: 0.95, lantern: 0.2 },
  golden: { elev: 9, az: 252, sun: "#ffc386", sunI: 2.5, sky: "#f0d2b0", gnd: "#6e5a48", hemiI: 1.5, top: "#5b7fb6", horizon: "#f5c99c", exposure: 1.05, lantern: 1.2 },
  dusk: { elev: 2.5, az: 285, sun: "#ff9868", sunI: 1.3, sky: "#9a96bd", gnd: "#3f3a40", hemiI: 1.1, top: "#2b3d6a", horizon: "#e59b7c", exposure: 1.15, lantern: 3.2 },
  night: { elev: -18, az: 330, sun: "#8fb0e8", sunI: 0.35, sky: "#1a2847", gnd: "#10141c", hemiI: 0.55, top: "#050914", horizon: "#141f38", exposure: 1.05, lantern: 5.0 },
};

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private mats: Materials;
  private tiles: TileManager;
  private sun = new THREE.DirectionalLight();
  private hemi = new THREE.HemisphereLight();
  private skyDome: THREE.Mesh;
  private sunSprite: THREE.Sprite;
  private weatherFx: WeatherFx;
  private timeMode: TimeOfDay = "live";
  private liveWeather: LiveWeather | null = null;
  private weatherZone = "";
  private baseSunI = 2.7;
  private fogFactor = 1;
  private nightStrength = 0;
  private streetLights: THREE.PointLight[] = [];
  private sunDir = new THREE.Vector3();
  private container: HTMLElement;
  private cb: EngineCallbacks;
  private raf = 0;
  private clock = new THREE.Clock();
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private vel = new THREE.Vector3();
  private mode: Mode = "walk";
  private targetY = EYE; // desired height above ground (fly)
  private agl = EYE; // camera height above the real terrain
  private ground = 0; // smoothed terrain elevation under the camera
  private groundPlane!: THREE.Mesh;
  private bob = 0;
  private lastHud = 0;
  private lastStream = 0;
  private lastStreet = 0;
  private street: string | null = null;
  private poi: HudState["poi"] = null;
  private frames = 0;
  private fpsT = 0;
  private fps = 0;
  private quality = 0; // 0 = best … 4 = lightest (adaptive)
  private goodSeconds = 0;
  private busy = false;
  private anim: { from: number; to: number; t0: number; dur: number; resolve: () => void } | null = null;
  private drag: { x: number; y: number; moved: number } | null = null;
  private disposed = false;
  private cleanup: Array<() => void> = [];
  private overlays: OverlayLayer;
  private moveListeners = new Set<(e: MoveEvent) => void>();

  constructor(container: HTMLElement, cb: EngineCallbacks, start: { lat: number; lon: number }) {
    this.container = container;
    this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.dataset.testid = "threejs-viewport-canvas";
    this.renderer.domElement.style.touchAction = "none";
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.3, 14000);
    this.camera.rotation.order = "YXZ";
    this.camera.position.set(0, EYE, 0);

    this.mats = createMaterials(this.renderer.capabilities.getMaxAnisotropy());

    // Lights
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    // Sky dome + sun disc
    const skyGeo = new THREE.SphereGeometry(7000, 32, 20);
    skyGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
    this.skyDome = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.skyDome.renderOrder = -1;
    this.scene.add(this.skyDome);
    const sunCanvas = document.createElement("canvas");
    sunCanvas.width = sunCanvas.height = 128;
    const g = sunCanvas.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,245,1)");
    grad.addColorStop(0.18, "rgba(255,246,220,0.95)");
    grad.addColorStop(0.4, "rgba(255,220,170,0.25)");
    grad.addColorStop(1, "rgba(255,210,160,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const sunTex = new THREE.CanvasTexture(sunCanvas);
    sunTex.colorSpace = THREE.SRGBColorSpace;
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, fog: false, depthWrite: false, transparent: true }));
    this.sunSprite.scale.set(900, 900, 1);
    this.scene.add(this.sunSprite);

    // Ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000), this.mats.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.groundPlane = ground;
    this.scene.add(ground);

    this.scene.fog = new THREE.Fog("#c3dbef", 180, 1700);
    this.weatherFx = new WeatherFx(this.scene);
    // 6 lumières chaudes recyclées sur les lampadaires les plus proches de la caméra la nuit
    for (let i = 0; i < 6; i++) {
      const pl = new THREE.PointLight("#ffb65c", 0, 32, 1.5);
      this.scene.add(pl);
      this.streetLights.push(pl);
    }

    this.tiles = new TileManager(this.scene, this.mats, makeOrigin(start.lat, start.lon), this.renderer.capabilities.getMaxAnisotropy());
    this.tiles.onError = (m) => this.cb.onError(m);
    this.overlays = new OverlayLayer(
      this.scene,
      () => this.tiles.origin,
      (x, z) => this.tiles.heightAt(x, z) ?? this.ground,
    );
    this.tiles.onTileAttached = () => this.overlays.sync();
    this.setTimeOfDay("live");
    void this.syncLiveWeather(start.lat, start.lon);

    this.bindInput();
    this.loop();
  }

  // ---------- public API ----------
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    this.moveListeners.clear();
    this.overlays.dispose();
    this.weatherFx.dispose();
    this.tiles.dispose();
    this.mats.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Navigate to any WGS84 coordinate. */
  goTo(lat: number, lon: number, opts?: { label?: string; instant?: boolean }) {
    return this.teleport(lat, lon, opts?.label ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`, opts?.instant ?? false);
  }

  /** Place a 3D marker pin anchored to real terrain elevation. */
  addPin(opts: PinOptions): PinHandle {
    return this.overlays.addPin(opts);
  }

  removePin(id: string) {
    this.overlays.removePin(id);
  }

  clearPins() {
    this.overlays.clearPins();
  }

  /** Render a GeoJSON (LineString/MultiLineString/Feature/FeatureCollection) or GPX XML track on the terrain. */
  addTrack(input: GeoJSONInput | string, opts?: TrackOptions): TrackHandle {
    return this.overlays.addTrack(input, opts);
  }

  removeTrack(id: string) {
    this.overlays.removeTrack(id);
  }

  clearTracks() {
    this.overlays.clearTracks();
  }

  /** Subscribe to position/heading updates. Returns an unsubscribe function. */
  onMove(listener: (e: MoveEvent) => void): () => void {
    this.moveListeners.add(listener);
    return () => { this.moveListeners.delete(listener); };
  }

  lockPointer() {
    if (window.matchMedia("(pointer: fine)").matches) {
      try {
        const p = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => undefined);
      } catch {
        /* pointer lock unavailable: drag-to-look still works */
      }
    }
  }

  setVirtualKey(code: string, down: boolean) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  /** Étiquettes des villes et villages projetées à l'écran en mode survol. */
  sceneLabels(): { key: string; name: string; kind: string; x: number; y: number; major: boolean }[] {
    if (this.mode === "walk") return [];
    const p = this.camera.position;
    const wanted = this.tiles.placesNear(p.x, p.z, 6000).slice(0, 8);
    const out: { key: string; name: string; kind: string; x: number; y: number; major: boolean }[] = [];
    const v = new THREE.Vector3();
    const view = new THREE.Vector3();
    const halfW = this.renderer.domElement.clientWidth / 2;
    const halfH = this.renderer.domElement.clientHeight / 2;
    for (const item of wanted) {
      const h = this.tiles.heightAt(item.x, item.z) ?? this.ground;
      v.set(item.x, h + 30, item.z);
      if (view.copy(v).applyMatrix4(this.camera.matrixWorldInverse).z > -0.5) continue;
      v.project(this.camera);
      const sx = (v.x + 1) * halfW;
      const sy = (1 - v.y) * halfH;
      if (sx < 0 || sy < 0 || sx > halfW * 2 || sy > halfH * 2) continue;
      const major = item.rank <= 8;
      if (!item.name || out.some((o) => o.name === item.name)) continue;
      out.push({ key: `p:${item.name}`, name: item.name, kind: item.kind, x: sx, y: sy, major });
    }
    return out;
  }

  /** La commune où l'on se trouve (ville, bourg ou village le plus notable à portée),
   *  pour le panneau d'entrée d'agglomération affiché à pied. */
  placeAt(radius = 420): { name: string; kind: string; d: number } | null {
    const p = this.camera.position;
    for (const it of this.tiles.placesNear(p.x, p.z, radius)) {
      if (it.kind === "city" || it.kind === "town" || it.kind === "village") {
        return { name: it.name, kind: it.kind, d: Math.round(it.d) };
      }
    }
    return null;
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const p = this.camera.position;
    if (mode === "fly") {
      this.targetY = Math.max(this.agl, 45);
      this.pitch = Math.min(this.pitch, -0.25);
    } else {
      const inside = this.tiles.buildingAt(p.x, p.z);
      if (inside) {
        const s = this.tiles.spawnNear(p.x, p.z, 0);
        if (s) p.set(s.x, p.y, s.z);
      }
      this.targetY = EYE;
      this.pitch = 0;
    }
    this.publish(true);
  }

  /** Render stats (debug/QA): triangles and draw calls of the last frame. */
  stats() {
    const r = this.renderer.info.render;
    return { triangles: r.triangles, calls: r.calls, quality: this.quality, fps: this.fps, busy: this.busy, anim: !!this.anim, y: this.agl };
  }

  getMode() {
    return this.mode;
  }

  setTimeOfDay(t: TimeOfDay) {
    this.timeMode = t;
    if (t === "live") {
      const p = this.camera.position;
      const ll = this.tiles ? worldToLonLat(this.tiles.origin, p.x, p.z) : null;
      if (this.liveWeather) this.applyLiveAtmosphere(this.liveWeather);
      else if (ll) this.applyLiveAtmosphere(fallbackWeather(ll.lat, ll.lon));
      if (ll) void this.syncLiveWeather(ll.lat, ll.lon);
      return;
    }
    this.fogFactor = 1;
    this.weatherFx.apply(null);
    this.applySkyPreset(TIMES[t]);
    this.publish(true);
  }

  private async syncLiveWeather(lat: number, lon: number) {
    this.weatherZone = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const w = await fetchLiveWeather(lat, lon);
    if (this.disposed) return;
    this.liveWeather = w;
    if (this.timeMode === "live") {
      this.applyLiveAtmosphere(w);
      this.publish(true);
    }
  }

  private applyLiveAtmosphere(w: LiveWeather) {
    // Choisir la base lumineuse selon la hauteur réelle du soleil à cet endroit
    const base: SkyPreset = w.elev < -4 ? TIMES.night
      : w.elev < 4 ? TIMES.dusk
      : w.elev < 14 ? TIMES.golden
      : w.elev < 32 ? TIMES.morning
      : TIMES.noon;
    const overcast = w.clouds;
    const isNight = w.elev < -4;
    const cloudTop = new THREE.Color(isNight ? "#0d1322" : "#788596");
    const cloudHor = new THREE.Color(isNight ? "#161e30" : "#b8c2cc");
    const top = new THREE.Color(base.top).lerp(cloudTop, overcast * 0.78);
    const hor = new THREE.Color(base.horizon).lerp(cloudHor, overcast * 0.82);
    const sky = new THREE.Color(base.sky).lerp(cloudHor, overcast * 0.65);
    const sunCol = new THREE.Color(base.sun).lerp(new THREE.Color("#dbe2ea"), overcast * 0.6);
    const precipDim = w.precip !== "none" ? 0.75 : 1;
    const elevEff = isNight ? 28 : Math.max(2, w.elev);
    this.applySkyPreset({
      elev: elevEff,
      az: w.az,
      sun: "#" + sunCol.getHexString(),
      sunI: base.sunI * (1 - overcast * 0.65) * precipDim,
      sky: "#" + sky.getHexString(),
      gnd: base.gnd,
      hemiI: base.hemiI * (1 - overcast * 0.22) * precipDim,
      top: "#" + top.getHexString(),
      horizon: "#" + hor.getHexString(),
      exposure: base.exposure,
      lantern: base.lantern,
    }, !isNight && overcast < 0.85);
    this.fogFactor = w.foggy ? 0.25 : w.precip !== "none" ? 0.55 : 1 - overcast * 0.2;
    this.weatherFx.apply(w);
  }

  private applySkyPreset(c: SkyPreset, showSun = c.elev > -2) {
    const el = THREE.MathUtils.degToRad(Math.max(2, c.elev)), az = THREE.MathUtils.degToRad(c.az);
    // az measured from north, clockwise; north = -z, east = +x
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    this.sun.color.set(c.sun);
    this.baseSunI = c.sunI;
    this.sun.intensity = c.sunI;
    this.hemi.color.set(c.sky);
    this.hemi.groundColor.set(c.gnd);
    this.hemi.intensity = c.hemiI;
    this.renderer.toneMappingExposure = c.exposure;
    (this.scene.fog as THREE.Fog | null)?.color.set(c.horizon);
    this.scene.background = new THREE.Color(c.horizon);
    const top = new THREE.Color(c.top), hor = new THREE.Color(c.horizon), low = new THREE.Color(c.horizon).multiplyScalar(0.85);
    const pos = this.skyDome.geometry.attributes.position as THREE.BufferAttribute;
    const col = this.skyDome.geometry.attributes.color as THREE.BufferAttribute;
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i) / 7000;
      if (h >= 0) tmp.copy(hor).lerp(top, Math.pow(h, 0.55));
      else tmp.copy(hor).lerp(low, Math.min(1, -h * 4));
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
    this.sunSprite.visible = showSun;
    (this.sunSprite.material as THREE.SpriteMaterial).color.set(c.sun);
    this.nightStrength = Math.max(0, Math.min(1, (c.lantern - 0.5) / 4.2));
    if (this.tiles) this.tiles.setNightStrength(this.nightStrength);
    if (this.nightStrength <= 0.04) {
      for (const pl of this.streetLights) pl.intensity = 0;
    }
  }

  /** Fly to any French location. The view lifts off, the new area streams in, then you land on the nearest street. */
  async teleport(lat: number, lon: number, label: string, instant = false) {
    if (this.busy) return;
    this.busy = true;
    const p = this.camera.position;
    try {
      if (!instant) {
        this.cb.onTeleport("leaving", label);
        await this.tweenY(this.agl + 70, 700);
      }
      this.cb.onTeleport("loading", label);
      this.tiles.reset(makeOrigin(lat, lon));
      this.overlays.sync();
      this.vel.set(0, 0, 0);
      p.x = 0;
      p.z = 0;
      this.agl = this.mode === "fly" ? 60 : 40;
      this.tiles.update(p, this.vel, EYE, this.yaw, false);
      const { tx, ty } = this.tiles.tileAt(0, 0);
      // On attend la destination ET la couronne autour (3x3) : on n'arrive jamais dans un monde
      // vide, et rien ne vient se charger sous les pieds du spectateur. Le bouton reste en
      // « chargement » pendant ce temps.
      const attente: Promise<void>[] = [];
      for (let ax = -1; ax <= 1; ax++) {
        for (let ay = -1; ay <= 1; ay++) {
          attente.push(this.tiles.waitReady(tileKey(tx + ax, ty + ay), 26000));
        }
      }
      await Promise.race([
        Promise.all(attente).then(() => undefined),
        new Promise<void>((r) => setTimeout(r, 28000)),
      ]);
      const target = lonLatToWorld(this.tiles.origin, lat, lon);
      const inside = this.tiles.buildingAt(target.x, target.z);
      const spot = inside
        ? this.tiles.viewpointOf(target.x, target.z, inside) ?? this.tiles.spawnNear(target.x, target.z, Math.min(inside.r + 22, 80))
        : this.tiles.spawnNear(target.x, target.z, 0);
      let sx = target.x, sz = target.z;
      if (spot && Math.hypot(spot.x - target.x, spot.z - target.z) < 180) { sx = spot.x; sz = spot.z; }
      p.x = sx;
      p.z = sz;
      const dx = target.x - sx, dz = target.z - sz, d = Math.hypot(dx, dz);
      if (d > 2) this.yaw = Math.atan2(-dx, -dz);
      this.pitch = this.mode === "fly" ? -0.35 : inside ? Math.min(0.2, Math.atan2(10, Math.max(d, 1))) : 0;
      this.cb.onTeleport("arriving", label);
      const finalY = this.mode === "fly" ? 60 : EYE;
      this.targetY = finalY;
      await this.tweenY(finalY, instant ? 1600 : 1300);
    } finally {
      this.busy = false;
      this.cb.onTeleport("done", label);
      this.publish(true);
    }
  }

  // ---------- internals ----------
  private tweenY(to: number, dur: number) {
    return new Promise<void>((resolve) => {
      let fini = false;
      const done = () => {
        if (fini) return;
        fini = true;
        resolve();
      };
      this.anim = { from: this.agl, to, t0: performance.now(), dur, resolve: done };
      // Filet de sécurité : si l'animation ne se termine pas (onglet en arrière-plan, boucle
      // suspendue), la descente se clôt quand même. Sans ça, l'application restait bloquée en
      // « déplacement » : bouton d'analyse grisé et analyse automatique muette.
      window.setTimeout(done, dur + 2500);
    });
  }

  private bindInput() {
    const el = this.renderer.domElement;
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    };
    const kd = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.code === "KeyV" && !e.repeat) {
        this.setMode(this.mode === "walk" ? "fly" : "walk");
        return;
      }
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    };
    const ku = (e: KeyboardEvent) => this.keys.delete(e.code);
    const blur = () => this.keys.clear();
    const look = (dx: number, dy: number) => {
      this.yaw -= dx * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0022, -1.45, 1.45);
    };
    const mm = (e: MouseEvent) => {
      if (document.pointerLockElement === el) look(e.movementX, e.movementY);
    };
    const pd = (e: PointerEvent) => {
      this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone (synthetic or cancelled) — dragging still works without capture */
      }
    };
    const pm = (e: PointerEvent) => {
      if (!this.drag || document.pointerLockElement === el) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      look(dx * 1.6, dy * 1.6);
    };
    const pu = () => {
      if (this.drag && this.drag.moved < 4 && document.pointerLockElement !== el) this.lockPointer();
      this.drag = null;
    };
    const plc = () => this.cb.onLockChange(document.pointerLockElement === el);
    const rs = () => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    document.addEventListener("mousemove", mm);
    document.addEventListener("pointerlockchange", plc);
    el.addEventListener("pointerdown", pd);
    el.addEventListener("pointermove", pm);
    el.addEventListener("pointerup", pu);
    window.addEventListener("resize", rs);
    this.cleanup.push(() => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
      document.removeEventListener("mousemove", mm);
      document.removeEventListener("pointerlockchange", plc);
      el.removeEventListener("pointerdown", pd);
      el.removeEventListener("pointermove", pm);
      el.removeEventListener("pointerup", pu);
      window.removeEventListener("resize", rs);
      if (document.pointerLockElement === el) document.exitPointerLock();
    });
  }

  private blocked(x: number, z: number) {
    const r = 0.35;
    return (
      !!this.tiles.buildingAt(x, z) ||
      !!this.tiles.buildingAt(x + r, z) ||
      !!this.tiles.buildingAt(x - r, z) ||
      !!this.tiles.buildingAt(x, z + r) ||
      !!this.tiles.buildingAt(x, z - r)
    );
  }

  private step(dt: number) {
    const k = this.keys;
    const p = this.camera.position;
    const fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const side = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const up = (k.has("Space") || k.has("KeyE") ? 1 : 0) - (k.has("KeyC") || k.has("ControlLeft") ? 1 : 0);
    const sprint = k.has("ShiftLeft") || k.has("ShiftRight");

    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const wish = new THREE.Vector3(-sy * fwd + cy * side, 0, -cy * fwd - sy * side);
    if (wish.lengthSq() > 1) wish.normalize();
    let speed: number;
    if (this.mode === "walk") speed = sprint ? 11 : 3.2;
    else speed = (sprint ? 90 : 28) * Math.max(1, this.agl / 80);
    const target = wish.multiplyScalar(speed);
    if (this.mode === "fly") target.y = up * speed * 0.7;
    const a = 1 - Math.exp(-dt * (this.mode === "walk" ? 9 : 4));
    this.vel.lerp(target, a);

    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.agl = this.anim.from + (this.anim.to - this.anim.from) * e;
      if (t >= 1) {
        const r = this.anim.resolve;
        this.anim = null;
        r();
      }
    }
    const gt = this.tiles.heightAt(p.x, p.z);
    if (gt !== null) this.ground = Math.abs(gt - this.ground) > 50 ? gt : THREE.MathUtils.lerp(this.ground, gt, 1 - Math.exp(-dt * (this.mode === "walk" ? 12 : 3)));
    p.y = this.ground + this.agl;
    if (this.busy) return;

    const nx = p.x + this.vel.x * dt, nz = p.z + this.vel.z * dt;
    if (this.mode === "walk") {
      const stuck = this.blocked(p.x, p.z); // spawned inside a building: let the player walk out
      if (stuck || !this.blocked(nx, nz)) { p.x = nx; p.z = nz; }
      else if (!this.blocked(nx, p.z)) { p.x = nx; this.vel.z = 0; }
      else if (!this.blocked(p.x, nz)) { p.z = nz; this.vel.x = 0; }
      else this.vel.set(0, 0, 0);
      const moving = Math.hypot(this.vel.x, this.vel.z);
      this.bob += dt * moving * 2.2;
      const base = THREE.MathUtils.lerp(this.agl, EYE, 1 - Math.exp(-dt * 3));
      this.agl = Math.abs(base - EYE) < 0.05 ? EYE + Math.sin(this.bob) * 0.035 * Math.min(1, moving / 3) : base;
    } else {
      p.x = nx;
      p.z = nz;
      if (Math.abs(this.targetY - this.agl) > 0.5 && up === 0 && Math.abs(this.vel.y) < 1) {
        this.agl = THREE.MathUtils.lerp(this.agl, this.targetY, 1 - Math.exp(-dt * 2.5));
      } else {
        this.agl = THREE.MathUtils.clamp(this.agl + this.vel.y * dt, 3, 900);
        this.targetY = this.agl;
      }
    }
    p.y = this.ground + this.agl;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.step(dt);
    const p = this.camera.position;
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    // Sky, sun and shadow frustum follow the camera
    this.skyDome.position.copy(p);
    this.sunSprite.position.copy(p).addScaledVector(this.sunDir, 6000);
    const snap = 4;
    const cx = Math.round(p.x / snap) * snap, cz = Math.round(p.z / snap) * snap;
    const reach = THREE.MathUtils.clamp(this.agl * 1.2, 0, 400);
    // Le plan de fond doit rester SOUS le point le plus bas de toutes les tuiles chargées :
    // sinon, dès qu'on monte sur une colline de +25 m, il monte avec la caméra et noie toute
    // la vallée derrière soi (et cache tout ce qui est en contrebas quand on fait demi-tour).
    const floor = this.tiles.minHeight();
    this.groundPlane.position.y = (floor !== null ? Math.min(floor, this.ground) : this.ground) - 40;
    const fx = cx - Math.sin(this.yaw) * Math.min(60, reach * 0.3 + 40);
    const fz = cz - Math.cos(this.yaw) * Math.min(60, reach * 0.3 + 40);
    this.sun.target.position.set(fx, this.ground, fz);
    this.sun.position.set(fx + this.sunDir.x * 400, this.ground + this.sunDir.y * 400, fz + this.sunDir.z * 400);
    this.weatherFx.update(dt, p, this.ground);
    this.sun.intensity = this.baseSunI + this.weatherFx.flashBoost;
    const fog = this.scene.fog as THREE.Fog;
    const ff = this.fogFactor;
    if (this.mode === "fly" || this.agl > 35) {
      fog.far = THREE.MathUtils.clamp(5500 + this.agl * 12, 5500, 9500) * ff;
      fog.near = Math.min(1200 + this.agl * 4, 3000) * ff;
    } else {
      fog.far = THREE.MathUtils.clamp(1700 + this.agl * 7, 1700, 3800) * ff;
      fog.near = Math.min(220 + this.agl * 2, 900) * ff;
    }

    const now = performance.now();
    if (now - this.lastStream > 200) {
      this.lastStream = now;
      this.tiles.update(p, this.vel, this.agl, this.yaw, this.mode === "fly");
      if (this.timeMode === "live") {
        const ll = worldToLonLat(this.tiles.origin, p.x, p.z);
        const zKey = `${ll.lat.toFixed(1)},${ll.lon.toFixed(1)}`;
        if (zKey !== this.weatherZone) void this.syncLiveWeather(ll.lat, ll.lon);
      }
      if (this.nightStrength > 0.04) {
        // 1ère lumière : suit notre position (éclairage local là où on se trouve)
        const pLight = this.streetLights[0];
        if (pLight) {
          pLight.position.set(p.x, p.y + 2.8, p.z);
          pLight.intensity = 26 * this.nightStrength;
        }
        // Autres lumières : bâtiments publics les plus proches uniquement
        const nearPub = this.tiles.nearestMonuments(p.x, p.z, Math.max(0, this.streetLights.length - 1));
        const inten = 28 * this.nightStrength;
        for (let i = 1; i < this.streetLights.length; i++) {
          const pl = this.streetLights[i];
          const lp = nearPub[i - 1];
          if (lp) { pl.position.set(lp.x, lp.y, lp.z); pl.intensity = inten; }
          else pl.intensity = 0;
        }
      }
    }
    if (now - this.lastStreet > 350) {
      this.lastStreet = now;
      this.street = this.tiles.streetAt(p.x, p.z);
      const near = this.tiles.nearestPoi(p.x, p.z);
      this.poi = near ? { name: near.poi.name, kind: near.poi.kind, d: near.d } : null;
    }
    this.frames++;
    if (now - this.fpsT > 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsT));
      this.frames = 0;
      this.fpsT = now;
      this.adaptQuality();
    }
    this.publish(false);
    this.renderer.render(this.scene, this.camera);
  };

  /** Keep motion fluid on any device: trade resolution and shadows for frame rate. */
  private adaptQuality() {
    if (this.fps < 24 && this.quality < 4) {
      this.quality++;
      this.goodSeconds = 0;
    } else if (this.fps > 55 && this.quality > 0) {
      if (++this.goodSeconds >= 4) {
        this.quality--;
        this.goodSeconds = 0;
      } else return;
    } else return;
    const dpr = Math.min(window.devicePixelRatio, 1.5);
    const ratio = [dpr, Math.min(dpr, 1), Math.min(dpr, 1), 0.75, 0.5][this.quality];
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.sun.castShadow = this.quality < 2;
  }

  private publish(force: boolean) {
    const now = performance.now();
    if (!force && now - this.lastHud < 150) return;
    this.lastHud = now;
    const p = this.camera.position;
    const ll = worldToLonLat(this.tiles.origin, p.x, p.z);
    const { tx, ty } = this.tiles.tileAt(p.x, p.z);
    const c = this.tiles.counts();
    const speedKmh = Math.hypot(this.vel.x, this.vel.z) * 3.6;
    const deg = ((-THREE.MathUtils.radToDeg(this.yaw) % 360) + 360) % 360;
    this.cb.onHud({
      lat: ll.lat,
      lon: ll.lon,
      heading: deg,
      speedKmh,
      altitude: this.agl,
      elevation: this.ground,
      mode: this.mode,
      street: this.street,
      poi: this.poi,
      grid: this.tiles.grid(tx, ty),
      ...c,
      fps: this.fps,
      locked: document.pointerLockElement === this.renderer.domElement,
      tile: tileKey(tx, ty),
      weatherLabel: this.timeMode === "live" ? (this.liveWeather?.label ?? null) : null,
      isNight: this.nightStrength > 0.35,
    });
    if (this.moveListeners.size) {
      const ev: MoveEvent = {
        lat: ll.lat,
        lon: ll.lon,
        heading: deg,
        altitude: this.agl,
        elevation: this.ground,
        speedKmh,
        mode: this.mode,
      };
      this.moveListeners.forEach((fn) => fn(ev));
    }
  }
}
