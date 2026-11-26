"""Cache local (SQLite) — remplace les collections MongoDB `tiles`, `terrain` et `street_styles`.

Même rôle que la version Mongo : survivre aux redémarrages, mutualiser les appels
sortants, expirer les entrées par TTL. En plus simple : un fichier, aucun serveur à
installer, aucun compte, aucune clé.

Le schéma tient en une table générique (kind, key) — les trois usages n'ont pas besoin
de plus. TTL par défaut : voir les constantes des routeurs.
"""

import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DB_PATH = Path(os.environ.get("CACHE_DB") or (Path(__file__).resolve().parent.parent / "data" / "cache.sqlite3"))

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
    return _conn


def init() -> None:
    """Crée le fichier et la table si besoin. Appelé une fois au démarrage du serveur."""
    with _lock:
        conn = _connect()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cache (
                kind       TEXT NOT NULL,
                key        TEXT NOT NULL,
                blob       BLOB,
                fetched_at REAL NOT NULL,
                expires_at REAL,
                PRIMARY KEY (kind, key)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS cache_expires ON cache(expires_at)")
        conn.commit()
    logger.info("cache SQLite prêt : %s", DB_PATH)


def get(kind: str, key: str) -> bytes | None:
    """Renvoie les octets en cache, ou None si absent/expiré."""
    with _lock:
        row = _connect().execute(
            "SELECT blob, expires_at FROM cache WHERE kind = ? AND key = ?", (kind, key)
        ).fetchone()
    if row is None:
        return None
    blob, expires_at = row
    if expires_at is not None and expires_at < time.time():
        return None
    return blob


def put(kind: str, key: str, blob: bytes, ttl: float | None = None) -> None:
    now = time.time()
    expires_at = now + ttl if ttl else None
    with _lock:
        conn = _connect()
        conn.execute(
            """
            INSERT INTO cache (kind, key, blob, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(kind, key) DO UPDATE SET
                blob = excluded.blob, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
            """,
            (kind, key, blob, now, expires_at),
        )
        conn.commit()


def get_json(kind: str, key: str) -> Any | None:
    blob = get(kind, key)
    if blob is None:
        return None
    try:
        return json.loads(blob)
    except ValueError:  # entrée corrompue : on la laisse expirer plutôt que de planter
        logger.warning("entrée de cache illisible : %s/%s", kind, key)
        return None


def put_json(kind: str, key: str, value: Any, ttl: float | None = None) -> None:
    put(kind, key, json.dumps(value, separators=(",", ":")).encode(), ttl)


def purge_expired() -> int:
    with _lock:
        conn = _connect()
        removed = conn.execute("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at < ?", (time.time(),)).rowcount
        conn.commit()
    return removed


def stats() -> dict:
    """Petit état des lieux, utile pour vérifier que le cache travaille (et pour /api/cache)."""
    with _lock:
        rows = _connect().execute(
            "SELECT kind, COUNT(*), COALESCE(SUM(LENGTH(blob)), 0) FROM cache GROUP BY kind"
        ).fetchall()
    return {kind: {"entries": n, "bytes": size} for kind, n, size in rows}
