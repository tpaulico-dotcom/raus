"""Compact 3D-ready tile payloads. Coordinates are integer tile units (0..extent, y pointing south)."""

from typing import List, Optional

from pydantic import BaseModel


class TileBuilding(BaseModel):
    h: float  # top height in metres
    mh: float = 0  # base height (for parts floating above ground)
    rings: List[List[int]]  # first ring = outer, others = holes; flat [x0,y0,x1,y1,...]
    church: bool = False


class TileLine(BaseModel):
    kind: str
    name: Optional[str] = None
    bridge: bool = False  # tablier : la voie passe au-dessus du sol
    tunnel: bool = False  # souterraine : seul le debouche se voit
    ramp: bool = False  # amorce de rampe d'un pont (montee progressive)
    pts: List[int]


class TileArea(BaseModel):
    kind: str
    rings: List[List[int]]


class TilePoi(BaseModel):
    name: str
    kind: str
    x: int
    y: int


class TilePlace(BaseModel):
    name: str
    kind: str  # city | town | village | hamlet | suburb | neighbourhood
    x: int
    y: int
    rank: int = 99  # 1 = métropole ; sert à n'afficher que les lieux notables


class TileData(BaseModel):
    z: int
    x: int
    y: int
    extent: int = 4096
    buildings: List[TileBuilding] = []
    roads: List[TileLine] = []
    waterways: List[TileLine] = []
    areas: List[TileArea] = []
    names: List[TileLine] = []
    pois: List[TilePoi] = []
    places: List[TilePlace] = []


class GeoResult(BaseModel):
    label: str
    sub: str = ""
    lat: float
    lon: float
    kind: str = "address"
    source: str = "ban"


class TerrainGrid(BaseModel):
    z: int
    x: int
    y: int
    size: int  # samples per side; sample i covers tile fraction i / (size - 1)
    heights: List[float]  # metres above sea level, row-major from the north-west corner
