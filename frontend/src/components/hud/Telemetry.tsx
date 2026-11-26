import { Navigation, Gauge, Mountain, Landmark, Activity } from "lucide-react";
import type { HudState } from "@/viewer/Engine";

const CARD = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const POI_LABEL: Record<string, string> = {
  place_of_worship: "Lieu de culte", town_hall: "Mairie", museum: "Musée", castle: "Château", monument: "Monument",
  attraction: "Attraction", theatre: "Théâtre", library: "Bibliothèque", school: "École", college: "Lycée",
  hospital: "Hôpital", railway: "Gare", fountain: "Fontaine", cinema: "Cinéma", stadium: "Stade", art_gallery: "Galerie",
};

function Compass({ heading }: { heading: number }) {
  // A sliding tape: 1 degree = 2px
  const marks = [];
  for (let d = -180; d <= 540; d += 15) {
    const label = d % 45 === 0 ? CARD[(((d / 45) % 8) + 8) % 8] : null;
    marks.push(
      <div key={d} className="absolute top-0 flex flex-col items-center" style={{ left: d * 2 }}>
        <div className={label ? "h-2.5 w-px bg-slate-300" : "h-1.5 w-px bg-slate-600"} />
        {label && <span className={`mt-0.5 font-mono text-[10px] ${label === "N" ? "text-signal" : "text-slate-400"}`}>{label}</span>}
      </div>,
    );
  }
  return (
    <div className="relative h-8 w-56 overflow-hidden" data-testid="hud-compass-bearing" aria-label={`Cap ${Math.round(heading)}°`}>
      <div className="absolute top-1 left-1/2" style={{ transform: `translateX(${-heading * 2}px)` }}>
        {marks}
      </div>
      <div className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-signal" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-slate-950 via-transparent to-slate-950" />
    </div>
  );
}

export default function Telemetry({ hud }: { hud: HudState | null }) {
  const h = hud;
  const card = h ? CARD[Math.round(h.heading / 45) % 8] : "N";
  return (
    <div
      className="w-[min(380px,calc(100vw-2rem))] animate-rise-in rounded-2xl border border-cyan-500/20 bg-slate-950/75 p-4 shadow-2xl shadow-cyan-950/50 backdrop-blur-xl"
      data-testid="hud-telemetry"
    >
      <p className="font-mono text-[10px] tracking-[0.15em] text-signal uppercase">
        {h?.mode === "fly" ? "Survol" : "Vous êtes"}
      </p>
      <h2
        className="mt-1 truncate font-heading text-2xl font-semibold tracking-[-0.03em] text-slate-50"
        data-testid="hud-location-street-name"
      >
        {h?.street ?? (h ? "Hors des rues nommées" : "Chargement…")}
      </h2>
      {h?.poi && (
        <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-slate-300" data-testid="hud-nearby-poi">
          <Landmark className="size-3.5 shrink-0 text-sky" />
          <span className="truncate">{h.poi.name}</span>
          <span className="shrink-0 text-slate-500">· {POI_LABEL[h.poi.kind] ?? "Lieu"} · {Math.round(h.poi.d)} m</span>
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <Compass heading={h?.heading ?? 0} />
        <span className="flex items-center gap-1 font-mono text-xs text-slate-300" data-testid="hud-heading">
          <Navigation className="size-3.5 text-signal" style={{ transform: `rotate(${h?.heading ?? 0}deg)` }} />
          {Math.round(h?.heading ?? 0)}° {card}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-800 pt-3 font-mono text-xs">
        <span className="flex items-center gap-1.5 text-slate-300" data-testid="hud-speed">
          <Gauge className="size-3.5 text-slate-500" />
          {(h?.speedKmh ?? 0).toFixed(1)} km/h
        </span>
        <span className="flex items-center gap-1.5 text-slate-300" data-testid="hud-altitude">
          <Mountain className="size-3.5 text-slate-500" />
          {Math.round(h?.altitude ?? 0)} m · alt. {Math.round(h?.elevation ?? 0)}
        </span>
        <span className="flex items-center gap-1.5 text-slate-300" data-testid="hud-fps">
          <Activity className="size-3.5 text-slate-500" />
          {h?.fps ?? 0} ips
        </span>
      </div>
      <p className="mt-2 font-mono text-[11px] text-slate-500" data-testid="hud-gps-coordinates">
        {h ? `${h.lat.toFixed(5)}° N · ${Math.abs(h.lon).toFixed(5)}° ${h.lon >= 0 ? "E" : "O"}` : "—"}
      </p>
    </div>
  );
}
