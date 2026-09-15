/**
 * fa2db8cb rev 2 (r279) — THE PROVIDER SEAM and the SHAPE of the two client islands that read it.
 *
 * The reporter approved "an address search and a map on the Clocking Location screen" three times, and
 * it was blocked twice asking them for a Google Maps key that never arrived. rev 2 states one course
 * that needs nothing from them: build it on free, keyless open map data now, behind a seam, so that a
 * paid supplier later replaces the same screen by configuration rather than by a rebuild.
 *
 * TWO HALVES, in the house style. The SEAM half is a pure unit test of
 * app/admin/locations/clocking/map-provider.ts against fabricated environments — above all the EMPTY
 * one, which is what production is: `.env.production` on the box holds fifteen variables and not one of
 * them is a map key, so "no key present" is the configuration that has to work and never throw. The
 * SOURCE-SHAPE half pins the promises that no behaviour test would notice a later round undoing: search
 * on a button press only (the free geocoder's usage policy forbids search-as-you-type), attribution
 * always rendered, the Satellite control present and disabled, leaflet loaded from a pinned npm
 * dependency rather than a CDN script tag, and — the one that cost r272 a 500 in production — no
 * function crossing the server→client boundary.
 *
 * The behaviour of the islands themselves (the circle following the radius box, the search filling in
 * the three fields, the Satellite swap when a satellite URL IS configured) is in
 * test/clocking-map.dom.test.tsx, which mounts them in jsdom against a fake leaflet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAP_ENV,
  OSM_PROVIDER,
  geocodeRequestUrl,
  parseGeocodeResults,
  resolveMapProvider,
} from '../app/admin/locations/clocking/map-provider';
import { CLOCKING_FIELDS } from '../app/admin/locations/clocking/form-fields';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
/** CODE only — these files' headers deliberately QUOTE the directives and specifiers they explain. */
const withoutComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const SEARCH = 'app/admin/locations/clocking/address-search.tsx';
const MAP = 'app/admin/locations/clocking/clocking-map.tsx';
const BRIDGE = 'app/admin/locations/clocking/form-bridge.ts';
const PROVIDER = 'app/admin/locations/clocking/map-provider.ts';

// ────────────────────────────────── THE SEAM ──────────────────────────────────

