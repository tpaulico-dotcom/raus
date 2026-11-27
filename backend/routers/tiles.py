import asyncio
import io
import logging
import re
import zlib
from typing import List

import httpx
from fastapi import APIRouter, HTTPException, Query, Response
from PIL import Image

from lib import cache, empreintes
from lib.vector_tiles import EXTENT, PLACE_CLASSES, _flat, _lines, _safe_shape, fetch_raw_tile, reduce_tile
from models.tiles import GeoResult, TerrainGrid, TileData

logger = logging.getLogger(__name__)
router = APIRouter()

TILE_ZOOM = 14
CACHE_VERSION = 16
TILE_TTL = 30 * 24 * 3600
TERRAIN_TTL = 30 * 24 * 3600
TERRAIN_SIZE = 129
HEADERS = {"User-Agent": "RAUS/1.0 (open-source 3D world engine)"}

_inflight: dict[str, asyncio.Future] = {}
_geo_cache: dict[str, list[dict]] = {}


def _encode(z: int, x: int, y: int, raw: dict | None, emp: list[dict] | None = None, coarse: bool = False) -> bytes:
    reduced = reduce_tile(z, x, y, raw, coarse=coarse)
    if emp and not coarse:
        boites = []
        for b in reduced.get("buildings") or []:
            for f in b.get("rings") or []:
                xs, ys = f[0::2], f[1::2]
                if xs and ys:
                    boites.append((min(xs), min(ys), max(xs), max(ys)))
        gardees = []
        for e in emp:
            f = e["rings"][0]
            cx = sum(f[0::2]) / (len(f) // 2)
            cy = sum(f[1::2]) / (len(f) // 2)
            if any(x0 - 2 <= cx <= x1 + 2 and y0 - 2 <= cy <= y1 + 2 for (x0, y0, x1, y1) in boites):
                continue
            gardees.append(e)
        if gardees:
            reduced["buildings"] = (reduced.get("buildings") or []) + gardees
    return TileData(**reduced).model_dump_json().encode()


async def _fill_empreintes(z: int, x: int, y: int, key: str) -> None:
    """Complète les villages non mappés dans OSM avec les empreintes satellite Microsoft (ODbL)."""
    try:
        await asyncio.sleep(1.0)
        emp = await asyncio.to_thread(empreintes.empreintes, z, x, y)
        if not emp:
            return
        raw = await fetch_raw_tile(z, x, y)
        data = await asyncio.to_thread(_encode, z, x, y, raw, emp)
        cache.put("tiles", key, zlib.compress(data, 6), ttl=TILE_TTL)
    except Exception as exc:
        logger.warning("empreintes %s : %s", key, exc)


def _json(body: bytes) -> Response:
    return Response(content=body, media_type="application/json", headers={"Cache-Control": "no-store"})


@router.get("/tiles/{z}/{x}/{y}", response_model=TileData)
async def get_tile(z: int, x: int, y: int, lod: str = Query("detail", pattern="^(detail|coarse)$")):
    """`lod=coarse` : tuile allégée pour la vue lointaine (terrain, eau, grands axes, noms de
    villes — sans bâtiments ni POI). 95 % moins de calcul et de poids, pour un survol fluide."""
    if z != TILE_ZOOM:
        raise HTTPException(status_code=400, detail=f"only zoom {TILE_ZOOM} is served")
    n = 2 ** z
    if not (0 <= x < n and 0 <= y < n):
        raise HTTPException(status_code=404, detail="tile out of range")
    coarse = lod == "coarse"
    key = f"v{CACHE_VERSION}/{lod}/{z}/{x}/{y}"
    cached = cache.get("tiles", key)
    if cached:
        return _json(zlib.decompress(cached))

    fut = _inflight.get(key)
    if fut is None:
        fut = asyncio.get_running_loop().create_future()
        _inflight[key] = fut
        try:
            raw = await fetch_raw_tile(z, x, y)
            data = await asyncio.to_thread(_encode, z, x, y, raw, None, coarse)
            cache.put("tiles", key, zlib.compress(data, 6), ttl=TILE_TTL)
            if not coarse and (not raw or len(raw.get("building", {}).get("features", [])) < 5):
                asyncio.get_running_loop().create_task(_fill_empreintes(z, x, y, key))
            fut.set_result(data)
        except Exception as exc:
            logger.warning("tile %s failed: %s", key, exc)
            fut.set_exception(exc)
        finally:
            _inflight.pop(key, None)
    try:
        return _json(await asyncio.shield(fut))
    except Exception:
        raise HTTPException(status_code=502, detail="map data source unavailable, retry shortly")


async def _ban_api(client: httpx.AsyncClient, q: str) -> list[dict]:
    r = await client.get("https://api-adresse.data.gouv.fr/search/", params={"q": q, "limit": 5},
                         headers=HEADERS, timeout=10)
    r.raise_for_status()
    res = []
    for f in r.json().get("features", []):
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        res.append({"label": p.get("label", q), "sub": p.get("context", ""), "lat": lat, "lon": lon,
                    "kind": p.get("type", "address"), "source": "ban", "_score": p.get("score", 0)})
    return res


def _tokens(s: str) -> set[str]:
    return {t for t in re.findall(r"[0-9a-zà-ÿ']+", s.lower()) if len(t) > 1}


async def _nominatim(client: httpx.AsyncClient, q: str) -> list[dict]:
    r = await client.get("https://nominatim.openstreetmap.org/search",
                         params={"q": q, "format": "json", "limit": 6, "accept-language": "fr"},
                         headers=HEADERS, timeout=10)
    r.raise_for_status()
    want = _tokens(q)
    res = []
    for it in r.json():
        dn = it.get("display_name", "")
        parts = dn.split(", ")
        got = _tokens(dn)
        score = len(want & got) / len(want) if want else 0.5
        res.append({"label": parts[0] if parts else q, "sub": ", ".join(parts[1:4]),
                    "lat": float(it["lat"]), "lon": float(it["lon"]), "kind": it.get("type", "place"),
                    "source": "osm", "_score": round(min(0.98, score), 2), "_dn": dn.lower()})
    res.sort(key=lambda x: -x["_score"])
    return res


@router.get("/geocode", response_model=List[GeoResult])
async def geocode(q: str = Query(..., min_length=3, max_length=200)):
    """Géocodage mondial : BAN (France) + OSM Nominatim (monde entier)."""
    key = q.strip().lower()
    if key in _geo_cache:
        return _geo_cache[key]
    async with httpx.AsyncClient() as client:
        ban, osm = await asyncio.gather(_ban_api(client, q), _nominatim(client, q), return_exceptions=True)
        ban = ban if isinstance(ban, list) else []
        if not isinstance(osm, list):
            logger.warning("géocodage Nominatim indisponible pour %r : %s", q, osm)
            osm = []
        # Les noms locaux diffèrent souvent de l'usage courant (« Quinta do Monte Leal » sur
        # Google, « Monte Leal » dans OSM). Le vrai toponyme, c'est la FIN du nom : si les
        # deux derniers mots n'apparaissent nulle part d'un seul tenant, on réessaie sur eux.
        words = q.split()
        if len(words) >= 3:
            tail = " ".join(words[-2:]).lower()
            if not any(tail in r["_dn"] for r in osm):
                retry = await _nominatim(client, " ".join(words[-2:]))
                if retry:
                    osm = retry + osm
    best_ban = max((b["_score"] for b in ban), default=0)
    results = (ban[:5] + osm[:3]) if best_ban >= 0.75 else (osm[:5] + ban[:3])
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in results][:8]
    if clean:
        _geo_cache[key] = clean
    return clean


def _decode_terrarium(png: bytes) -> list[float]:
    im = Image.open(io.BytesIO(png)).convert("RGB")
    w, h = im.size
    px = im.load()
    out: list[float] = []
    for j in range(TERRAIN_SIZE):
        py = min(h - 1, round(j * (h - 1) / (TERRAIN_SIZE - 1)))
        for i in range(TERRAIN_SIZE):
            r, g, b = px[min(w - 1, round(i * (w - 1) / (TERRAIN_SIZE - 1))), py]
            out.append(round(r * 256 + g + b / 256 - 32768, 1))
    return out


@router.get("/terrain/{z}/{x}/{y}", response_model=TerrainGrid)
async def get_terrain(z: int, x: int, y: int):
    """Worldwide real elevation on a 129x129 grid via AWS Terrarium tiles (free, zero key)."""
    if z != TILE_ZOOM:
        raise HTTPException(status_code=400, detail=f"only zoom {TILE_ZOOM} is served")
    n = 2 ** z
    if not (0 <= x < n and 0 <= y < n):
        raise HTTPException(status_code=404, detail="tile out of range")
    key = f"terrarium/{z}/{x}/{y}"
    cached = cache.get_json("terrain", key)
    if cached:
        return cached
    heights: list[float] | None = None
    last_exc: Exception | None = None
    async with httpx.AsyncClient() as client:
        for attempt in range(2):
            try:
                r = await client.get(
                    f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
                    timeout=15,
                )
                r.raise_for_status()
                heights = await asyncio.to_thread(_decode_terrarium, r.content)
                break
            except Exception as exc:
                last_exc = exc
                if attempt == 0:
                    await asyncio.sleep(0.3)
    if heights is None:
        logger.warning("terrarium %s failed: %s", key, last_exc)
        raise HTTPException(status_code=502, detail="elevation source unavailable")
    data = {"z": z, "x": x, "y": y, "size": TERRAIN_SIZE, "heights": heights}
    cache.put_json("terrain", key, data, ttl=TERRAIN_TTL)
    return data


OVERVIEW_ROADS = {"motorway", "trunk", "primary", "secondary"}


def _reduce_overview(z: int, x: int, y: int, raw: dict | None) -> dict:
    out: dict = {"z": z, "x": x, "y": y, "extent": EXTENT, "places": [], "roads": []}
    if not raw:
        return out
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
    for f in raw.get("transportation", {}).get("features", []):
        p = f.get("properties", {})
        cls = p.get("class", "")
        if cls not in OVERVIEW_ROADS or f["geometry"]["type"] not in ("LineString", "MultiLineString"):
            continue
        g = _safe_shape(f["geometry"])
        if g is None:
            continue
        for ln in _lines(g):
            if len(ln.coords) >= 2:
                out["roads"].append({"kind": cls, "pts": _flat(ln.coords)})
    return out


@router.get("/overview/{z}/{x}/{y}")
async def get_overview(z: int, x: int, y: int):
    """Tuile régionale légère (z=9, ~55 km) pour la mini-map en mode survol : villes + grands axes."""
    if z != 9:
        raise HTTPException(status_code=400, detail="only zoom 9 is served")
    n = 2 ** z
    if not (0 <= x < n and 0 <= y < n):
        raise HTTPException(status_code=404, detail="tile out of range")
    key = f"ov1/{z}/{x}/{y}"
    cached = cache.get_json("overview", key)
    if cached:
        return cached
    try:
        raw = await fetch_raw_tile(z, x, y)
        data = await asyncio.to_thread(_reduce_overview, z, x, y, raw)
    except Exception as exc:
        logger.warning("overview %s failed: %s", key, exc)
        raise HTTPException(status_code=502, detail="overview source unavailable")
    cache.put_json("overview", key, data, ttl=TILE_TTL)
    return data


@router.get("/reverse")
async def reverse_geocode(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    """Ville / village + pays (+ rue si connue) via Nominatim, mis en cache par cellule ~500 m."""
    key = f"r2/{round(lat * 200) / 200:.3f},{round(lon * 200) / 200:.3f}"
    cached = cache.get_json("reverse", key)
    if cached:
        return cached
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "format": "json", "zoom": 14, "accept-language": "fr"},
                headers=HEADERS,
                timeout=8,
            )
            r.raise_for_status()
            payload = r.json()
    except Exception as exc:
        logger.warning("reverse %s failed: %s", key, exc)
        return {"city": "", "country": "", "road": ""}
    addr = payload.get("address") or {}
    # Du plus PRÉCIS au plus large : à Monte Leal (Portugal), Nominatim renvoie à la fois
    # `hamlet: Monte Leal` (le hameau où l'on est) et `city: Fundão` (la commune, 8 km plus
    # loin). Prendre `city` en premier effaçait le nom du village — le hameau passe d'abord.
    city = (
        addr.get("hamlet") or addr.get("isolated_dwelling") or addr.get("village")
        or addr.get("town") or addr.get("city") or addr.get("municipality") or ""
    )
    if not city and payload.get("addresstype") in ("hamlet", "village", "town", "city"):
        city = payload.get("name") or ""
    country = addr.get("country") or ""
    road = addr.get("road") or addr.get("pedestrian") or ""
    res = {"city": city, "country": country, "road": road}
    if city or country:
        cache.put_json("reverse", key, res, ttl=TILE_TTL)
    return res