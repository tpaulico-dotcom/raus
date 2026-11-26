import type { HudState } from "@/viewer/Engine";
import type { TileStatus } from "@/viewer/TileManager";
import { cn } from "@/lib/utils";

const STYLE: Record<TileStatus, string> = {
  none: "bg-slate-800/50",
  queued: "bg-slate-500/60",
  anticipated: "bg-sky animate-pulse-tile",
  loading: "bg-cyan-300/80 animate-pulse-tile",
  ready: "bg-emerald-400/85",
  error: "bg-red-400/80",
};

export default function PrefetchRadar({ hud }: { hud: HudState | null }) {
  const grid = hud?.grid ?? Array<TileStatus>(25).fill("none");
  const busy = (hud?.loading ?? 0) + (hud?.queued ?? 0);
  const anticipating = hud?.anticipated ?? 0;
  return (
    <div
      className="animate-rise-in rounded-2xl border border-cyan-500/20 bg-slate-950/75 p-3.5 shadow-2xl shadow-cyan-950/50 backdrop-blur-xl"
      data-testid="prefetch-radar"
    >
      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-[10px] tracking-[0.15em] text-slate-400 uppercase">Anticipation</p>
        <span
          data-testid="badge-prefetch-status"
          className={cn(
            "rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors duration-300",
            anticipating > 0 ? "bg-[#0C4A6E] text-[#7DD3FC]" : busy > 0 ? "bg-cyan-950 text-cyan-200" : "bg-[#064E3B] text-[#6EE7B7]",
          )}
        >
          {anticipating > 0 ? `${anticipating} zone${anticipating > 1 ? "s" : ""} en avance` : busy > 0 ? `${busy} en chargement` : "Zone prête"}
        </span>
      </div>
      <div className="relative mt-3 grid w-fit grid-cols-5 gap-1" data-testid="prefetch-grid">
        {grid.map((s, i) => (
          <div
            key={i}
            data-testid={`prefetch-tile-${i}`}
            data-status={s}
            className={cn("size-5 rounded-[4px] transition-colors duration-300", STYLE[s], i === 12 && "ring-2 ring-white/90 ring-offset-1 ring-offset-slate-950")}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-emerald-400" />prête</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-sky" />anticipée</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-sm bg-cyan-300" />chargement</span>
      </div>
      <p className="mt-2 font-mono text-[10px] text-slate-500" data-testid="hud-buildings-count">
        {hud?.ready ?? 0} zones · {(hud?.buildings ?? 0).toLocaleString("fr-FR")} bâtiments
      </p>
    </div>
  );
}
