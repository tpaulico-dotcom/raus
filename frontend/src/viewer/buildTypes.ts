// Geometry arrays produced off the main thread for one map tile.
export interface MeshArrays {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  col: Float32Array;
}

export type RoadMat = "major" | "minor" | "gravel" | "paving" | "rail";
export const ROAD_MATS: RoadMat[] = ["major", "minor", "gravel", "paving", "rail"];

export interface WorldPoi {
  name: string;
  kind: string;
  x: number;
  z: number;
}

/** Lieu habité (ville, village) transporté en coordonnées monde, pour les étiquettes. */
export interface WorldPlace {
  name: string;
  kind: string;
  rank: number;
  x: number;
  z: number;
}

export interface WallGroup {
  key: string; // "d" | "shop"
  arrays: MeshArrays;
}

export interface TileBuild {
  key: string;
  epoch: number;
  x: number;
  y: number;
  walls: MeshArrays;
  groundWalls: WallGroup[];
  stationSigns: MeshArrays;
  stationAtlas: ImageBitmap | null;
  terrain: MeshArrays;
  groundImage: ImageBitmap | null;
  heights: Float32Array;
  hSize: number;
  monuments: Float32Array; // stride 4: x, y, z, radius (éclairage nocturne bâtiments publics)
  plainWalls: MeshArrays;
  roofs: MeshArrays;
  roads: Record<RoadMat, MeshArrays>; // ponts & portails de tunnels uniquement
  trees: Float32Array; // stride 6: x, y, z, scale, type (0 leafy, 1 conifer), shade
  fpCoords: Float32Array; // footprint rings (x,z pairs)
  fpStarts: Int32Array;
  fpBoxes: Float32Array;
  nameSegs: Float32Array; // stride 5: x1, z1, x2, z2, nameIndex
  nameList: string[];
  spawnPts: Float32Array; // stride 2
  pois: WorldPoi[];
  places: WorldPlace[];
  /** Tabliers de pont, en mètres locaux : la marche les suit au lieu de passer dessous. */
  decks: { pts: number[]; y: number; hw: number; base: number }[];
  stats: { buildings: number; roads: number; buildMs: number };
}

export interface BuildRequest {
  type: "build";
  key: string;
  x: number;
  y: number;
  epoch: number;
  origin: { gx0: number; gy0: number; mpt: number };
}

export type WorkerReply =
  | { type: "built"; build: TileBuild }
  | { type: "error"; key: string; epoch: number; message: string };
