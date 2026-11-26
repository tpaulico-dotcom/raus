export interface Preset {
  id: string;
  name: string;
  sub: string;
  lat: number;
  lon: number;
  badge: string;
}

// Place de la République, Soultz-Haut-Rhin — the default landing spot.
export const START: Preset = {
  id: "soultz",
  name: "Soultz-Haut-Rhin",
  sub: "Place de la République",
  lat: 47.88622, // géocodage BAN : « Place de la Republique 68360 Soultz-Haut-Rhin »
  lon: 7.22934,
  badge: "Alsace",
};

export const PRESETS: Preset[] = [
  START,
  { id: "colmar", name: "Colmar", sub: "Petite Venise", lat: 48.0739, lon: 7.3586, badge: "Alsace" },
  { id: "strasbourg", name: "Strasbourg", sub: "Cathédrale Notre-Dame", lat: 48.5818, lon: 7.7509, badge: "Grand Est" },
  { id: "paris", name: "Paris", sub: "Panthéon", lat: 48.84622, lon: 2.34637, badge: "Île-de-France" },
  { id: "lyon", name: "Lyon", sub: "Primatiale Saint-Jean", lat: 45.7608, lon: 4.8272, badge: "Rhône" },
  { id: "mont-saint-michel", name: "Mont-Saint-Michel", sub: "Grande Rue", lat: 48.6361, lon: -1.5115, badge: "Normandie" },
];
