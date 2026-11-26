import { useEffect, useState } from "react";
import type { Engine } from "@/viewer/Engine";

interface SceneLabel {
  key: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  major: boolean;
}

/** Étiquettes posées dans la scène : noms des commerces à pied, noms des villes en survol.
 *
 * Le moteur décide de la liste selon le mode, projette chaque point et écarte ce qui est
 * derrière une façade ; ici on ne fait que poser le texte, avec un rythme volontairement
 * modeste (8 fois par seconde) pour ne pas faire travailler React à chaque image. */
export default function SceneLabels({ engine }: { engine: React.RefObject<Engine | null> }) {
  const [labels, setLabels] = useState<SceneLabel[]>([]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 125) return;
      last = t;
      const e = engine.current;
      setLabels(e ? e.sceneLabels() : []);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="scene-labels">
      {labels.map((l) => (
        <span
          key={l.key}
          style={{ left: l.x, top: l.y }}
          className={
            "absolute -translate-x-1/2 -translate-y-full rounded px-1.5 py-0.5 whitespace-nowrap drop-shadow " +
            (l.kind === "city" || l.kind === "town"
              ? (l.major ? "font-heading text-[17px] tracking-[0.16em] text-white uppercase" : "font-heading text-[13px] tracking-[0.12em] text-white/85 uppercase")
              : "bg-slate-950/65 text-[11px] text-slate-100 ring-1 ring-white/10 backdrop-blur-[2px]")
          }
        >
          {l.name}
        </span>
      ))}
    </div>
  );
}
