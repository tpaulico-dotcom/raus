import { useEffect, useRef, useState } from "react";
import type { Engine } from "@/viewer/Engine";

/** Panneau d'entrée d'agglomération : fond blanc, liseré rouge, nom de la commune.
 *
 * Il apparaît quand on entre dans une nouvelle commune, à pied, et s'efface au bout de
 * quelques secondes — comme le panneau planté au bord de la route. Le nom vient de la
 * couche « place » d'OpenStreetMap, la même que les étiquettes de villes en vue aérienne.
 *
 * La commune est calculée à chaque rendu (le HUD redessine plusieurs fois par seconde) :
 * pas d'intervalle à gérer, donc rien qui puisse rester silencieusement inerte. */
export default function TownSign({ engine, mode }: { engine: React.RefObject<Engine | null>; mode: string }) {
  const here = mode === "walk" ? (engine.current?.placeAt(420) ?? null) : null;
  const [town, setTown] = useState<string | null>(null);
  const last = useRef<string>("");

  useEffect(() => {
    if (!here || here.name === last.current) return;
    last.current = here.name;
    setTown(here.name);
  }, [here?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!town) return;
    const t = setTimeout(() => setTown(null), 9000);
    return () => clearTimeout(t);
  }, [town]);

  return (
    <div
      className="pointer-events-none absolute top-[14%] left-1/2 -translate-x-1/2"
      data-testid="town-sign"
    >
      {town && (
        <div className="animate-rise-in rounded-[3px] border-[3px] border-[#c62828] bg-white px-5 py-2 shadow-2xl">
          <div className="border border-[#c62828]/60 px-5 py-1 text-center">
            <p className="font-heading text-[19px] leading-tight font-semibold text-slate-900">{town}</p>
            <p className="mt-0.5 text-[9px] tracking-[0.3em] text-slate-500 uppercase">Commune</p>
          </div>
        </div>
      )}
    </div>
  );
}
