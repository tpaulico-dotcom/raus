import { useEffect, useRef, useState } from "react";

/** Mini-plan GPS circulaire (160×160), orienté selon le cap, boussole N, thème auto jour/nuit.
 *  - Mode piéton : routes/rues/chemins/rivières + noms des rues principales.
 *  - Mode survol : tuiles régionales z=9 (10–80 km selon zoom) avec grands axes + noms des villes voisines. */
export type Hud = { lat: number; lon: number; heading: number } | null;

const EXTENT = 4096;
const Z_WALK = 14;
const Z_FLY = 9;
const M_PER_UNIT_WALK = 40075016.686 / Math.pow(2, Z_WALK) / EXTENT;
const M_PER_UNIT_FLY = 40075016.686 / Math.pow(2, Z_FLY) / EXTENT;

type Tuile = {
  z: number; x: number; y: number;
  roads?: { kind?: string; pts: number[] }[];
  waterways?: { kind?: string; pts?: number[] }[];
  names?: { kind?: string; name?: string | null; pts: number[] }[];
  places?: { name: string; kind: string; x: number; y: number; rank?: number }[];
  /** Zones (mer, grands lacs) : anneaux en unités de tuile, à remplir en bleu. */
  areas?: { kind?: string; rings: number[][] }[];
};

const ROAD_RANK: Record<string, number> = {
  path: 0, track: 0, pedestrian: 1, rail: 1, service: 2, minor: 3,
  tertiary: 4, secondary: 5, primary: 6, trunk: 7, motorway: 8,
};

function tuileDe(lat: number, lon: number, z: number) {
  const n = Math.pow(2, z);
  const fx = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x: Math.floor(fx), y: Math.floor(fy), dx: (fx % 1) * EXTENT, dy: (fy % 1) * EXTENT };
}

