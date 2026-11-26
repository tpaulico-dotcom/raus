// Hand-written mirrors of backend/models/tiles.py — keep in sync with the Pydantic models.

export interface TileBuilding {
  h: number;
  mh: number;
  rings: number[][];
  church: boolean;
}

export interface TileLine {
  kind: string;
  name: string | null;
  bridge: boolean;
  tunnel: boolean;
  ramp: boolean;
  pts: number[];
}

export interface TileArea {
  kind: string;
  rings: number[][];
}

export interface TilePoi {
  name: string;
  kind: string;
  x: number;
  y: number;
}

export interface TilePlace {
  name: string;
  kind: string; // city | town | village | hamlet | suburb | neighbourhood
  x: number;
  y: number;
  rank: number;
}

export interface TileData {
  z: number;
  x: number;
  y: number;
  extent: number;
  buildings: TileBuilding[];
  roads: TileLine[];
  waterways: TileLine[];
  areas: TileArea[];
  names: TileLine[];
  pois: TilePoi[];
  places: TilePlace[];
}

export interface GeoResult {
  label: string;
  sub: string;
  lat: number;
  lon: number;
  kind: string;
  source: string;
}

// Mirrors backend/models/tiles.py TerrainGrid
export interface TerrainGrid {
  z: number;
  x: number;
  y: number;
  size: number;
  heights: number[];
}
