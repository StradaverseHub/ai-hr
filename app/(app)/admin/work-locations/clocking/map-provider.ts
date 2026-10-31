/**
 * fa2db8cb rev 2 (r279) — THE MAP PROVIDER SEAM for the Clocking Location screen.
 *
 * ONE module decides three things and nothing else in the screen knows which supplier answered them:
 * where the raster tiles come from, where an address search goes, and WHETHER SATELLITE EXISTS. The
 * map island and the address-search island each receive the resolved descriptor as a plain prop and
 * read it; neither imports this module for anything but its TYPE, so no environment variable and no
 * key can reach the browser bundle through them.
 *
 * THE DEFAULT IS KEYLESS AND MUST STAY THAT WAY. `.env.production` on the box holds fifteen variables
 * and none of them is a map key (checked 2026-09-14, names read, values never). The reporter approved
 * this item three times and was asked for a Google key twice without one arriving, so the screen is
 * built on free, keyless OpenStreetMap data: `resolveMapProvider({})` returns a working provider and
 * throws nothing. Every branch below is a NARROWING of that default, never a precondition for it.
 *
 * WHAT THE PLAN SAID AND WHAT IS TRUE. The approved plan promises that "if you ever do open a Google
 * account and send us a key, the same screen will switch over". The seam delivers that switch, but a
 * bare API key is NOT enough to flip it and it would have been dishonest to pretend otherwise: no two
 * suppliers agree on a tile URL, Google's own 2D raster tiles are issued against a session token
 * obtained by a POST rather than a static template, and inventing one from memory is exactly the kind
 * of unverified third-party behaviour this repo forbids. So the keyed provider is selected by
 * CONFIGURATION — the supplier's own templates, with `{key}` substituted from `MAPS_API_KEY` — which
 * is a single `.env.production` edit and no rebuild, for Google, Mapbox, MapTiler or Esri alike.
 *
 *   MAPS_TILE_URL            a raster template: {z}/{x}/{y}, optionally {s} and {key}
 *   MAPS_ATTRIBUTION         the line that supplier requires on the map — REQUIRED with the tile URL
 *   MAPS_TILE_SUBDOMAINS     comma separated, only meaningful when the template contains {s}
 *   MAPS_TILE_MAX_ZOOM       integer; defaults to 19
 *   MAPS_SATELLITE_TILE_URL  a second raster template; ITS PRESENCE is what enables Satellite
 *   MAPS_SATELLITE_ATTRIBUTION  the satellite layer's own line, where it differs
 *   MAPS_GEOCODE_URL         a search template containing {q}; must answer Nominatim-shaped JSON
 *   MAPS_GEOCODE_ATTRIBUTION the search attribution line
 *   MAPS_API_KEY             substituted for {key} in any of the above
 *
 * A plain module: no 'use server', no 'use client', no database, no I/O — safe to import from either
 * side of the boundary, and unit-testable with a fabricated environment
 * (test/clocking-map-provider.test.ts).
 */

/**
 * What one map supplier gives this screen. EVERY field is a string, a number, a string[] or null on
 * purpose: the whole object is handed to a client component as a prop, and a function here would be
 * the "Functions cannot be passed directly to Client Components" 500 that r272 shipped.
 */
export type MapProvider = {
  /** `osm` is the free default; `configured` is whatever `MAPS_TILE_URL` named. Display uses it never — it is for tests and logs. */
  id: 'osm' | 'configured';
  /** Raster tile template: `{z}` `{x}` `{y}`, optionally `{s}`. Already carries the key, if any. */
  tileUrl: string;
  /** Only used by Leaflet when `tileUrl` contains `{s}`. */
  tileSubdomains: string[];
  maxZoom: number;
  /** Shown under the map at all times — the OSMF tile policy and every paid licence require it. */
  attribution: string;
  /** null ⇒ THERE IS NO SATELLITE and the Satellite control renders DISABLED. Never a silent omission. */
  satelliteTileUrl: string | null;
  satelliteAttribution: string | null;
  /** Address-search endpoint with `{q}` to substitute. Answers Nominatim-shaped JSON (see below). */
  geocodeUrl: string;
  /** Shown under the search box. Nominatim's usage policy requires the data credit. */
  geocodeAttribution: string;
};

/**
 * THE FREE DEFAULT, and the reason each part of it is what it is.
 *
 * - Tiles from the OSM Foundation's own server. Their tile usage policy forbids heavy or commercial
 *   bulk use and offers NO availability guarantee — which is why latitude and longitude stay typeable
 *   by hand on the form and why the map island degrades to a sentence instead of breaking the save.
 * - Search through Nominatim, `limit=5`, on a button press only. Their usage policy forbids
 *   search-as-you-type and requires the data credit; `addressdetails=0` keeps the payload to what the
 *   screen actually reads (a label and a point) and nothing is cached anywhere.
 * - NO SATELLITE. Google, Mapbox, MapTiler and Esri all require an account and billing for imagery;
 *   there is no keyless satellite to stand behind, so this is `null` and the control says so.
 */
export const OSM_PROVIDER: MapProvider = {
  id: 'osm',
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSubdomains: [],
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
  satelliteTileUrl: null,
  satelliteAttribution: null,
  geocodeUrl: 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=5&q={q}',
  geocodeAttribution: 'Address search: Nominatim / © OpenStreetMap contributors',
};