describe('fa2db8cb rev 2 — the map provider seam works with NO key, which is the only configuration production has', () => {
  it('an empty environment gives the free OpenStreetMap provider, credited, and NO satellite', () => {
    const p = resolveMapProvider({});
    expect(p).toEqual(OSM_PROVIDER);
    expect(p.id).toBe('osm');
    expect(p.satelliteTileUrl, 'there is no keyless satellite, so the control has to render disabled').toBeNull();
    expect(p.attribution, 'the OSMF tile policy requires the credit').toContain('OpenStreetMap');
    expect(p.geocodeAttribution).toContain('OpenStreetMap');
    expect(p.tileUrl).toContain('{z}');
    expect(p.geocodeUrl, 'the search endpoint carries the query placeholder the caller substitutes').toContain('{q}');
  });

  it('resolving NEVER throws and never half-configures, whatever the environment holds', () => {
    for (const env of [
      {},
      { [MAP_ENV.key]: '' },
      { [MAP_ENV.key]: 'a-key-and-nothing-else' },
      { [MAP_ENV.tileUrl]: 'https://tiles.example/{z}/{x}/{y}.png' }, // tiles without their attribution
      { [MAP_ENV.attribution]: '© Somebody' }, // attribution without tiles
      { [MAP_ENV.tileUrl]: '   ', [MAP_ENV.attribution]: '  ' }, // blank is absent
      { [MAP_ENV.tileUrl]: 'https://t.example/{z}/{x}/{y}?key={key}', [MAP_ENV.attribution]: '© X' }, // wants a key it has not got
    ]) {
      const p = resolveMapProvider(env);
      expect(p, `${JSON.stringify(env)} falls back in one piece`).toEqual(OSM_PROVIDER);
      expect(p.tileUrl).not.toContain('{key}');
    }
  });

  it('a supplier configured with its own templates is selected, key substituted, and satellite follows its URL', () => {
    const p = resolveMapProvider({
      [MAP_ENV.key]: 'K3Y',
      [MAP_ENV.tileUrl]: 'https://tiles.example/v1/{z}/{x}/{y}.png?key={key}',
      [MAP_ENV.attribution]: '© Example Maps',
      [MAP_ENV.satelliteTileUrl]: 'https://tiles.example/sat/{z}/{x}/{y}.jpg?key={key}',
      [MAP_ENV.geocodeUrl]: 'https://geo.example/search?q={q}&key={key}',
      [MAP_ENV.tileMaxZoom]: '21',
      [MAP_ENV.tileSubdomains]: 'a, b ,c',
    });
    expect(p.id).toBe('configured');
    expect(p.tileUrl).toBe('https://tiles.example/v1/{z}/{x}/{y}.png?key=K3Y');
    expect(p.satelliteTileUrl, 'satellite exists now, so the control enables').toBe('https://tiles.example/sat/{z}/{x}/{y}.jpg?key=K3Y');
    expect(p.satelliteAttribution, 'falls back to the tile credit rather than going uncredited').toBe('© Example Maps');
    expect(p.geocodeUrl).toBe('https://geo.example/search?q={q}&key=K3Y');
    expect(p.maxZoom).toBe(21);
    expect(p.tileSubdomains).toEqual(['a', 'b', 'c']);
  });

  it('tiles and search are independent purchases: buying tiles keeps the free search rather than breaking it', () => {
    const p = resolveMapProvider({
      [MAP_ENV.tileUrl]: 'https://tiles.example/{z}/{x}/{y}.png',
      [MAP_ENV.attribution]: '© Example Maps',
    });
    expect(p.id).toBe('configured');
    expect(p.satelliteTileUrl, 'no satellite URL configured is still no satellite').toBeNull();
    expect(p.geocodeUrl).toBe(OSM_PROVIDER.geocodeUrl);
    expect(p.geocodeAttribution).toBe(OSM_PROVIDER.geocodeAttribution);
    // A geocoder template that cannot take a query is not a geocoder.
    const noQ = resolveMapProvider({
      [MAP_ENV.tileUrl]: 'https://tiles.example/{z}/{x}/{y}.png',
      [MAP_ENV.attribution]: '© Example Maps',
      [MAP_ENV.geocodeUrl]: 'https://geo.example/search',
    });
    expect(noQ.geocodeUrl).toBe(OSM_PROVIDER.geocodeUrl);
    // A nonsense max zoom is ignored, not obeyed.
    for (const bad of ['0', '99', 'wide', '', '12.5']) {
      const z = resolveMapProvider({
        [MAP_ENV.tileUrl]: 'https://tiles.example/{z}/{x}/{y}.png',
        [MAP_ENV.attribution]: '© Example Maps',
        [MAP_ENV.tileMaxZoom]: bad,
      });
      expect(z.maxZoom, `${JSON.stringify(bad)} is not a zoom level`).toBe(OSM_PROVIDER.maxZoom);
    }
  });

  it('the query is URL-encoded exactly once, at the only place that builds the request', () => {
    expect(geocodeRequestUrl(OSM_PROVIDER, 'Menara KL, Jalan Punchak')).toBe(
      OSM_PROVIDER.geocodeUrl.replace('{q}', 'Menara%20KL%2C%20Jalan%20Punchak'),
    );
    expect(geocodeRequestUrl(OSM_PROVIDER, 'a&b=c#d')).not.toContain('&b=c');
    expect(geocodeRequestUrl({ ...OSM_PROVIDER, geocodeUrl: 'https://x/{q}/{q}' }, 'q q')).toBe('https://x/q%20q/q%20q');
  });

  it('a third party’s answer is read defensively: junk rows are dropped, never trusted, and nothing throws', () => {
    expect(parseGeocodeResults([{ display_name: 'Menara KL', lat: '3.1528', lon: '101.7038' }])).toEqual([
      { label: 'Menara KL', lat: '3.1528', lng: '101.7038' },
    ]);
    // Numbers are as acceptable as strings; everything else is dropped.
    expect(parseGeocodeResults([{ display_name: 'N', lat: 3.1, lon: 101.7 }])).toEqual([{ label: 'N', lat: '3.1', lng: '101.7' }]);
    for (const junk of [null, undefined, 'not an array', 42, {}, { results: [] }]) {
      expect(parseGeocodeResults(junk), `${JSON.stringify(junk)} is not results`).toEqual([]);
    }
    expect(
      parseGeocodeResults([
        null,
        'nope',
        { display_name: '', lat: '1', lon: '2' },
        { display_name: 'no point' },
        { display_name: 'off the globe', lat: '95', lon: '2' },
        { display_name: 'off the globe', lat: '5', lon: '200' },
        { display_name: 'not a number', lat: 'north-ish', lon: '2' },
        { display_name: 'good', lat: '1.5', lon: '2.5' },
      ]),
    ).toEqual([{ label: 'good', lat: '1.5', lng: '2.5' }]);
    expect(parseGeocodeResults(Array.from({ length: 50 }, () => ({ display_name: 'x', lat: '1', lon: '2' }))).length).toBe(5);
  });
});

