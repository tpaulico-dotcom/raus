import { Footprints, Plane, CloudSun, Sunrise, Sun, Sunset, MoonStar, Moon, Keyboard } from "lucide-react";
import type { Mode, TimeOfDay } from "@/viewer/Engine";
import { cn } from "@/lib/utils";

const TIMES: { id: TimeOfDay; label: string; Icon: typeof Sun }[] = [
  { id: "live", label: "Direct", Icon: CloudSun },
  { id: "morning", label: "Matin", Icon: Sunrise },
  { id: "noon", label: "Midi", Icon: Sun },
  { id: "golden", label: "Heure dorée", Icon: Sunset },
  { id: "dusk", label: "Crépuscule", Icon: MoonStar },
  { id: "night", label: "Nuit", Icon: Moon },
];

const seg = "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-[background-color,color,transform] duration-200 active:scale-95";

export default function ControlsBar(props: {
  mode: Mode;
  onMode: (m: Mode) => void;
  time: TimeOfDay;
  onTime: (t: TimeOfDay) => void;
  weatherLabel?: string | null;
  onHelp: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="flex rounded-xl border border-cyan-500/20 bg-slate-950/75 p-1 shadow-2xl backdrop-blur-xl" role="group" aria-label="Mode de déplacement">
        <button
          data-testid="btn-toggle-walk-mode"
          aria-pressed={props.mode === "walk"}
          onClick={() => props.onMode("walk")}
          className={cn(seg, props.mode === "walk" ? "bg-signal text-[#042F2E]" : "text-slate-300 hover:bg-slate-800/70")}
        >
          <Footprints className="size-3.5" /> À pied
        </button>
        <button
          data-testid="btn-toggle-fly-mode"
          aria-pressed={props.mode === "fly"}
          onClick={() => props.onMode("fly")}
          className={cn(seg, props.mode === "fly" ? "bg-sky text-[#082f49]" : "text-slate-300 hover:bg-slate-800/70")}
        >
          <Plane className="size-3.5" /> Survol
        </button>
      </div>
      <div
        className="flex rounded-xl border border-slate-700/60 bg-slate-900/80 p-1 shadow-2xl backdrop-blur-md"
        role="group"
        aria-label="Heure du jour"
        data-testid="slider-time-of-day"
      >
        {TIMES.map(({ id, label, Icon }) => (
          <button
            key={id}
            data-testid={`time-option-${id}`}
            aria-pressed={props.time === id}
            title={id === "live" && props.weatherLabel ? `Météo en direct : ${props.weatherLabel}` : label}
            onClick={() => props.onTime(id)}
            className={cn(seg, props.time === id ? (id === "live" ? "bg-cyan-300/90 text-slate-950" : "bg-amber-300/90 text-amber-950") : "text-slate-300 hover:bg-slate-800/70")}
          >
            <Icon className="size-3.5" />
            <span className="hidden xl:inline">{id === "live" && props.weatherLabel ? props.weatherLabel : label}</span>
          </button>
        ))}
      </div>
      <button
        data-testid="btn-controls-help"
        onClick={props.onHelp}
        className="flex items-center gap-1.5 rounded-xl border border-slate-700/60 bg-slate-900/80 px-3 py-2.5 text-xs text-slate-200 shadow-2xl backdrop-blur-md transition-[background-color,transform] duration-200 hover:bg-slate-800 active:scale-95"
      >
        <Keyboard className="size-3.5" /> Commandes
      </button>
    </div>
  );
}
