/** Effets météo 3D autour de la caméra : nuages qui dérivent au vent, pluie, neige et éclairs. */
import * as THREE from "three";
import type { LiveWeather, PrecipKind } from "./weather";

const CLOUD_COUNT = 34;
const CLOUD_SPAN = 4200;
const RAIN_COUNT = 900;
const SNOW_COUNT = 850;
const PRECIP_BOX = 55;
const PRECIP_H = 34;

function makeSoftTex(inner: string, mid: string): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, inner);
  gr.addColorStop(0.45, mid);
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class WeatherFx {
  private group = new THREE.Group();
  private clouds: { sprite: THREE.Sprite; ox: number; oy: number; oz: number }[] = [];
  private cloudMat: THREE.SpriteMaterial;
  private rainLines: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainMat: THREE.LineBasicMaterial;
  private snowPts: THREE.Points;
  private snowPos: Float32Array;
  private snowMat: THREE.PointsMaterial;
  private snowPhase: Float32Array;

  private precip: PrecipKind = "none";
  private intensity = 0;
  private windX = 0;
  private windZ = 0;
  private storm = false;
  private flashTimer = 4;
  public flashBoost = 0;

  constructor(scene: THREE.Scene) {
    // 1) Nuages 3D en haute altitude
    const cloudTex = makeSoftTex("rgba(255,255,255,0.88)", "rgba(240,244,250,0.42)");
    this.cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.3, depthWrite: false, fog: true });
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const sp = new THREE.Sprite(this.cloudMat);
      const ox = (Math.random() - 0.5) * CLOUD_SPAN;
      const oz = (Math.random() - 0.5) * CLOUD_SPAN;
      const oy = 320 + Math.random() * 260;
      const w = 420 + Math.random() * 520;
      sp.scale.set(w, w * (0.34 + Math.random() * 0.16), 1);
      this.group.add(sp);
      this.clouds.push({ sprite: sp, ox, oy, oz });
    }

    // 2) Pluie 3D (segments fins penchés par le vent)
    this.rainPos = new Float32Array(RAIN_COUNT * 6);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (Math.random() - 0.5) * PRECIP_BOX;
      const y = Math.random() * PRECIP_H;
      const z = (Math.random() - 0.5) * PRECIP_BOX;
      this.rainPos[i * 6] = x; this.rainPos[i * 6 + 1] = y; this.rainPos[i * 6 + 2] = z;
      this.rainPos[i * 6 + 3] = x; this.rainPos[i * 6 + 4] = y - 1.1; this.rainPos[i * 6 + 5] = z;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute("position", new THREE.BufferAttribute(this.rainPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: "#c8dcf0", transparent: true, opacity: 0.55, depthWrite: false });
    this.rainLines = new THREE.LineSegments(rainGeo, this.rainMat);
    this.rainLines.frustumCulled = false;
    this.rainLines.visible = false;
    this.group.add(this.rainLines);

    // 3) Neige 3D (flocons qui dérivent doucement au vent)
    this.snowPos = new Float32Array(SNOW_COUNT * 3);
    this.snowPhase = new Float32Array(SNOW_COUNT);
    for (let i = 0; i < SNOW_COUNT; i++) {
      this.snowPos[i * 3] = (Math.random() - 0.5) * PRECIP_BOX;
      this.snowPos[i * 3 + 1] = Math.random() * PRECIP_H;
      this.snowPos[i * 3 + 2] = (Math.random() - 0.5) * PRECIP_BOX;
      this.snowPhase[i] = Math.random() * Math.PI * 2;
    }
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute("position", new THREE.BufferAttribute(this.snowPos, 3));
    const snowTex = makeSoftTex("rgba(255,255,255,1)", "rgba(240,248,255,0.6)");
    this.snowMat = new THREE.PointsMaterial({ map: snowTex, size: 0.34, transparent: true, opacity: 0.85, depthWrite: false });
    this.snowPts = new THREE.Points(snowGeo, this.snowMat);
    this.snowPts.frustumCulled = false;
    this.snowPts.visible = false;
    this.group.add(this.snowPts);

    scene.add(this.group);
  }

  apply(w: LiveWeather | null) {
    if (!w) {
      this.precip = "none";
      this.intensity = 0;
      this.storm = false;
      this.cloudMat.opacity = 0.22;
      this.cloudMat.color.set("#ffffff");
      this.rainLines.visible = false;
      this.snowPts.visible = false;
      this.windX = 3; this.windZ = 1.5;
      return;
    }
    this.precip = w.precip;
    this.intensity = w.precipIntensity;
    this.storm = w.storm;
    // Direction vers laquelle souffle le vent (windDir = d'où il vient, 0 = Nord = -Z)
    const dirRad = ((w.windDir + 180) * Math.PI) / 180;
    const ms = Math.min(28, w.windSpeed / 3.6);
    this.windX = Math.sin(dirRad) * ms;
    this.windZ = -Math.cos(dirRad) * ms;

    // Nuages : densité et teinte selon jour/nuit et couverture
    const dark = w.elev < -2 ? 0.22 : w.elev < 8 ? 0.62 : 1;
    const grey = 1 - w.clouds * 0.28;
    this.cloudMat.color.setRGB(dark * grey, dark * grey, dark * (grey + 0.03));
    this.cloudMat.opacity = Math.max(0.05, Math.min(0.88, w.clouds * 0.85));

    this.rainLines.visible = w.precip === "rain";
    this.rainMat.opacity = 0.32 + w.precipIntensity * 0.4;
    this.snowPts.visible = w.precip === "snow";
    this.snowMat.opacity = 0.55 + w.precipIntensity * 0.35;
  }

  update(dt: number, cam: THREE.Vector3, groundY: number) {
    // 1) Dérive des nuages avec le vent
    const half = CLOUD_SPAN / 2;
    const driftX = this.windX * 4.5 * dt;
    const driftZ = this.windZ * 4.5 * dt;
    for (const c of this.clouds) {
      c.ox += driftX;
      c.oz += driftZ;
      if (c.ox > half) c.ox -= CLOUD_SPAN; else if (c.ox < -half) c.ox += CLOUD_SPAN;
      if (c.oz > half) c.oz -= CLOUD_SPAN; else if (c.oz < -half) c.oz += CLOUD_SPAN;
      c.sprite.position.set(cam.x + c.ox, Math.max(groundY + 260, cam.y + c.oy * 0.6), cam.z + c.oz);
    }

    // 2) Pluie autour de la caméra
    if (this.precip === "rain") {
      const halfB = PRECIP_BOX / 2;
      const fall = (22 + this.intensity * 14) * dt;
      const wx = this.windX * 0.35, wz = this.windZ * 0.35;
      const len = 0.9 + this.intensity * 0.6;
      const pos = this.rainPos;
      for (let i = 0; i < RAIN_COUNT; i++) {
        let x = pos[i * 6] + wx * dt;
        let y = pos[i * 6 + 1] - fall;
        let z = pos[i * 6 + 2] + wz * dt;
        if (y < -6) { y += PRECIP_H; x = (Math.random() - 0.5) * PRECIP_BOX; z = (Math.random() - 0.5) * PRECIP_BOX; }
        if (x > halfB) x -= PRECIP_BOX; else if (x < -halfB) x += PRECIP_BOX;
        if (z > halfB) z -= PRECIP_BOX; else if (z < -halfB) z += PRECIP_BOX;
        pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
        pos[i * 6 + 3] = x + wx * 0.05; pos[i * 6 + 4] = y - len; pos[i * 6 + 5] = z + wz * 0.05;
      }
      this.rainLines.position.set(cam.x, cam.y - 6, cam.z);
      (this.rainLines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // 3) Neige autour de la caméra
    if (this.precip === "snow") {
      const halfB = PRECIP_BOX / 2;
      const fall = (2.2 + this.intensity * 1.8) * dt;
      const wx = this.windX * 0.22, wz = this.windZ * 0.22;
      const tNow = performance.now() * 0.0012;
      const pos = this.snowPos;
      for (let i = 0; i < SNOW_COUNT; i++) {
        const ph = this.snowPhase[i];
        let x = pos[i * 3] + (wx + Math.sin(tNow + ph) * 0.7) * dt;
        let y = pos[i * 3 + 1] - fall;
        let z = pos[i * 3 + 2] + (wz + Math.cos(tNow * 0.8 + ph) * 0.7) * dt;
        if (y < -6) { y += PRECIP_H; x = (Math.random() - 0.5) * PRECIP_BOX; z = (Math.random() - 0.5) * PRECIP_BOX; }
        if (x > halfB) x -= PRECIP_BOX; else if (x < -halfB) x += PRECIP_BOX;
        if (z > halfB) z -= PRECIP_BOX; else if (z < -halfB) z += PRECIP_BOX;
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      }
      this.snowPts.position.set(cam.x, cam.y - 6, cam.z);
      (this.snowPts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // 4) Éclairs en cas d'orage
    if (this.storm) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.flashBoost = 2.4;
        this.flashTimer = 5 + Math.random() * 11;
      }
    }
    if (this.flashBoost > 0) this.flashBoost = Math.max(0, this.flashBoost - dt * 9);
  }

  dispose() {
    this.cloudMat.map?.dispose();
    this.cloudMat.dispose();
    this.rainLines.geometry.dispose();
    this.rainMat.dispose();
    this.snowPts.geometry.dispose();
    this.snowMat.map?.dispose();
    this.snowMat.dispose();
  }
}
