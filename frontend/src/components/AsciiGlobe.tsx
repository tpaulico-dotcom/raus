import { useEffect, useRef } from "react";

/** Masque terre/mer 240×120 (Natural Earth 110 m, domaine public), 1 bit par case, MSB d'abord.
 *  4,8 ko en base64 : le globe ne fait aucune requête réseau et ne dépend d'aucun service. */
const LAND_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF//gD//+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP////////8AAAAAAAAAAAMAAAAAAAAAAAAAAAAAAf////////wAA//gB+AAAA/gAAAAAAAAAAAAAAAOf/////////AAAf8AAAAAAAP+AAAAAAAAAAAAAAHvB+/4//////AAAH+AAAAMAAA/4AAAAAAAAAAAAAP/3//gf////+AAAAAAAAf8AD//+AAf+AAAAAAAAA/ux//wAH////AAAAAAAB4AB////zgPsAAAAAAAAA/////8AB///+AAAAAAADwD//////4P8AAAwAfoAA//5+//4D///8AAAADgAD4P/////////8ABAB//9///////8B///8AAAA//gAD///////////9/wP/////////P+A///AAAAH//7////////////////P/////////P/g//wNYAAH////////////////////////////+f/Af/Af4AAP7/////////////////Dz/////////v+Af4AP4AB///////////////////An////////D/+APwAAAAH/P/////////////////AP///////8APyAHwAAAAH/v//////////////7/gAP/8v////8Af/AAAAAAMH/H//////////////z5AAAfgD/////AP/gAAAAAOD+P////////////4APgAAA/AAf////4P/wAAAAAeB+P////////////wAfgAADgAAf///////8AAAAA/B///////////////AfgAAAAAAX/////f/+AAAAB/3///////////////AeAAAAAAAL////////AAAAB/////////////////AMAAAAAAAD///////3AAAAAP////////////////AAAAAAAAAA///////vgAAAAP////////////////gAAAAAAAAAf//////fgAAAAH///////////////7AAAAAAAAAAf//////4AAAAAB///////////////7AAAAAAAAAAf//////AAAAAA5///zf//////////jgAAAAAAAAA//////wAAAAAB//9/jP//////////HwAAAAAAAAAf/////wAAAAAB/5v////////////4HAAAAAAAAAAf////+AAAAAAB/hn////////////4GAAAAAAAAAAf////+AAAAAAB/hPf//////////5wMAAAAAAAAAAP////8AAAAAAA//2M//////////84cAAAAAAAAAAH////8AAAAAAAf/wHH/////////w/8AAAAAAAAAAH////wAAAAAAA//wAB/////////4vgAAAAAAAAAAB////gAAAAAAB//+fL/////////8OAAAAAAAAAAAA////AAAAAAAB//////////////8MAAAAAAAAAAAA///ngAAAAAAD//////////////8AAAAAAAAAAAAAf/wDoAAAAAAH//////7///////8AAAAAAAAAAAAAP/wB4AAAAAAP////+/////////wAAAAAAAAAAAAAH/gB4AAAAAAf///////3//////8AAAAAAAAAAAAAD/gH4AAAAAAf/////f/8P/////oAAAAAAAAcAAAAAfw/8AAAAAA//////v/8D////+IAAAAAAAAGAAAAAfx4fwAAAAA//////v/4D/+f/4AAAAAAAAACAAAAAP/wf+AAAAAf/////3/4A/4P+wMAAAAAAAAAAAAAAH/wMmAAAAA//////3/wA/wH/AMAAAAAAAAAAAAAAA/+AAAAAAA//////7+AAfgP/gcAAAAAAAAAAAAAAAD+AAAAAAA///////8AAfAB/gOAAAAAAAAAAAAAAAA+AwAAAAA///////2AAfAB/gPAAAAAAAAAAAAAAAAOH9wAAAAf//////+AAPABvgXAAAAAAAAAAAAAAAAP3/wAAAAP//////8AAPABnA3gAAAAAAAAAAAAAAAD//4AAAAH//////8AAHgBiAngAAAAAAAAAAAAAAAAv/9AAAAH//////4AABgA4BngAAAAAAAAAAAAAAAAP//wAAAB/n////4AABAG4DxAAAAAAAAAAAAAAAAAP//wAAAAgH////wAAAAD4HwAAAAAAAAAAAAAAAAAf//4AAAAAA////wAAAAB8fhQAAAAAAAAAAAAAAAA///4AAAAAA////AAAAAB8//wAAAAAAAAAAAAAAAA///+AAAAAB///+AAAAAA8/+XAAAAAAAAAAAAAAAA////8AAAAA///8AAAAAAefcf+DAAAAAAAAAAAAAB////+AAAAAf//4AAAAAAOPd//jgAAAAAAAAAAAAB/////gAAAAf//4AAAAAAHAeB//QAAAAAAAAAAAAB/////gAAAAP//4AAAAAAD8ABP+cAAAAAAAAAAAAAf////gAAAAP//4AAAAAAA/9gf4HAAAAAAAAAAAAAf////gAAAAP//4AAAAAAAB7ADODgAAAAAAAAAAAAP////AAAAAH//4AAAAAAAAAHjCBgAAAAAAAAAAAAP///+AAAAAP//8MAAAAAAAAPzAAAAAAAAAAAAAAAH///+AAAAAP//8cAAAAAAAB/jgAEAgAAAAAAAAAAH///+AAAAAf//58AAAAAAAD/zgAEBgAAAAAAAAAAA///8AAAAAf//58AAAAAAAH//wAEDAAAAAAAAAAAAf//8AAAAAf//h4AAAAAAAP//4AADAAAAAAAAAAAAf//8AAAAAP//B4AAAAAAB///8AYAAAAAAAAAAAAAf//4AAAAAH//DwAAAAAAH///+AcAAAAAAAAAAAAAf//4AAAAAH//DwAAAAAAH///+AAAAAAAAAAAAAAAf//AAAAAAH//BwAAAAAAH////AAAAAAAAAAAAAAA//8AAAAAAH/8AgAAAAAAH////gAAAAAAAAAAAAAA//8AAAAAAD/8AAAAAAAAD////gAAAAAAAAAAAAAA//8AAAAAAD/8AAAAAAAAD////gAAAAAAAAAAAAAA//4AAAAAAB/4AAAAAAAAD////gAAAAAAAAAAAAAA//wAAAAAAB/wAAAAAAAAB/7//AAAAAAAAAAAAAAA//gAAAAAAA/gAAAAAAAAD+B//AAQAAAAAAAAAAAB//AAAAAAAAQAAAAAAAAABwA/+AAYAAAAAAAAAAAD/+AAAAAAAAAAAAAAAAAAAAAH+AAcAAAAAAAAAAAD/8AAAAAAAAAAAAAAAAAAAAAH8AAPAAAAAAAAAAAD/gAAAAAAAAAAAAAAAAAAAAAAQAAeAAAAAAAAAAAD/gAAAAAAAAAAAAAAAAAAAAAA4AA8AAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAA4ABwAAAAAAAAAAAD+AAAAAAAAAAAAAAAAAAAAAAAQADwAAAAAAAAAAAD+AAAAAAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAH+AAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAH+AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAH4AAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAH4cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAAAAABwAAAAMEAAgAAAAAAAAAAAAAAAAPgAAAAAAAAAAAP8gA///////wAAAAAAAAAAAAAAAfAAAAAAAAAADH//+D////////wAAAAAAAAAAAAAA/gAAAAAADv7////+//////////AAAAAAAAAAHwAH/gAAAAD////////////////////gAAAAABqAP/8r/wAAAAf////////////////////gAAAAH///P////wAAAA////////////////////+AAAAD/////////AAAB/////////////////////wAAAP/////////gACAf/////////////////////wAAD/////////+AAPw//////////////////////8AAAgH////////n5/wf/////////////////////AAAAH//////////4////////////////////////wAAgB///////////////////////////////////+A////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////";
const MW = 240;
const MH = 120;

