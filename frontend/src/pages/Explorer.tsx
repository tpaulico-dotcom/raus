import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Compass, Crosshair, MapPinned } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import SearchBar from "@/components/hud/SearchBar";
import Telemetry from "@/components/hud/Telemetry";
import PrefetchRadar from "@/components/hud/PrefetchRadar";
import ControlsBar from "@/components/hud/ControlsBar";
import HelpDialog from "@/components/hud/HelpDialog";
import AsciiGlobe from "@/components/AsciiGlobe";
import Plan2D from "@/components/Plan2D";
import TouchPad from "@/components/hud/TouchPad";
import SceneLabels from "@/components/hud/SceneLabels";
import TownSign from "@/components/hud/TownSign";
import { Engine, type HudState, type Mode, type TeleportPhase, type TimeOfDay } from "@/viewer";
import type { GeoResult } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function Explorer() {
  const mount = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const [origin, setOrigin] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [mode, setModeState] = useState<Mode>("walk");
  const [time, setTime] = useState<TimeOfDay>("live");
  const [help, setHelp] = useState(false);
  const [panneaux, setPanneaux] = useState({ position: false, anticipation: false });
  const [plan, setPlan] = useState(true);
  const [locked, setLocked] = useState(false);
  const [travel, setTravel] = useState<{ phase: TeleportPhase; label: string } | null>(null);
  const [place, setPlace] = useState("");
  const [geoInfo, setGeoInfo] = useState<{ city: string; country: string; road: string }>({ city: "", country: "", road: "" });
  const revCache = useRef(new Map<string, { city: string; country: string; road: string }>());
  const splash = origin === null;

  // Résolution ville/village + pays par cellule ~500 m (Nominatim caché côté serveur)
  const cellKey = hud ? `${(Math.round(hud.lat * 200) / 200).toFixed(3)},${(Math.round(hud.lon * 200) / 200).toFixed(3)}` : "";
  useEffect(() => {
    if (!cellKey || !hud) return;
    const cached = revCache.current.get(cellKey);
    if (cached) { setGeoInfo(cached); return; }
    let cancelled = false;
    fetch(`/api/reverse?lat=${hud.lat.toFixed(5)}&lon=${hud.lon.toFixed(5)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { city?: string; country?: string; road?: string } | null) => {
        if (!d || cancelled) return;
        const info = { city: d.city || "", country: d.country || "", road: d.road || "" };
        revCache.current.set(cellKey, info);
        setGeoInfo(info);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cellKey]);

  useEffect(() => {
    if (!origin || !mount.current || engine.current) return;
    let e: Engine;
    try {
      e = new Engine(
        mount.current,
        {
          onHud: (s) => {
            setHud(s);
            setModeState(s.mode);
          },
          onTeleport: (phase, label) => {
            setTravel(phase === "done" ? null : { phase, label });
            if (phase !== "done") {
              window.setTimeout(() => setTravel((t) => (t && t.phase === phase ? null : t)), 30000);
            }
          },
          onError: (m) => toast.error(m),
          onLockChange: setLocked,
        },
        { lat: origin.lat, lon: origin.lon },
      );
    } catch {
      toast.error("WebGL n'est pas disponible sur cet appareil.");
      return;
    }
    engine.current = e;
    const w = window as unknown as { __france3d?: Engine; __rausmap?: Engine; __eraus?: Engine };
    w.__france3d = e;
    w.__rausmap = e;
    w.__eraus = e;
    void e.goTo(origin.lat, origin.lon, { label: origin.label, instant: true });
    return () => {
      e.dispose();
      engine.current = null;
    };
  }, [origin !== null]);

  const goTo = useCallback((lat: number, lon: number, label: string) => {
    setPlace(label);
    if (!engine.current) {
      setOrigin({ lat, lon, label });
    } else {
      void engine.current.goTo(lat, lon, { label });
    }
  }, []);

  const onSearch = (r: GeoResult) => goTo(r.lat, r.lon, r.label);
  const onMode = (m: Mode) => {
    engine.current?.setMode(m);
    setModeState(m);
  };
  const onTime = (t: TimeOfDay) => {
    engine.current?.setTimeOfDay(t);
    setTime(t);
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#090D14] select-none" data-testid="france-3d-explorer-container">
      <div ref={mount} className="absolute inset-0" />
      {plan && hud && (
        <div
          className={cn(
            "pointer-events-auto absolute bottom-4 left-4 z-20 size-[160px] overflow-hidden rounded-full border-2 shadow-2xl ring-1 transition-colors",
            hud.isNight ? "border-cyan-400/40 bg-slate-950 ring-cyan-500/20" : "border-white/75 bg-slate-200 ring-black/20",
          )}
        >
          <Plan2D hud={{ lat: hud.lat, lon: hud.lon, heading: hud.heading }} large={mode === "fly"} night={hud.isNight} />
        </div>
      )}
      {hud && (
        <div
          data-testid="gps-info-box"
          className={cn(
            "pointer-events-none absolute bottom-4 z-20 max-w-[270px] rounded-xl border px-3 py-2 shadow-xl backdrop-blur-md transition-colors",
            plan ? "left-[188px]" : "left-4",
            hud.isNight
              ? "border-cyan-400/30 bg-slate-950/80 text-slate-100"
              : "border-white/60 bg-white/85 text-slate-900",
          )}
        >
          {(geoInfo.city || geoInfo.country) && (
            <p className="truncate text-xs font-semibold leading-tight">
              {[geoInfo.city, geoInfo.country].filter(Boolean).join(" · ")}
            </p>
          )}
          {(hud.street || geoInfo.road) && (
            <p className={cn("truncate text-[11px] leading-tight mt-0.5", hud.isNight ? "text-cyan-300" : "text-blue-700")}>
              {hud.street || geoInfo.road}
            </p>
          )}
          <p className={cn("mt-1 font-mono text-[10px] leading-tight", hud.isNight ? "text-slate-400" : "text-slate-600")}>
            {hud.lat.toFixed(5)}° {hud.lat >= 0 ? "N" : "S"} · {Math.abs(hud.lon).toFixed(5)}° {hud.lon >= 0 ? "E" : "O"}
          </p>
        </div>
      )}
      <SceneLabels engine={engine} />
      <TownSign engine={engine} mode={mode} />

      {/* Crosshair */}
      {!splash && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" data-testid="hud-crosshair">
          <Crosshair className="size-5 text-white/70 drop-shadow" strokeWidth={1.5} />
        </div>
      )}

      {/* HUD */}
      <div className={cn("pointer-events-none absolute inset-0 transition-opacity duration-500", splash ? "opacity-0" : "opacity-100")}>
        <header className="pointer-events-auto absolute top-4 right-4 left-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex w-full max-w-[460px] flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-signal/15 ring-1 ring-signal/40">
                <Compass className="size-5 text-signal" />
              </div>
              <div className="min-w-0">
                <img src="/raus-logo.svg" alt="RAUS" className="h-4 w-auto drop-shadow" />
                <p className="truncate text-[11px] text-slate-300 drop-shadow" data-testid="hud-current-place">{place}</p>
              </div>
            </div>
            <SearchBar onGo={onSearch} />
          </div>
          <ControlsBar mode={mode} onMode={onMode} time={time} onTime={onTime} weatherLabel={hud?.weatherLabel} onHelp={() => setHelp(true)} />
        </header>

        <div className="absolute bottom-4 left-4 flex flex-col gap-3">
          <TouchPad mode={mode} onKey={(c, d) => engine.current?.setVirtualKey(c, d)} />
          {panneaux.position && (
            <div className="pointer-events-auto">
              <Telemetry hud={hud} />
            </div>
          )}
        </div>
        <div className="pointer-events-auto absolute right-4 bottom-4 flex flex-col items-end gap-3">
          {panneaux.anticipation && (
            <div className="hidden sm:block">
              <PrefetchRadar hud={hud} />
            </div>
          )}
        </div>

        {locked && !travel && (
          <p
            className="absolute top-1/2 left-1/2 mt-8 -translate-x-1/2 rounded-full bg-slate-950/60 px-3 py-1 font-mono text-[10px] tracking-[0.15em] text-slate-300 uppercase backdrop-blur-sm"
            data-testid="hud-unlock-hint"
          >
            Échap pour libérer le curseur
          </p>
        )}
        {!locked && !splash && !travel && (
          <p
            className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 rounded-full border border-slate-700/60 bg-slate-900/75 px-4 py-2 text-xs text-slate-200 backdrop-blur-md lg:block [@media(pointer:coarse)]:hidden"
            data-testid="hud-lock-hint"
          >
            Cliquez dans la vue pour piloter · <span className="font-mono text-signal">ZQSD</span> / <span className="font-mono text-signal">WASD</span> · Maj courir · V survol
          </p>
        )}
      </div>

      {/* Travel overlay */}
      <AnimatePresence>
        {travel && travel.phase !== "arriving" && !splash && (
          <motion.div
            key="travel"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-b from-sky-200/70 via-sky-100/60 to-slate-100/70 backdrop-blur-sm"
            data-testid="travel-overlay"
          >
            <div className="text-center">
              <MapPinned className="mx-auto size-8 animate-bounce text-slate-800" />
              <p className="mt-3 font-mono text-[11px] tracking-[0.15em] text-slate-600 uppercase">
                {travel.phase === "leaving" ? "Décollage" : "Chargement des rues"}
              </p>
              <p className="mt-1 font-heading text-2xl font-semibold tracking-[-0.03em] text-slate-900" data-testid="travel-destination">
                {travel.label}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Splash — RAUS LIVE MODEL */}
      <AnimatePresence>
        {splash && (
          <motion.div
            key="splash"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45 }}
            className="absolute inset-0 z-30 overflow-hidden bg-[#05080f]"
            data-testid="splash-screen"
          >
            {/* Terre en 3D, en caractères ASCII, qui tourne derrière le logo */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className="absolute aspect-square w-[min(118vmin,1040px)] -translate-y-[4%]"
                style={{
                  maskImage: "radial-gradient(circle at center, #000 58%, transparent 82%)",
                  WebkitMaskImage: "radial-gradient(circle at center, #000 58%, transparent 82%)",
                }}
              >
                <AsciiGlobe className="size-full" />
              </div>
            </div>
            {/* Voile : assombrit seulement la colonne de texte, le globe reste lisible sur les côtés */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse 34% 46% at 50% 50%, rgba(5,8,15,0.86) 0%, rgba(5,8,15,0.62) 52%, rgba(5,8,15,0) 100%)",
              }}
            />
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "linear-gradient(180deg, #05080f 0%, rgba(5,8,15,0) 18%, rgba(5,8,15,0) 82%, #05080f 100%)",
              }}
            />
            <div className="relative flex h-full items-center justify-center p-6">
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 280, damping: 24 }}
                className="w-full max-w-xl text-center"
              >
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/35 bg-emerald-950/50 px-3.5 py-1 font-mono text-[11px] tracking-[0.22em] text-emerald-300 uppercase">
                  <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
                  LIVE MODEL
                </div>
                <img
                  src="/raus-logo-green.svg"
                  alt="RAUS — Réseau Actif d'Utilité Sociale"
                  className="mx-auto mt-5 h-20 w-auto max-w-full drop-shadow-[0_0_38px_rgba(34,224,106,0.55)] sm:h-28"
                />
                <p className="mt-4 font-heading text-sm tracking-[0.2em] text-emerald-200/80 uppercase">
                  Réseau Actif d'Utilité Sociale
                </p>
                <p className="mt-2 text-sm text-slate-400">
                  Monde 3D en temps réel · OpenStreetMap · Relief · Météo live
                </p>
                <div className="mt-8 text-left">
                  <SearchBar onGo={onSearch} autoFocus />
                </div>
                <p className="mt-4 font-mono text-[11px] text-slate-500">
                  Saisissez une adresse, une ville ou un lieu partout dans le monde pour démarrer.
                </p>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <HelpDialog
        open={help}
        onOpenChange={setHelp}
        panneaux={panneaux}
        onToggle={(k) => setPanneaux((p) => ({ ...p, [k]: !p[k] }))}
        plan={plan}
        onPlan={() => setPlan((v) => !v)}
      />
      <Toaster richColors />
    </div>
  );
}
