import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const ROWS: [string, string][] = [
  ["Z Q S D  /  W A S D  /  flèches", "Avancer, gauche, reculer, droite"],
  ["Souris (clic dans la vue)", "Regarder autour — Échap pour libérer"],
  ["Glisser", "Regarder sans verrouiller la souris"],
  ["Maj", "Courir / accélérer le vol"],
  ["V", "Basculer à pied ↔ survol"],
  ["Espace / E", "Monter (survol)"],
  ["C / Ctrl", "Descendre (survol)"],
];

export function KeyRows() {
  return (
    <div className="divide-y divide-slate-800">
      {ROWS.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-6 py-2">
          <kbd className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[11px] text-signal">{k}</kbd>
          <span className="text-right text-sm text-slate-300">{v}</span>
        </div>
      ))}
    </div>
  );
}

export type Panneaux = { position: boolean; anticipation: boolean };

const PANNEAUX: [keyof Panneaux, string][] = [
  ["position", "Position (coordonnées, cap, altitude)"],
  ["anticipation", "Anticipation (zones prêtes)"],
];

/** Menu unique de l'app : les commandes, et les trois panneaux qu'on rallume à la demande.
 *  L'écran principal est volontairement nu : une carte, la recherche, et rien d'autre. */
export default function HelpDialog({ open, onOpenChange, panneaux, onToggle, plan, onPlan }:
  { open: boolean; onOpenChange: (o: boolean) => void; panneaux: Panneaux; onToggle: (k: keyof Panneaux) => void; plan: boolean; onPlan: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-cyan-500/20 bg-slate-950/95 backdrop-blur-2xl sm:max-w-lg" data-testid="controls-help-dialog">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl tracking-[-0.03em]">Menu</DialogTitle>
          <DialogDescription>Claviers AZERTY et QWERTY reconnus automatiquement.</DialogDescription>
        </DialogHeader>
        <button
          onClick={onPlan}
          className="flex w-full items-center justify-between gap-4 rounded-lg border border-cyan-500/30 bg-slate-900/60 px-3 py-2 text-left text-sm text-slate-100 transition-colors hover:border-cyan-400/60 hover:bg-slate-800/70"
        >
          <span>Mini-plan (coin bas gauche)</span>
          <span className="text-signal">{plan ? "affiché" : "masqué"}</span>
        </button>
        <div className="space-y-1" data-testid="panneaux-toggles">
          {PANNEAUX.map(([cle, label]) => (
            <button
              key={cle}
              onClick={() => onToggle(cle)}
              className="flex w-full items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:border-cyan-400/40 hover:bg-slate-800/70"
            >
              <span>{label}</span>
              <span className={panneaux[cle] ? "text-signal" : "text-slate-600"}>{panneaux[cle] ? "affiché" : "masqué"}</span>
            </button>
          ))}
        </div>
        <KeyRows />
        <p className="text-xs text-slate-500">
          Données 100 % gratuites : © contributeurs OpenStreetMap (OpenFreeMap), relief AWS Terrarium,
          météo Open-Meteo, empreintes Microsoft Building Footprints (ODbL).
        </p>
      </DialogContent>
    </Dialog>
  );
}
