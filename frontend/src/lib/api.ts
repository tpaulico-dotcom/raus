// Typed fetch layer over the FastAPI backend. Base is the relative "/api" prefix so the
// same code works in dev (Vite proxies /api → :8001) and behind a single origin in prod.
const BASE = "/api";

// Fields are declared, not constructor parameter properties: tsconfig sets
// erasableSyntaxOnly, which rejects `constructor(readonly status: number)`.
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`request failed with ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type JsonBody = unknown;

async function request<T>(method: string, path: string, body?: JsonBody): Promise<T> {
  // Auth rides the httpOnly session cookie automatically — never add auth headers here.
  const res = await fetch(`${BASE}${path}`, {
    method,
    // Aucune réponse de l'API ne doit être rejouée depuis un cache : une tuile dont le CONTENU
    // se remplit en tâche de fond (adresses, empreintes de bâtiments) garde la même apparence,
    // et le navigateur resservait une version ancienne — y compris depuis le worker, où un
    // rechargement forcé ne l'atteint pas. Interroger l'API, c'est l'interroger pour de vrai.
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // FastAPI reports request-validation failures as 422 with a {detail: [...]} body.
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new ApiError(res.status, errBody);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// The response type is yours to declare: nothing infers across the Python boundary, so a
// TS interface here mirrors the endpoint's Pydantic model by hand — keep the two in sync.
export const apiGet = <T>(path: string) => request<T>("GET", path);

let tileVersionCache: string | null = null;

/** Version de forme des tuiles, demandée une seule fois au backend.
 *
 * Les tuiles arrivent avec un cache navigateur de 24 h : l'URL doit donc porter cette
 * version, sinon une page ouverte la veille rejoue un format périmé et le moteur échoue
 * en silence (scène vide, alerte « zone cartographique »). Une seule source de vérité :
 * le backend, qui l'annonce sur /api/. */
export async function tileVersion(): Promise<string> {
  if (tileVersionCache !== null) return tileVersionCache;
  try {
    const meta = await apiGet<{ tile_version?: number | string }>("/");
    tileVersionCache = String(meta.tile_version ?? "0");
  } catch {
    tileVersionCache = "0";
  }
  return tileVersionCache;
}
export const apiPost = <T>(path: string, body?: JsonBody) => request<T>("POST", path, body ?? null);
export const apiPut = <T>(path: string, body?: JsonBody) => request<T>("PUT", path, body ?? null);
export const apiPatch = <T>(path: string, body?: JsonBody) =>
  request<T>("PATCH", path, body ?? null);
export const apiDelete = <T>(path: string) => request<T>("DELETE", path);