/** The environment variable NAMES, in one place, so the test and the module cannot drift apart. */
export const MAP_ENV = {
  key: 'MAPS_API_KEY',
  tileUrl: 'MAPS_TILE_URL',
  tileSubdomains: 'MAPS_TILE_SUBDOMAINS',
  tileMaxZoom: 'MAPS_TILE_MAX_ZOOM',
  attribution: 'MAPS_ATTRIBUTION',
  satelliteTileUrl: 'MAPS_SATELLITE_TILE_URL',
  satelliteAttribution: 'MAPS_SATELLITE_ATTRIBUTION',
  geocodeUrl: 'MAPS_GEOCODE_URL',
  geocodeAttribution: 'MAPS_GEOCODE_ATTRIBUTION',
} as const;

type Env = Record<string, string | undefined>;

/** A variable that is absent, blank or whitespace is ABSENT — `MAPS_TILE_URL=` must not select a broken provider. */
const read = (env: Env, name: string): string | null => {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
};

/** `{key}` is substituted everywhere it appears. A template that wants a key it has not been given is unusable. */
const substituteKey = (template: string, key: string | null): string | null => {
  if (!template.includes('{key}')) return template;
  return key === null ? null : template.split('{key}').join(key);
};

/**
 * The provider this deployment gets. NEVER THROWS and never returns a half-configured supplier: any
 * configuration that does not hold together falls back to the free default in one piece, because a map
 * drawn from one supplier's tiles under another's attribution is worse than the free map.
 *
 * The configured provider is selected when `MAPS_TILE_URL` AND `MAPS_ATTRIBUTION` are both present —
 * the pair is the unit, since a tile source without the line its licence requires is a breach waiting
 * to happen — and when every `{key}` in the templates can actually be filled.
 *
 * Tiles and search are INDEPENDENT purchases: a deployment that buys tiles but leaves
 * `MAPS_GEOCODE_URL` unset keeps the free Nominatim search, which is a real and reasonable posture.
 */
export function resolveMapProvider(env: Env): MapProvider {
  const tileTemplate = read(env, MAP_ENV.tileUrl);
  const attribution = read(env, MAP_ENV.attribution);
  if (tileTemplate === null || attribution === null) return OSM_PROVIDER;

  const key = read(env, MAP_ENV.key);
  const tileUrl = substituteKey(tileTemplate, key);
  if (tileUrl === null) return OSM_PROVIDER;

  const satelliteTemplate = read(env, MAP_ENV.satelliteTileUrl);
  const satelliteTileUrl = satelliteTemplate === null ? null : substituteKey(satelliteTemplate, key);

  const geocodeTemplate = read(env, MAP_ENV.geocodeUrl);
  const geocodeUrl = geocodeTemplate === null ? null : substituteKey(geocodeTemplate, key);
  const geocodeConfigured = geocodeUrl !== null && geocodeUrl.includes('{q}');

  const maxZoomRaw = Number(read(env, MAP_ENV.tileMaxZoom) ?? '');
  const maxZoom = Number.isInteger(maxZoomRaw) && maxZoomRaw >= 1 && maxZoomRaw <= 24 ? maxZoomRaw : OSM_PROVIDER.maxZoom;

  return {
    id: 'configured',
    tileUrl,
    tileSubdomains: (read(env, MAP_ENV.tileSubdomains) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    maxZoom,
    attribution,
    satelliteTileUrl,
    satelliteAttribution: satelliteTileUrl === null ? null : read(env, MAP_ENV.satelliteAttribution) ?? attribution,
    geocodeUrl: geocodeConfigured ? geocodeUrl : OSM_PROVIDER.geocodeUrl,
    geocodeAttribution: geocodeConfigured
      ? read(env, MAP_ENV.geocodeAttribution) ?? attribution
      : OSM_PROVIDER.geocodeAttribution,
  };
}

/** The search endpoint for one query. The query is URL-encoded here, once, at the only place that builds it. */
export function geocodeRequestUrl(provider: MapProvider, query: string): string {
  return provider.geocodeUrl.split('{q}').join(encodeURIComponent(query));
}

/** One address-search hit, already reduced to the three things the form writes. */
export type GeocodeResult = { label: string; lat: string; lng: string };

/**
 * Nominatim answers a bare ARRAY of `{ display_name, lat, lon }`. That shape is the seam's contract for
 * a configured `MAPS_GEOCODE_URL` too: it is the one thing a different supplier must be adapted to, and
 * this function is where that adapter goes. Every field is read defensively — the response is a third
 * party's, so a malformed row is dropped rather than trusted, and nothing here can throw on junk.
 */
export function parseGeocodeResults(payload: unknown, limit = 5): GeocodeResult[] {
  if (!Array.isArray(payload)) return [];
  const out: GeocodeResult[] = [];
  for (const row of payload) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const label = typeof r.display_name === 'string' ? r.display_name.trim() : '';
    const lat = typeof r.lat === 'string' || typeof r.lat === 'number' ? String(r.lat) : '';
    const lng = typeof r.lon === 'string' || typeof r.lon === 'number' ? String(r.lon) : '';
    const latN = Number(lat);
    const lngN = Number(lng);
    if (label === '' || lat === '' || lng === '') continue;
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) continue;
    if (Math.abs(latN) > 90 || Math.abs(lngN) > 180) continue;
    out.push({ label: label.slice(0, 1000), lat, lng });
    if (out.length >= limit) break;
  }
  return out;
}