// ────────────────────────────────── SOURCE SHAPE ──────────────────────────────────

describe('fa2db8cb rev 2 — the two client islands keep the promises no behaviour test would miss', () => {
  const search = withoutComments(read(SEARCH));
  const map = withoutComments(read(MAP));
  const bridge = withoutComments(read(BRIDGE));
  const provider = withoutComments(read(PROVIDER));

  it('both islands declare themselves client components; the seam and the bridge declare nothing', () => {
    for (const [name, src] of [
      ['address-search.tsx', search],
      ['clocking-map.tsx', map],
    ] as const) {
      expect(src.trimStart().startsWith("'use client';"), `${name} opens with the directive`).toBe(true);
    }
    // The seam is imported by a SERVER component to read the environment and by the islands for its type
    // only. A directive on it would drag process.env into the browser bundle or the module out of the
    // server one; it must stay a plain module.
    expect(provider).not.toContain("'use client'");
    expect(provider).not.toContain("'use server'");
    expect(provider, 'the seam reads the environment it is GIVEN — never process.env of its own').not.toContain('process.env');
    expect(bridge).not.toContain("'use client'");
  });

  it('leaflet is a pinned npm dependency loaded on mount — never a CDN script tag, never at module scope', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies.leaflet, 'pinned exactly: a self-hosted product and a test environment that must not reach the network').toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(pkg.devDependencies['@types/leaflet']).toMatch(/^\d+\.\d+\.\d+$/);
    // ⚠️ `leaflet` touches window and navigator while it initialises, so a module-scope value import
    // would crash Next's server render of this page and vitest's renderToStaticMarkup with it.
    expect(map, 'no module-scope value import of leaflet').not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'leaflet'/m);
    expect(map, 'loaded inside the effect, which only ever runs in a browser').toContain("await import('leaflet')");
    expect(map, 'the stylesheet is a static import — not executable, and handled by both Next and vitest').toContain(
      "import 'leaflet/dist/leaflet.css'",
    );
    for (const [name, src] of [
      ['address-search.tsx', search],
      ['clocking-map.tsx', map],
    ] as const) {
      expect(src, `${name} loads nothing from a CDN`).not.toMatch(/<script|https?:\/\/(unpkg|cdn|cdnjs)/i);
    }
  });

  it('the ADDRESS SEARCH runs on submit only — the free geocoder’s policy forbids search-as-you-type', () => {
    expect(search, 'typing updates a local string and nothing else').toContain('onChange={(e) => setQuery(e.target.value)}');
    // The only two things that may start a request: the button and Enter. Counted, so a third cannot be
    // added quietly — an effect that searched on mount would show up here too.
    expect(search.match(/void runSearch\(\)/g)?.length, 'exactly two call sites — the button and the Enter key').toBe(2);
    expect(search).toContain('onClick={() => void runSearch()}');
    expect(search).toMatch(/if \(e\.key !== 'Enter'\) return;\s*e\.preventDefault\(\);\s*void runSearch\(\);/);
    expect(search, 'no debounce, no timer: a settle delay here would BE search-as-you-type').not.toContain('setTimeout');
    expect(search, 'and nothing runs on mount').not.toContain('useEffect');
    expect(search, 'results are not cached anywhere').toContain("cache: 'no-store'");
    // ⚠️ Two ways this island could have posted a half-filled form to createClockingLocation.
    expect(search, 'Search is not a submit button').toContain('<button type="button" onClick={() => void runSearch()}');
    expect(search.match(/<button/g)?.length, 'every button in the island is type="button"').toBe(
      search.match(/<button\s+type="button"/g)?.length,
    );
    expect(search, 'the search box is UNNAMED, so it is not submitted and CLOCKING_FIELDS stays the set of eight').not.toMatch(
      /<input[^>]*\sname=/,
    );
  });

  it('the search writes the three fields it promises and nothing else; the map writes none at all', () => {
    const written = [...search.matchAll(/setFieldValue\(form, '([a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(written, 'address, latitude and longitude — the plan’s exact promise').toEqual(['address', 'lat', 'lng']);
    for (const f of written) expect(CLOCKING_FIELDS as readonly string[], `${f} is a real posted field`).toContain(f);
    expect(map, 'the map is a picture of the boxes, never an author of them').not.toContain('setFieldValue');
    expect(bridge, 'one place writes a field, and it tells the page by dispatching input').toMatch(
      /el\.value = value;[\s\S]*dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/,
    );
  });

  it('the MAP draws the radius live, credits the supplier in our own markup, and renders Satellite DISABLED with no key', () => {
    expect(map, 'the circle is metres, straight off the radius box').toContain('circle.setLatLng(here).setRadius(radius)');
    expect(map, 'the radius box is listened to').toContain("target.name === 'radiusM'");
    expect(map, 'so are the coordinates').toContain("target.name === 'lat' || target.name === 'lng'");
    expect(map, 'one listener, on the form — the boxes belong to a server component this island never sees').toContain(
      "form?.addEventListener('input', onInput)",
    );
    // Attribution is OURS, in the server-rendered markup, so it survives Leaflet never loading at all.
    expect(map).toContain('attributionControl: false');
    expect(map).toContain('{provider.attribution}');
    // ⚠️ The disabled state IS the promise the plan made: no supplier of satellite imagery is keyless,
    // and the plan said out loud that the button would not be quietly dropped.
    expect(map).toContain('const satelliteAvailable = provider.satelliteTileUrl !== null;');
    expect(map).toContain('disabled={!satelliteAvailable}');
    expect(map).toContain("{t('mapSatelliteUnavailable')}");
    expect(map, 'the fallback centre is a constant, never a value invented into the form').not.toContain("setFieldValue(form, 'lat'");
  });

  it('every string these islands show is translated, and every key exists in all six locales', () => {
    const locales = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
    const keys = [...`${search}\n${map}`.matchAll(/\bt\('([a-zA-Z0-9.]+)'\)/g)].map((m) => m[1]);
    expect(keys.length, 'the islands read their own text — no label props, so nothing callable crosses').toBeGreaterThan(10);
    for (const loc of locales) {
      const messages = JSON.parse(read(`messages/${loc}.json`)) as { admin: { locations: Record<string, string> } };
      const missing = [...new Set(keys)].filter((k) => typeof messages.admin.locations[k] !== 'string' || messages.admin.locations[k] === '');
      expect(missing, `[${loc}] missing ${missing.join(', ')}`).toEqual([]);
    }
    // A raw English sentence in the markup is the thing this catches; the provider's attribution and the
    // inline marker SVG are the two deliberate exceptions and are named here rather than left implicit.
    expect(search).toContain("useTranslations('admin.locations')");
    expect(map).toContain("useTranslations('admin.locations')");
  });
});
