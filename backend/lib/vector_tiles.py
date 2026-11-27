"""Fetch real OpenStreetMap vector tiles (OpenFreeMap, OpenMapTiles schema) and reduce them
to a compact, 3D-ready payload: buildings with heights, roads, water, land cover, names, POIs."""

import asyncio
import gzip
import logging
import time
from typing import Any

import httpx
import mapbox_vector_tile
from shapely.geometry import LineString, MultiLineString, Point, Polygon, shape
from shapely.geometry.base import BaseGeometry

logger = logging.getLogger(__name__)

TILEJSON_URL = "https://tiles.openfreemap.org/planet"
HEADERS = {"User-Agent": "RAUS/1.0 (three.js world engine)"}
EXTENT = 4096

_template: dict[str, Any] = {"url": None, "at": 0.0}

# CGU OpenFreeMap : au maximum 4 requêtes simultanées vers le service public.
_UPSTREAM = asyncio.Semaphore(4)


async def _tile_template(client: httpx.AsyncClient) -> str:
    if _template["url"] and time.time() - _template["at"] < 6 * 3600:
        return _template["url"]
    r = await client.get(TILEJSON_URL, headers=HEADERS, timeout=15)
    r.raise_for_status()
    _template["url"] = r.json()["tiles"][0]
    _template["at"] = time.time()
    return _template["url"]


async def fetch_raw_tile(z: int, x: int, y: int) -> dict | None:
    async with httpx.AsyncClient(follow_redirects=True) as client:
        tpl = await _tile_template(client)
        url = tpl.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
        # CGU OpenFreeMap : au plus 4 requêtes simultanées vers le service. Le cache SQLite
        # évite d'y revenir, mais une rafale de tuiles ne doit jamais dépasser cette borne.
        async with _UPSTREAM:
            r = await client.get(url, headers=HEADERS, timeout=25)
        if r.status_code in (204, 404):
            return None
        r.raise_for_status()
        data = r.content
    if not data:
        return None
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return mapbox_vector_tile.decode(data, default_options={"y_coord_down": True})


def _flat(coords) -> list[int]:
    out: list[int] = []
    for c in coords:
        out.append(int(round(c[0])))
        out.append(int(round(c[1])))
    return out


def _polys(geom: BaseGeometry) -> list[Polygon]:
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if hasattr(geom, "geoms"):
        res: list[Polygon] = []
        for g in geom.geoms:
            res.extend(_polys(g))
        return res
    return []


def _lines(geom: BaseGeometry) -> list[LineString]:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if hasattr(geom, "geoms"):
        res: list[LineString] = []
        for g in geom.geoms:
            res.extend(_lines(g))
        return res
    return []


def _rings(p: Polygon) -> list[list[int]]:
    rings = [_flat(p.exterior.coords)]
    for hole in p.interiors:
        if len(hole.coords) >= 4:
            rings.append(_flat(hole.coords))
    return rings


def _safe_shape(geometry: dict) -> BaseGeometry | None:
    try:
        g = shape(geometry)
        if not g.is_valid:
            g = g.buffer(0)
        return g
    except Exception:  # malformed feature: skip it, never fail the tile
        return None


ROAD_KIND = {
    "motorway": "motorway", "trunk": "trunk", "primary": "primary", "secondary": "secondary",
    "tertiary": "tertiary", "minor": "minor", "service": "service", "track": "track",
    "path": "path", "rail": "rail", "transit": "rail", "busway": "minor", "raceway": "minor",
}

LANDCOVER_KIND = {"wood": "wood", "grass": "grass", "farmland": "farmland", "sand": "sand",
                  "wetland": "grass", "rock": "rock", "ice": "rock"}
LANDUSE_KIND = {"residential": "residential", "commercial": "urban", "industrial": "urban",
                "retail": "urban", "school": "urban", "university": "urban", "hospital": "urban",
                "cemetery": "cemetery", "stadium": "pitch", "pitch": "pitch", "playground": "grass",
                "railway": "urban", "garages": "urban", "college": "urban", "kindergarten": "urban"}
PARK_KIND = {"park": "park", "garden": "park"}
POI_CLASSES = {"place_of_worship", "town_hall", "museum", "castle", "monument", "attraction",
               "theatre", "library", "art_gallery", "historic", "fountain", "cinema", "college",
               "school", "hospital", "railway", "townhall", "stadium", "zoo"}