let mask: Uint8Array | null = null;
function maskBytes(): Uint8Array {
  if (!mask) {
    const s = atob(LAND_B64);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    mask = a;
  }
  return mask;
}

function isLand(lon: number, lat: number): boolean {
  const b = maskBytes();
  const x = Math.min(MW - 1, Math.max(0, Math.floor((lon / (2 * Math.PI) + 0.5) * MW)));
  const y = Math.min(MH - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * MH)));
  const i = y * MW + x;
  return (b[i >> 3] & (0x80 >> (i & 7))) !== 0;
}

const LAND_RAMP = ":=+*x#%8@";

/** Globe terrestre en caractères ASCII, en projection orthographique, qui tourne lentement.
 *  Dessiné sur un canevas : ~3 500 caractères par image, 24 images/s, aucune dépendance. */
export default function AsciiGlobe({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let last = 0;

    const draw = (time: number) => {
      const S = cv.clientWidth;
      if (!S) return;
      const cols = Math.max(36, Math.min(96, Math.round(S / 9)));
      const cellW = S / cols;
      const cellH = cellW * 1.45;
      const rows = Math.floor(S / cellH);
      const H = rows * cellH;

      if (cv.width !== S || cv.height !== Math.round(H)) {
        cv.width = S;
        cv.height = Math.round(H);
      }
      ctx.clearRect(0, 0, cv.width, cv.height);

      const cx = S / 2;
      const cy = H / 2;
      const R = Math.min(S, H) / 2;

      const spin = reduce ? 0.6 : time * 0.00016;
      const ct = Math.cos(0.42), st = Math.sin(0.42); // inclinaison de l'axe
      const cs = Math.cos(spin), ss = Math.sin(spin);

      // Soleil fixe dans la scène : la nuit tombe sur le bord droit du globe
      const Lx = -0.62, Ly = 0.42, Lz = 0.66;

      ctx.font = `${Math.round(cellW * 1.02)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const px = (col + 0.5) * cellW;
          const py = H - (row + 0.5) * cellH;
          const dx = (px - cx) / R;
          const dy = (py - cy) / R;
          const r2 = dx * dx + dy * dy;
          if (r2 > 1) continue; // hors du disque
          const dz = Math.sqrt(1 - r2);

          // Vecteur de vue → vecteur du monde (rotation inverse : lacet puis inclinaison)
          const v1y = dy * ct + dz * st;
          const v1z = -dy * st + dz * ct;
          const wx = dx * cs - v1z * ss;
          const wy = v1y;
          const wz = dx * ss + v1z * cs;

          const lat = Math.asin(Math.max(-1, Math.min(1, wy)));
          const lon = Math.atan2(wx, wz);
          const land = isLand(lon, lat);
          const lonDeg = (lon * 180) / Math.PI;
          const latDeg = (lat * 180) / Math.PI;

          // Soleil presque face à nous : toute la face visible est éclairée, le bord s'assombrit
          const lum = Math.max(0, dx * 0.38 + dy * 0.30 + dz * 0.88);
          const limb = 0.45 + 0.55 * dz;
          const light = Math.pow(lum, 0.55) * limb;

          let ch: string;
          let alpha: number;

          if (land) {
            const b = Math.max(0.28, light);
            const idx = Math.min(LAND_RAMP.length - 1, Math.max(0, Math.round((b - 0.2) * (LAND_RAMP.length - 1) / 0.8)));
            ch = LAND_RAMP[idx];
            alpha = 0.62 + b * 0.38;
            // Côte : une terre qui touche la mer passe au caractère plein, le trait est net.
            const d = 2.4 * (Math.PI / 180);
            if (!isLand(lon + d, lat) || !isLand(lon - d, lat) || !isLand(lon, lat + d) || !isLand(lon, lat - d)) {
              ch = "@";
              alpha = Math.min(1, alpha + 0.22);
            }
          } else {
            // Mer : un point très discret une case sur deux, juste pour lire la sphère.
            const thr = (cellW / R) * (180 / Math.PI) * 0.55;
            const dm = Math.abs((((lonDeg % 20) + 30) % 20) - 10);
            const dp = Math.abs((((latDeg % 20) + 30) % 20) - 10);
            const onM = Math.abs(dm - 10) < thr;
            const onP = Math.abs(dp - 10) < thr;
            if (onM && onP) { ch = "·"; alpha = 0.3 * light; }
            else if (onM || onP) { ch = onP ? "-" : ":"; alpha = 0.17 * light; }
            else if ((col + row) % 2 === 0) { ch = "."; alpha = 0.09 * light; }
            else continue;
          }

          if (ch === " ") continue;
          ctx.fillStyle = `rgba(46, 230, 122, ${alpha.toFixed(3)})`;
          ctx.fillText(ch, px, H - py);
        }
      }
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 40) return; // 25 images/s : largement assez pour un globe qui tourne
      last = t;
      draw(t);
    };

    if (reduce) {
      draw(0);
      const ro = new ResizeObserver(() => draw(0));
      ro.observe(cv);
      return () => ro.disconnect();
    }
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => draw(performance.now()));
    ro.observe(cv);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
