// Web Mercator tile math + a local metric frame (x = east, z = south, metres) around an origin.
export const TILE_Z = 14;
export const N_TILES = 2 ** TILE_Z;
const EARTH_CIRC = 40075016.686;

export interface Origin {
  gx0: number; // origin in global tile units (float)
  gy0: number;
  mpt: number; // metres per tile unit at the origin latitude
  lat: number;
  lon: number;
}

export function lonLatToGlobal(lat: number, lon: number): { gx: number; gy: number } {
  const gx = ((lon + 180) / 360) * N_TILES;
  const r = (lat * Math.PI) / 180;
  const gy = ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * N_TILES;
  return { gx, gy };
}

export function globalToLonLat(gx: number, gy: number): { lat: number; lon: number } {
  const lon = (gx / N_TILES) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / N_TILES))) * 180) / Math.PI;
  return { lat, lon };
}

export function makeOrigin(lat: number, lon: number): Origin {
  const { gx, gy } = lonLatToGlobal(lat, lon);
  return { gx0: gx, gy0: gy, mpt: (EARTH_CIRC / N_TILES) * Math.cos((lat * Math.PI) / 180), lat, lon };
}

export function worldToGlobal(o: Origin, x: number, z: number) {
  return { gx: o.gx0 + x / o.mpt, gy: o.gy0 + z / o.mpt };
}

export function worldToLonLat(o: Origin, x: number, z: number) {
  const g = worldToGlobal(o, x, z);
  return globalToLonLat(g.gx, g.gy);
}

export function lonLatToWorld(o: Origin, lat: number, lon: number) {
  const g = lonLatToGlobal(lat, lon);
  return { x: (g.gx - o.gx0) * o.mpt, z: (g.gy - o.gy0) * o.mpt };
}

export const tileKey = (x: number, y: number) => `${TILE_Z}/${x}/${y}`;