export default function Plan2D({ hud, large = false, night = false }: { hud: Hud; large?: boolean; night?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // px par mètre : piéton ~0.65 (~250 m de diamètre) ; survol ~0.008 (~20 km de diamètre, dézoomable à ~80 km)
  const [zoom, setZoom] = useState(large ? 0.008 : 0.65);
  const walkTiles = useRef(new Map<string, Tuile>());
  const flyTiles = useRef(new Map<string, Tuile>());
  const enCours = useRef(new Set<string>());
  const [, forcer] = useState(0);

  const z = large ? Z_FLY : Z_WALK;
  const cur = hud ? tuileDe(hud.lat, hud.lon, z) : null;
  const txCur = cur?.x ?? null;
  const tyCur = cur?.y ?? null;

  useEffect(() => {
    if (txCur === null || tyCur === null) return;
    let annule = false;
    const store = large ? flyTiles.current : walkTiles.current;
    const endpoint = large ? "/api/overview" : "/api/tiles";
    (async () => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${z}/${txCur + dx}/${tyCur + dy}`;
          if (store.has(k) || enCours.current.has(k)) continue;
          enCours.current.add(k);
          try {
            const r = await fetch(`${endpoint}/${k}`, { cache: "no-store" });
            if (!r.ok) continue;
            const t = (await r.json()) as Tuile;
            store.set(k, t);
            if (!annule) forcer((n) => n + 1);
          } catch { /* ignore */ }
          finally { enCours.current.delete(k); }
        }
      }
    })();
    return () => { annule = true; };
  }, [txCur, tyCur, large, z]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !hud) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const L = cv.clientWidth || 160, H = cv.clientHeight || 160;
    if (cv.width !== L * dpr || cv.height !== H * dpr) { cv.width = L * dpr; cv.height = H * dpr; }
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, L, H);

    const cx = L / 2, cy = H / 2, R = Math.min(cx, cy);
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();

    // Thème auto jour / nuit
    const bg = night ? "#0b1220" : "#eef2f5";
    const waterCol = night ? "#1d4ed8" : "#7cc0e8";
    const pathCol = night ? "#475569" : "#cbbda6";
    const minorCol = night ? "#64748b" : "#ffffff";
    const minorCase = night ? "#1e293b" : "#cbd5e1";
    const majorCol = night ? "#38bdf8" : "#ffffff";
    const majorCase = night ? "#0c4a6e" : "#94a3b8";
    const textCol = night ? "#e2e8f0" : "#0f172a";
    const textHalo = night ? "rgba(11,18,32,0.85)" : "rgba(255,255,255,0.85)";

    g.fillStyle = bg;
    g.fillRect(0, 0, L, H);

    const p = tuileDe(hud.lat, hud.lon, z);
    const mPerUnit = large ? M_PER_UNIT_FLY : M_PER_UNIT_WALK;
    const px = zoom * mPerUnit; // pixels par unité de tuile
    const versEcran = (tx: number, ty: number, ux: number, uy: number): [number, number] => [
      cx + ((tx - p.x) * EXTENT + ux - p.dx) * px,
      cy + ((ty - p.y) * EXTENT + uy - p.dy) * px,
    ];

    const cap = (hud.heading * Math.PI) / 180;
    const cosC = Math.cos(-cap), sinC = Math.sin(-cap);
    const rotPt = (X: number, Y: number): [number, number] => {
      const rx = X - cx, ry = Y - cy;
      return [cx + rx * cosC - ry * sinC, cy + rx * sinC + ry * cosC];
    };

    const store = large ? flyTiles.current : walkTiles.current;

    g.save();
    g.translate(cx, cy);
    g.rotate(-cap);
    g.translate(-cx, -cy);
    g.lineCap = "round";
    g.lineJoin = "round";

    // Mer et grands plans d'eau : remplis sous les routes. Sans ça, en survol on ne sait pas
    // de quel côté est la côte. Seules les zones d'eau sont dessinées (aucun bâtiment, aucun POI).
    g.fillStyle = waterCol;
    for (const t of store.values()) {
      for (const a of t.areas ?? []) {
        if (a.kind !== "water") continue;
        g.beginPath();
        for (const r of a.rings) {
          for (let i = 0; i < r.length; i += 2) {
            const [X, Y] = versEcran(t.x, t.y, r[i], r[i + 1]);
            if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
          }
          g.closePath();
        }
        g.fill("evenodd");
      }
    }

    const trace = (tx: number, ty: number, pts: number[]) => {
      if (pts.length < 4) return;
      g.beginPath();
      for (let i = 0; i < pts.length - 1; i += 2) {
        const [X, Y] = versEcran(tx, ty, pts[i], pts[i + 1]);
        if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
      }
      g.stroke();
    };

    if (large) {
      // MODE SURVOL : uniquement grands axes fins (autoroutes / nationales / départementales)
      g.strokeStyle = night ? "rgba(56,189,248,0.45)" : "rgba(100,116,139,0.55)";
      g.lineWidth = 1.2;
      for (const t of store.values()) {
        for (const r of t.roads ?? []) {
          if (r.kind === "motorway" || r.kind === "trunk") trace(t.x, t.y, r.pts);
        }
      }
      g.strokeStyle = night ? "rgba(148,163,184,0.28)" : "rgba(148,163,184,0.45)";
      g.lineWidth = 0.8;
      for (const t of store.values()) {
        for (const r of t.roads ?? []) {
          if (r.kind === "primary" || r.kind === "secondary") trace(t.x, t.y, r.pts);
        }
      }
    } else {
      // MODE PIÉTON : rivières, chemins, rues secondaires et grands axes
      g.strokeStyle = waterCol;
      g.lineWidth = Math.max(1.8, 6 * zoom);
      for (const t of store.values()) {
        for (const w of t.waterways ?? []) trace(t.x, t.y, w.pts ?? []);
      }

      g.strokeStyle = pathCol;
      g.lineWidth = Math.max(1, 2.2 * zoom);
      g.setLineDash([3, 3]);
      for (const t of store.values()) {
        for (const r of t.roads ?? []) {
          if ((ROAD_RANK[r.kind ?? ""] ?? 3) <= 1) trace(t.x, t.y, r.pts);
        }
      }
      g.setLineDash([]);

      const drawGroup = (minR: number, maxR: number, baseW: number, casing: string, fill: string) => {
        g.strokeStyle = casing;
        g.lineWidth = Math.max(2.2, (baseW + 2.4) * zoom);
        for (const t of store.values()) {
          for (const r of t.roads ?? []) {
            const rk = ROAD_RANK[r.kind ?? ""] ?? 3;
            if (rk >= minR && rk <= maxR) trace(t.x, t.y, r.pts);
          }
        }
        g.strokeStyle = fill;
        g.lineWidth = Math.max(1.2, baseW * zoom);
        for (const t of store.values()) {
          for (const r of t.roads ?? []) {
            const rk = ROAD_RANK[r.kind ?? ""] ?? 3;
            if (rk >= minR && rk <= maxR) trace(t.x, t.y, r.pts);
          }
        }
      };
      drawGroup(2, 4, 5.5, minorCase, minorCol);
      drawGroup(5, 8, 8.5, majorCase, majorCol);
    }

    g.restore(); // fin rotation du monde

    // Étiquettes toujours horizontales (anti-chevauchement)
    const boxes: [number, number, number, number][] = [[cx - 12, cy - 12, cx + 12, cy + 12]];
    const drawLabel = (txt: string, sx: number, sy: number, font: string) => {
      if (Math.hypot(sx - cx, sy - cy) > R - 16) return false;
      g.font = font;
      const w = g.measureText(txt).width;
      const b: [number, number, number, number] = [sx - w / 2 - 2, sy - 6, sx + w / 2 + 2, sy + 6];
      if (boxes.some((o) => !(b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3]))) return false;
      boxes.push(b);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineWidth = 2.5;
      g.strokeStyle = textHalo;
      g.strokeText(txt, sx, sy);
      g.fillStyle = textCol;
      g.fillText(txt, sx, sy);
      return true;
    };

    if (large) {
      // Survol : noms des villes et villages voisins triés par importance
      const items: { name: string; rank: number; sx: number; sy: number; major: boolean }[] = [];
      const seen = new Set<string>();
      for (const t of store.values()) {
        for (const pl of t.places ?? []) {
          if (!pl.name || seen.has(pl.name)) continue;
          const [X, Y] = versEcran(t.x, t.y, pl.x, pl.y);
          const [sx, sy] = rotPt(X, Y);
          if (Math.hypot(sx - cx, sy - cy) > R - 14) continue;
          seen.add(pl.name);
          items.push({ name: pl.name.slice(0, 18), rank: pl.rank ?? 99, sx, sy, major: pl.kind === "city" || pl.kind === "town" });
        }
      }
      items.sort((a, b) => a.rank - b.rank);
      let drawn = 0;
      for (const it of items) {
        if (drawn >= 9) break;
        const font = it.major ? "700 9.5px ui-sans-serif, system-ui, sans-serif" : "600 8.5px ui-sans-serif, system-ui, sans-serif";
        if (drawLabel(it.name, it.sx, it.sy, font)) drawn++;
      }
    } else {
      // Piéton : noms des rues principales uniquement
      const items: { name: string; rank: number; sx: number; sy: number }[] = [];
      const seen = new Set<string>();
      for (const t of store.values()) {
        for (const n of t.names ?? []) {
          if (!n.name || seen.has(n.name) || n.pts.length < 2) continue;
          const rk = ROAD_RANK[n.kind ?? ""] ?? 2;
          if (rk < 3) continue; // rues principales & secondaires, pas les sentiers/allées
          const mid = Math.floor(n.pts.length / 4) * 2;
          const [X, Y] = versEcran(t.x, t.y, n.pts[mid], n.pts[mid + 1]);
          const [sx, sy] = rotPt(X, Y);
          if (Math.hypot(sx - cx, sy - cy) > R - 16) continue;
          seen.add(n.name);
          items.push({ name: n.name.slice(0, 20), rank: rk, sx, sy });
        }
      }
      items.sort((a, b) => b.rank - a.rank);
      let drawn = 0;
      for (const it of items) {
        if (drawn >= 5) break;
        if (drawLabel(it.name, it.sx, it.sy, "600 8.5px ui-sans-serif, system-ui, sans-serif")) drawn++;
      }
    }

    // Position centrale + cône de visée vers le haut
    g.fillStyle = night ? "rgba(56,189,248,0.24)" : "rgba(43,120,255,0.22)";
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, 26, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); g.closePath(); g.fill();
    g.fillStyle = night ? "#38bdf8" : "#2563eb";
    g.beginPath(); g.arc(cx, cy, 4.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#ffffff"; g.lineWidth = 1.8; g.stroke();

    // Boussole N (indique le vrai Nord)
    const nAng = -cap - Math.PI / 2;
    const nr = R - 12;
    const nx = cx + Math.cos(nAng) * nr;
    const ny = cy + Math.sin(nAng) * nr;
    g.fillStyle = "#ef4444";
    g.beginPath(); g.arc(nx, ny, 8.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#ffffff";
    g.font = "800 9.5px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("N", nx, ny + 0.5);

    // Échelle en bas du cercle en mode survol (ex: "20 km")
    if (large) {
      const km = Math.round((L / zoom) / 1000);
      g.font = "600 8.5px ui-monospace, monospace";
      g.fillStyle = night ? "rgba(226,232,240,0.75)" : "rgba(15,23,42,0.75)";
      g.fillText(`${km} km`, cx, H - 9);
    }

    g.restore(); // fin clip circulaire
  });

  useEffect(() => { setZoom(large ? 0.008 : 0.65); }, [large]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      setZoom((v) => large
        ? Math.min(0.05, Math.max(0.0018, v * factor)) // survol : ~3 km à ~90 km
        : Math.min(3.5, Math.max(0.15, v * factor)));   // piéton : ~45 m à ~1 km
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [large]);

  return (
    <canvas
      ref={ref}
      className="absolute inset-0 size-full"
      data-testid="plan2d"
      data-theme={night ? "night" : "day"}
      style={{ imageRendering: "auto" }}
    />
  );
}
