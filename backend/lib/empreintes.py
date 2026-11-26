"""Empreintes de bâtiments — secours quand OpenStreetMap n'a rien relevé.

Le principe demandé par l'utilisateur : la carte d'abord, et quand elle est vide, une base
d'empreintes détectées par satellite. Ici c'est le jeu Microsoft GlobalMLBuildingFootprints
(licence ouverte ODbL, dérivé d'images satellite, couvre le monde entier), publié en fichiers
plats rangés par secteur — donc accessible sans aucune dépendance : ni DuckDB, ni pyarrow,
juste gzip et csv.

Rien n'est conservé de façon permanente : on télécharge le secteur demandé, on ne garde que
les polygones de la zone où l'on se trouve (tuile + une petite marge), et ce résultat voyage
avec la tuile, donc il disparaît avec elle. Aucune base locale, comme demandé.
"""
import csv
import gzip
import io
import json
import logging
import math
import urllib.request

logger = logging.getLogger(__name__)

EXTENT = 4096
CATALOGUE = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
UA = {"User-Agent": "roadwalk-3d/1.0 (usage local)"}
# Le secteur publié par Microsoft est un carré de niveau 9 (~600 km2) : on le télécharge une
# fois par région, en mémoire seulement, et on n'en garde que la zone utile.
_catalogue: dict[str, str] = {}      # quadkey -> url
_secteurs: dict[str, list] = {}      # quadkey -> polygones (en mémoire, le temps de la session)


def quadkey(z: int, x: int, y: int) -> str:
    q = ""
    for i in range(z, 0, -1):
        d = 0
        mask = 1 << (i - 1)
        if x & mask:
            d += 1
        if y & mask:
            d += 2
        q += str(d)
    return q


def _bbox(z: int, x: int, y: int, marge_m: float = 120.0) -> tuple[float, float, float, float]:
    n = 2 ** z
    lon0 = x / n * 360 - 180
    lon1 = (x + 1) / n * 360 - 180
    lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    mlat = marge_m / 111320
    mlon = marge_m / (111320 * math.cos(math.radians((lat0 + lat1) / 2)))
    return lat0 - mlat, lon0 - mlon, lat1 + mlat, lon1 + mlon


def _to_tile(z: int, x: int, y: int, lon: float, lat: float) -> tuple[int, int]:
    n = 2 ** z
    tx = (lon + 180) / 360 * n
    ty = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return int((tx - x) * EXTENT), int((ty - y) * EXTENT)


def _charge_secteur(qk: str) -> list:
    """Télécharge le secteur (une fois par session) et renvoie ses polygones [ [lon,lat], ... ]."""
    if qk in _secteurs:
        return _secteurs[qk]
    if not _catalogue:
        try:
            txt = urllib.request.urlopen(
                urllib.request.Request(CATALOGUE, headers=UA), timeout=90
            ).read().decode("utf-8", "ignore")
            for r in csv.DictReader(io.StringIO(txt)):
                _catalogue[r.get("QuadKey", "")] = r.get("Url", "")
            logger.info("catalogue d'empreintes : %d secteurs", len(_catalogue))
        except Exception as exc:
            logger.warning("catalogue d'empreintes indisponible : %s", exc)
            _secteurs[qk] = []
            return []
    url = _catalogue.get(qk)
    if not url:
        _secteurs[qk] = []
        return []
    polygones: list = []
    try:
        data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300).read()
        with gzip.open(io.BytesIO(data), "rt", encoding="utf-8", errors="ignore") as fh:
            for ligne in fh:
                ligne = ligne.strip()
                if not ligne or ligne[0] != "{":
                    continue
                try:
                    geom = json.loads(ligne)["geometry"]["coordinates"]
                except Exception:
                    continue
                anneau = geom[0] if geom and isinstance(geom[0][0], (list, tuple)) else geom
                if len(anneau) >= 3:
                    polygones.append([(float(p[0]), float(p[1])) for p in anneau])
        logger.info("secteur %s : %d empreintes", qk, len(polygones))
    except Exception as exc:
        logger.warning("secteur d'empreintes %s : %s", qk, exc)
    _secteurs[qk] = polygones
    return polygones


def empreintes(z: int, x: int, y: int) -> list[dict]:
    """Empreintes de la zone, en coordonnées de tuile, au format des bâtiments du payload.

    Renvoie un bâtiment par empreinte, avec une hauteur plausible : ces données donnent la
    forme au sol, jamais la hauteur (l'IGN la publie pour la France, ce jeu non).
    """
    lat0, lon0, lat1, lon1 = _bbox(z, x, y)
    qk = quadkey(9, int((lon0 + 180) / 360 * 512), int((1 - math.log(math.tan(math.radians(lat0)) + 1 / math.cos(math.radians(lat0))) / math.pi) / 2 * 512))
    polys = _charge_secteur(qk)
    if not polys:
        return []
    out: list[dict] = []
    for anneau in polys:
        xs = [p[0] for p in anneau]
        ys = [p[1] for p in anneau]
        if max(xs) < lon0 or min(xs) > lon1 or max(ys) < lat0 or min(ys) > lat1:
            continue
        plat = sum(ys) / len(ys)
        plon = sum(xs) / len(xs)
        if not (lat0 <= plat <= lat1 and lon0 <= plon <= lon1):
            continue
        # une empreinte satellite, c'est une maison ou un hangar : 6 m reste plausible
        pts: list[int] = []
        for (plon2, plat2) in anneau:
            tx, ty = _to_tile(z, x, y, plon2, plat2)
            if not pts or pts[-2] != tx or pts[-1] != ty:
                pts.extend((tx, ty))
        if len(pts) >= 8:
            out.append({"rings": [pts], "h": 6.0, "mh": 0.0, "church": False, "empreinte": True})
    logger.info("tuile %s/%s/%s : %d empreintes de secours", z, x, y, len(out))
    return out
