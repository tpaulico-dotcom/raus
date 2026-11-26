/** Météo et éclairage en direct pour la position courante (Open-Meteo, gratuit, sans clé).
 *
 *  - Calcule la vraie position du soleil (élévation, azimut) à partir de (lat, lon, heure UTC).
 *  - Interroge Open-Meteo une fois par zone (~10 km, cache 10 min) pour connaître la couverture
 *    nuageuse, la pluie, la neige, le brouillard, l'orage, le vent et la température réels.
 */

export type PrecipKind = "none" | "rain" | "snow";

export interface LiveWeather {
  lat: number;
  lon: number;
  temp: number;           // °C
  code: number;           // code WMO
  clouds: number;         // 0..1
  precip: PrecipKind;
  precipIntensity: number;// 0..1
  foggy: boolean;
  storm: boolean;
  windSpeed: number;      // km/h
  windDir: number;        // degrés (d'où vient le vent, 0 = Nord)
  isDay: boolean;
  elev: number;           // hauteur du soleil en degrés (-90..90)
  az: number;             // azimut du soleil en degrés (0 = Nord, 90 = Est, 180 = Sud)
  label: string;          // résumé court en français
}

/** Position astronomique du soleil (élévation et azimut en degrés) à un instant donné. */
export function solarPosition(latDeg: number, lonDeg: number, date = new Date()): { elev: number; az: number } {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = Math.floor((date.getTime() - start) / 86400000) + 1;
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const gamma = (2 * Math.PI / 365) * (doy - 1 + (utcHours - 12) / 24);
  // Équation du temps (minutes) et déclinaison solaire (radians)
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const trueSolarMin = (utcHours * 60 + eqTime + 4 * lonDeg + 1440) % 1440;
  const ha = ((trueSolarMin / 4) - 180) * rad;
  const lat = latDeg * rad;
  const sinElev = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinElev)));
  const cosAz = (Math.sin(decl) - Math.sin(lat) * Math.sin(elev)) / Math.max(1e-5, Math.cos(lat) * Math.cos(elev));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
  if (ha > 0) az = 360 - az;
  return { elev: elev / rad, az };
}

function wmoDesc(code: number, elev: number): string {
  if (code >= 95) return "Orage";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Neige";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "Pluie";
  if (code === 45 || code === 48) return "Brouillard";
  if (code === 3) return "Couvert";
  if (code === 2) return "Nuageux";
  if (code === 1) return "Éclaircies";
  if (elev < -4) return "Nuit claire";
  if (elev < 4) return "Crépuscule";
  if (elev < 13) return "Heure dorée";
  return "Soleil";
}

function parsePrecip(code: number, rain: number, snow: number): { kind: PrecipKind; intensity: number } {
  if (snow > 0 || (code >= 71 && code <= 77) || code === 85 || code === 86) {
    const heavy = code === 75 || code === 86 || snow >= 1.0;
    const light = code === 71 || code === 77 || (snow > 0 && snow < 0.2);
    return { kind: "snow", intensity: heavy ? 1 : light ? 0.4 : 0.7 };
  }
  if (rain > 0 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) {
    const heavy = code === 65 || code === 82 || code >= 95 || rain >= 4;
    const light = (code >= 51 && code <= 55) || code === 61 || code === 80 || (rain > 0 && rain < 0.8);
    return { kind: "rain", intensity: heavy ? 1 : light ? 0.35 : 0.7 };
  }
  return { kind: "none", intensity: 0 };
}

const CACHE = new Map<string, { at: number; data: LiveWeather }>();
const TTL_MS = 10 * 60 * 1000;

/** Fallback astronomique pur si le réseau ne répond pas. */
export function fallbackWeather(lat: number, lon: number): LiveWeather {
  const { elev, az } = solarPosition(lat, lon);
  return {
    lat, lon, temp: NaN, code: 0, clouds: 0.2, precip: "none", precipIntensity: 0,
    foggy: false, storm: false, windSpeed: 8, windDir: 240, isDay: elev > -1, elev, az,
    label: wmoDesc(0, elev),
  };
}

export async function fetchLiveWeather(lat: number, lon: number): Promise<LiveWeather> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    const sol = solarPosition(lat, lon);
    return { ...hit.data, lat, lon, elev: sol.elev, az: sol.az };
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + `&current=weather_code,cloud_cover,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m,is_day,temperature_2m&timezone=auto`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const cur = j.current ?? {};
    const sol = solarPosition(lat, lon);
    const code = Number(cur.weather_code ?? 0);
    const clouds = Math.max(0, Math.min(1, Number(cur.cloud_cover ?? 0) / 100));
    const rain = Number(cur.rain ?? 0);
    const snow = Number(cur.snowfall ?? 0);
    const windSpeed = Number(cur.wind_speed_10m ?? 0);
    const windDir = Number(cur.wind_direction_10m ?? 0);
    const temp = Number(cur.temperature_2m ?? NaN);
    const { kind, intensity } = parsePrecip(code, rain, snow);
    const foggy = code === 45 || code === 48;
    const storm = code >= 95;
    const desc = wmoDesc(code, sol.elev);
    const tStr = Number.isFinite(temp) ? `${Math.round(temp)}°C · ` : "";
    const wStr = windSpeed >= 20 ? ` · Vent ${Math.round(windSpeed)} km/h` : "";
    const data: LiveWeather = {
      lat, lon, temp, code, clouds, precip: kind, precipIntensity: intensity,
      foggy, storm, windSpeed, windDir, isDay: sol.elev > -1, elev: sol.elev, az: sol.az,
      label: `${tStr}${desc}${wStr}`,
    };
    CACHE.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return fallbackWeather(lat, lon);
  }
}
