import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsUp, ChevronsDown } from "lucide-react";
import type { Mode } from "@/viewer/Engine";

// On-screen pad for touch devices (hidden when a fine pointer is available).
export default function TouchPad({ onKey, mode }: { onKey: (code: string, down: boolean) => void; mode: Mode }) {
  const btn = (code: string, Icon: typeof ArrowUp, id: string) => (
    <button
      data-testid={`touch-${id}`}
      onPointerDown={(e) => { e.preventDefault(); onKey(code, true); }}
      onPointerUp={() => onKey(code, false)}
      onPointerLeave={() => onKey(code, false)}
      onPointerCancel={() => onKey(code, false)}
      className="flex size-12 items-center justify-center rounded-xl border border-slate-700/60 bg-slate-900/80 text-slate-200 backdrop-blur-md active:bg-cyan-500/30"
    >
      <Icon className="size-5" />
    </button>
  );
  return (
    <div className="pointer-events-auto hidden items-end gap-3 [@media(pointer:coarse)]:flex" data-testid="touch-pad">
      <div className="grid grid-cols-3 gap-1.5">
        <span />
        {btn("KeyW", ArrowUp, "forward")}
        <span />
        {btn("KeyA", ArrowLeft, "left")}
        {btn("KeyS", ArrowDown, "back")}
        {btn("KeyD", ArrowRight, "right")}
      </div>
      {mode === "fly" && (
        <div className="grid gap-1.5">
          {btn("Space", ChevronsUp, "up")}
          {btn("KeyC", ChevronsDown, "down")}
        </div>
      )}
    </div>
  );
}
