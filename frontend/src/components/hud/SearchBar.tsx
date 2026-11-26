import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Search, Loader2, Landmark } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { GeoResult } from "@/lib/types";
import { cn } from "@/lib/utils";

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function SearchBar({ onGo, autoFocus = false }: { onGo: (r: GeoResult) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 450);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["geocode", dq],
    queryFn: () => apiGet<GeoResult[]>(`/geocode?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 3,
    staleTime: Infinity,
  });
  const results = dq.length >= 3 && !isError ? data ?? [] : [];

  const go = (r: GeoResult | undefined) => {
    if (!r) return;
    onGo(r);
    setOpen(false);
    setQ(r.label);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="relative w-full" data-testid="address-search">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(results[active] ?? results[0]);
        }}
        className="flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-slate-950/75 py-1.5 pr-1.5 pl-3 shadow-2xl shadow-cyan-950/40 backdrop-blur-xl transition-[border-color,box-shadow] duration-200 focus-within:border-cyan-400/60 focus-within:shadow-cyan-500/10"
      >
        <Search className="size-4 shrink-0 text-slate-400" aria-hidden />
        <input
          data-testid="input-address-search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          autoFocus={autoFocus}
          placeholder="Rechercher une adresse, ville, lieu dans le monde…"
          aria-label="Rechercher une adresse dans le monde"
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
        {isFetching && <Loader2 className="size-4 animate-spin text-cyan-300" data-testid="search-loading" />}
        <button
          type="submit"
          data-testid="btn-address-search-submit"
          disabled={!results.length}
          className="rounded-lg bg-signal px-3 py-1.5 text-xs font-semibold text-[#042F2E] transition-[opacity,transform] duration-150 hover:brightness-110 active:scale-95 disabled:opacity-40"
        >
          Y aller
        </button>
      </form>
      {open && dq.length >= 3 && (
        <ul
          data-testid="search-results"
          className="absolute top-full right-0 left-0 z-30 mt-2 max-h-80 animate-rise-in overflow-auto rounded-xl border border-slate-700/60 bg-slate-950/95 p-1 shadow-2xl backdrop-blur-xl"
        >
          {results.length === 0 && !isFetching && (
            <li className="px-3 py-2 text-xs text-slate-400" data-testid="search-empty">
              {isError ? "Recherche indisponible pour le moment." : "Aucun résultat trouvé."}
            </li>
          )}
          {results.map((r, i) => (
            <li key={`${r.lat},${r.lon},${i}`}>
              <button
                type="button"
                data-testid={`search-result-${i}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(r)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors duration-150",
                  i === active ? "bg-cyan-500/10" : "hover:bg-slate-800/60",
                )}
              >
                {r.source === "osm" ? (
                  <Landmark className="mt-0.5 size-4 shrink-0 text-sky" />
                ) : (
                  <MapPin className="mt-0.5 size-4 shrink-0 text-signal" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-100">{r.label}</span>
                  <span className="block truncate text-xs text-slate-400">{r.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
