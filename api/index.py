"""Point d'entrée Vercel — la même application FastAPI que backend/server.py.

Vercel exécute ce fichier comme fonction Python serverless et lui passe la requête.
Selon la règle de réécriture, le chemin arrive avec ou sans le préfixe /api : on le
normalise avant de passer la main à l'application, qui déclare toutes ses routes sous /api.

Rien d'autre n'est dupliqué ici : le backend local et la version déployée sont le même code.
"""

import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RACINE / "backend"))

from server import app as _app  # noqa: E402


class _NormaliseChemin:
    """Remet le chemin sous /api avant l'application (Vercel peut le réécrire en /api/index)."""

    def __init__(self, application):
        self.application = application

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            chemin = scope.get("path") or "/"
            if chemin in ("/api", "/api/", "/api/index", "/api/index.py"):
                chemin = "/api/"
            elif not chemin.startswith("/api/"):
                chemin = "/api" + ("" if chemin.startswith("/") else "/") + chemin
            scope["path"] = chemin
            scope["raw_path"] = chemin.encode()
        await self.application(scope, receive, send)


# Vercel détecte une application ASGI exportée sous le nom `app`.
app = _NormaliseChemin(_app)
handler = app