PLACE_CLASSES = {"city", "town", "village", "hamlet", "suburb", "neighbourhood"}

# Vue lointaine (survol haut) : seuls ces axes sont envoyés. Le reste — rues de quartier,
# chemins, bâtiments, numéros, noms de rue — n'est pas visible à cette distance.
MAJOR_KINDS = {"motorway", "trunk", "primary", "secondary"}


def reduce_tile(z: int, x: int, y: int, raw: dict | None, coarse: bool = False) -> dict:
    out: dict[str, Any] = {"z": z, "x": x, "y": y, "extent": EXTENT, "buildings": [], "roads": [],
                           "waterways": [], "areas": [], "names": [], "pois": [], "places": []}
    if not raw:
        return out
    box = (0, 0, EXTENT, EXTENT)

    # POIs (needed first: churches mark their building)
    churches: list[Point] = []
    if not coarse:
        for f in raw.get("poi", {}).get("features", []):
            p = f.get("properties", {})
            g = f.get("geometry", {})
            if g.get("type") != "Point":
                continue
            cx, cy = g["coordinates"]
            cls = p.get("class", "")
            if cls == "place_of_worship" and p.get("subclass") == "christian":
                churches.append(Point(cx, cy))
            if not (0 <= cx < EXTENT and 0 <= cy < EXTENT):
                continue
            name = p.get("name")
            if name and cls in POI_CLASSES:
                out["pois"].append({"name": name, "kind": cls, "x": int(cx), "y": int(cy)})

    # Lieux habités : nom + rang, pour les étiquettes de villes en vue aérienne
    for f in raw.get("place", {}).get("features", []):
        p = f.get("properties", {})
        g = f.get("geometry", {})
        if g.get("type") != "Point":
            continue
        cx, cy = g["coordinates"]
        name = p.get("name")
        cls = p.get("class", "")
        if not name or cls not in PLACE_CLASSES or not (0 <= cx < EXTENT and 0 <= cy < EXTENT):
            continue
        rank = p.get("rank")
        out["places"].append({"name": name, "kind": cls, "x": int(cx), "y": int(cy),
                              "rank": int(rank) if isinstance(rank, (int, float)) else 99})

    # Buildings: keep a building in the tile owning its centroid (no duplicates across tiles)
    if coarse:
        # Vue lointaine : on GARDE les bâtiments, on retire seulement le travail fin —
        # validité shapely, recherche d'église, murs de moins de ~40 m² (invisibles à 3 km).
        # Sans cette voie rapide, la réduction coûtait 3,5 s par tuile.
        for f in raw.get("building", {}).get("features", []):
            p = f.get("properties", {})
            if p.get("hide_3d"):
                continue
            geom = f["geometry"]
            gt = geom["type"]
            if gt == "Polygon":
                polys = [geom["coordinates"]]
            elif gt == "MultiPolygon":
                polys = geom["coordinates"]
            else:
                continue
            h = float(p.get("render_height") or 0)
            mh = float(p.get("render_min_height") or 0)
            top = max(h, mh + 2.5)
            for ring in polys:
                outer = ring[0] if ring else []
                n = len(outer) - 1 if len(outer) > 1 and outer[0] == outer[-1] else len(outer)
                if n < 3:
                    continue
                sx = sy = 0.0
                minx = miny = 1e9
                maxx = maxy = -1e9
                area2 = 0.0
                for i in range(n):
                    ax, ay = outer[i][0], outer[i][1]
                    bx, by = outer[(i + 1) % n][0], outer[(i + 1) % n][1]
                    sx += ax
                    sy += ay
                    if ax < minx: minx = ax
                    if ax > maxx: maxx = ax
                    if ay < miny: miny = ay
                    if ay > maxy: maxy = ay
                    area2 += ax * by - bx * ay
                cx, cy = sx / n, sy / n
                if not (0 <= cx < EXTENT and 0 <= cy < EXTENT) or abs(area2) / 2 < 250:
                    continue
                out["buildings"].append({
                    "h": top, "mh": mh,
                    "rings": [_flat(outer)] + [_flat(h_) for h_ in ring[1:] if len(h_) >= 4],
                    "church": False,
                })
    else:
        for f in raw.get("building", {}).get("features", []):
            p = f.get("properties", {})
            if p.get("hide_3d"):
                continue
            g = _safe_shape(f["geometry"])
            if g is None:
                continue
            h = float(p.get("render_height") or 0)
            mh = float(p.get("render_min_height") or 0)
            for poly in _polys(g):
                c = poly.centroid
                if not (0 <= c.x < EXTENT and 0 <= c.y < EXTENT) or poly.area < 4:
                    continue
                minx, miny, maxx, maxy = poly.bounds
                church = any(
                    minx - 6 <= pt.x <= maxx + 6 and miny - 6 <= pt.y <= maxy + 6 and poly.distance(pt) <= 6
                    for pt in churches
                )
                top = max(h, mh + 2.5)
                if church and top < 14:
                    top = 14.0
                out["buildings"].append({"h": top, "mh": mh, "rings": _rings(poly),
                                         "church": church})

    # Roads, rails, paths. Tunnels are kept but flagged: their carriageway is underground,
    # so the client draws only the tunnel mouths; bridges are raised onto a deck.
    for f in raw.get("transportation", {}).get("features", []):
        p = f.get("properties", {})
        kind = ROAD_KIND.get(p.get("class", ""))
        if not kind:
            continue
        brunnel = p.get("brunnel")
        if kind == "path" and p.get("subclass") in ("pedestrian",) and f["geometry"]["type"] in ("Polygon", "MultiPolygon"):
            g = _safe_shape(f["geometry"])
            if g is None:
                continue
            for poly in _polys(g.intersection(Polygon.from_bounds(*box))):
                out["areas"].append({"kind": "plaza", "rings": _rings(poly)})
            continue
        if f["geometry"]["type"] not in ("LineString", "MultiLineString"):
            continue
        g = _safe_shape(f["geometry"])
        if g is None:
            continue
        sub = p.get("subclass") or ""
        if kind == "path" and sub in ("pedestrian", "footway", "steps"):
            kind = "pedestrian"
        for ln in _lines(g.intersection(Polygon.from_bounds(*box))):
            if len(ln.coords) >= 2:
                out["roads"].append({"kind": kind, "bridge": brunnel == "bridge",
                                     "tunnel": brunnel == "tunnel",
                                     "ramp": p.get("ramp") == 1,
                                     "pts": _flat(ln.coords)})

    # Street names (for the HUD "you are on ..." label)
    for f in ([] if coarse else raw.get("transportation_name", {}).get("features", [])):
        p = f.get("properties", {})
        name = p.get("name")
        if not name or f["geometry"]["type"] not in ("LineString", "MultiLineString"):
            continue
        g = _safe_shape(f["geometry"])
        if g is None:
            continue
        for ln in _lines(g):
            out["names"].append({"kind": p.get("class", "minor"), "name": name, "pts": _flat(ln.coords)})

    # Waterways (rivers, canals, streams)
    for f in raw.get("waterway", {}).get("features", []):
        p = f.get("properties", {})
        if p.get("brunnel") == "tunnel":
            continue
        g = _safe_shape(f["geometry"])
        if g is None:
            continue
        for ln in _lines(g.intersection(Polygon.from_bounds(*box))):
            if len(ln.coords) >= 2:
                out["waterways"].append({"kind": p.get("class", "stream"), "name": p.get("name"),
                                         "pts": _flat(ln.coords)})

    # Flat areas: water, landcover, landuse, parks
    def add_areas(layer: str, mapping: dict[str, str] | None, fixed: str | None = None):
        for f in raw.get(layer, {}).get("features", []):
            p = f.get("properties", {})
            kind = fixed or (mapping or {}).get(p.get("class", ""))
            if not kind or f["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
                continue
            g = _safe_shape(f["geometry"])
            if g is None:
                continue
            clipped = g.intersection(Polygon.from_bounds(*box))
            for poly in _polys(clipped):
                if poly.area < (400 if coarse else 20):
                    continue
                if len(poly.exterior.coords) > (120 if coarse else 400):
                    poly = poly.simplify(4.0 if coarse else 1.5)
                    if poly.is_empty or poly.geom_type != "Polygon":
                        continue
                out["areas"].append({"kind": kind, "rings": _rings(poly)})

    add_areas("landuse", LANDUSE_KIND)
    add_areas("landcover", LANDCOVER_KIND)
    add_areas("park", PARK_KIND)
    add_areas("water", None, fixed="water")
    return out


_ = (MultiLineString,)  # re-exported type hints kept explicit for readers