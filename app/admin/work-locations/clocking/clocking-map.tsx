'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type * as Leaflet from 'leaflet';
import type { MapProvider } from './map-provider';
import { MAP_FOCUS_EVENT, ownerForm, readPoint, readRadiusM } from './form-bridge';

/**
 * fa2db8cb rev 2 (r279) — THE MAP under GPS and clocking settings: one marker on the point and the
 * clocking radius drawn around it as a circle, so the operator can see that 100 m genuinely covers the
 * office and not the car park next door BEFORE saving. Getting that wrong means somebody cannot clock
 * in, which is the whole reason the reporter asked for this.
 *
 * ⚠️ THIS IS THE ONE CLIENT ISLAND ON A DELIBERATELY SERVER-RENDERED PAGE. ../clocking-form.tsx keeps
 * no 'use client' of its own and passes this component ONLY the resolved provider descriptor — a plain
 * object of strings, numbers and nulls. No function crosses the boundary: r272 shipped a 500 doing
 * exactly that, green on tsc, eslint and thirteen source guards, and only a dev-server render caught
 * it. The localised strings come from `useTranslations` HERE (the ConfirmSubmit idiom) rather than as
 * props, which removes the last reason to hand anything callable across.
 *
 * LEAFLET IS LOADED ON MOUNT, NEVER IMPORTED AT MODULE SCOPE. `leaflet` reads `window` and `navigator`
 * while it initialises, so a static import would crash Next's server render of this page and vitest's
 * `renderToStaticMarkup` with it. The dynamic `import()` lives inside the effect, which is exactly the
 * place that only ever runs in a browser. The stylesheet above is a different animal — a CSS import is
 * not executable and both Next and vitest handle it statically, verified in both.
 *
 * NO MARKER IMAGE. Leaflet's default marker points at `images/marker-icon.png` relative to its own CSS,
 * which is the bundler footgun every Leaflet integration trips over. A `divIcon` with inline HTML has no
 * asset to resolve, so there is nothing to copy into `public/` and nothing to break on deploy.
 *
 * THE FORM OWNS THE VALUES, THIS OWNS THE PICTURE. Latitude, longitude and radius are read out of the
 * enclosing form and never mirrored into React state (./form-bridge.ts says why), so they stay typeable
 * by hand — which is the fallback the free tile supplier's absent availability guarantee requires. The
 * circle follows the radius box live; a picked search result reframes the view; nothing here writes a
 * single form field, so this island cannot change what gets saved.
 *
 * ATTRIBUTION IS A CAPTION, NOT LEAFLET'S CONTROL. `attributionControl: false` and a line of ours
 * directly beneath the map: it is then in the server-rendered HTML, visible before Leaflet loads and
 * still visible if Leaflet never does — which is when an attribution drawn by Leaflet would be missing.
 */
const FALLBACK_CENTRE = { lat: 3.139, lng: 101.6869 } as const; // Kuala Lumpur — the same point the empty form suggests.
const FALLBACK_ZOOM = 10;
const POINT_ZOOM = 16;
/** Long enough that typing "3.1390" does not fly the map across four continents on the way. */
const SETTLE_MS = 250;

type Status = 'loading' | 'ready' | 'unavailable';

export function ClockingMap({ provider }: { provider: MapProvider }) {
  const t = useTranslations('admin.locations');
  const hostRef = useRef<HTMLDivElement>(null);
  /** The element Leaflet owns outright. React renders NO children into it, ever — the two would fight. */
  const canvasRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const tileRef = useRef<Leaflet.TileLayer | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [hasPoint, setHasPoint] = useState(false);
  const [satellite, setSatellite] = useState(false);

  const satelliteAvailable = provider.satelliteTileUrl !== null;
  // Primitives, not the object: `provider` is a fresh object on every server render, and depending on it
  // would tear the map down and rebuild it for no reason. These change only when the supplier does.
  const { tileUrl, maxZoom } = provider;
  const subdomains = provider.tileSubdomains.join(',');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const form = ownerForm(hostRef.current);
    let cancelled = false;
    let detach: (() => void) | null = null;

    void (async () => {
      try {
        // `leaflet` ships a UMD/CommonJS bundle (its package.json `main` is dist/leaflet-src.js and it
        // declares neither `module` nor `exports`), so a bundler hands it back with the library under
        // `default` AND its members spread as named exports. Take `default` where it exists and the
        // namespace otherwise, rather than betting on one interop.
        const imported = await import('leaflet');
        const L = imported.default ?? imported;
        if (cancelled || canvasRef.current !== canvas) return;

        const opening = readPoint(form);
        const map = L.map(canvas, {
          center: [opening?.lat ?? FALLBACK_CENTRE.lat, opening?.lng ?? FALLBACK_CENTRE.lng],
          zoom: opening ? POINT_ZOOM : FALLBACK_ZOOM,
          attributionControl: false,
          // A form page must not swallow the page scroll under the cursor; the +/- control and
          // double-click still zoom, and touch pinch is untouched.
          scrollWheelZoom: false,
        });
        mapRef.current = map;

        const subs = subdomains.split(',').filter((s) => s !== '');
        const tiles = L.tileLayer(tileUrl, { maxZoom, subdomains: subs.length > 0 ? subs : 'abc' });
        tiles.addTo(map);
        tileRef.current = tiles;

        const marker = L.marker([FALLBACK_CENTRE.lat, FALLBACK_CENTRE.lng], {
          keyboard: false,
          interactive: false,
          icon: L.divIcon({
            className: '',
            html: '<span style="display:block;width:14px;height:14px;border-radius:9999px;background:#2563eb;border:2px solid #ffffff;box-shadow:0 0 0 1px rgba(0,0,0,0.3)"></span>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
        });
        const circle = L.circle([FALLBACK_CENTRE.lat, FALLBACK_CENTRE.lng], {
          radius: 0,
          interactive: false,
          color: '#2563eb',
          weight: 2,
          fillColor: '#2563eb',
          fillOpacity: 0.12,
        });

        /** Has a point ever been shown? The first one earns a proper zoom rather than the country view. */
        let placed = false;
        const apply = (mode: 'fit' | 'pan' | 'still') => {
          const point = readPoint(form);
          const radius = readRadiusM(form);
          setHasPoint(point !== null);
          if (!point) {
            if (map.hasLayer(marker)) marker.remove();
            if (map.hasLayer(circle)) circle.remove();
            return;
          }
          const here = L.latLng(point.lat, point.lng);
          marker.setLatLng(here);
          circle.setLatLng(here).setRadius(radius);
          if (!map.hasLayer(marker)) marker.addTo(map);
          if (radius > 0 && !map.hasLayer(circle)) circle.addTo(map);
          if (radius <= 0 && map.hasLayer(circle)) circle.remove();

          const how = placed ? mode : 'fit';
          placed = true;
          if (how === 'still') {
            /**
             * A radius change does NOT chase the view — typing 1, 15, 150 must not fly the map about.
             * The ONE exception is the circle growing out of the frame: at the service's own 5000 m
             * advisory ceiling the circle is many times the height of this card, so the operator would
             * be looking at a flat blue wash with no edge to judge. A circle you cannot see is exactly
             * what this map exists to prevent, so when it no longer fits, and only then, reframe.
             */
            if (radius > 0 && map.hasLayer(circle) && !map.getBounds().contains(circle.getBounds())) {
              map.fitBounds(circle.getBounds(), { maxZoom: 18, padding: [24, 24] });
            }
            return;
          }
          if (how === 'fit' && radius > 0) map.fitBounds(circle.getBounds(), { maxZoom: 18, padding: [24, 24] });
          else if (how === 'fit') map.setView(here, POINT_ZOOM);
          else map.setView(here, map.getZoom(), { animate: false });
        };

        // ⚠️ THE ONLY LISTENER IS ON THE FORM, not on the individual inputs: the boxes are rendered by a
        // server component this island never sees, and `input` bubbles. A settle delay keeps the view
        // from lurching once per keystroke while a coordinate is being typed — it is a redraw delay, not
        // a search delay, and starts no network request of any kind.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const schedule = (mode: 'fit' | 'pan' | 'still') => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => apply(mode), SETTLE_MS);
        };
        const onInput = (e: Event) => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
          if (target.name === 'radiusM') schedule('still');
          else if (target.name === 'lat' || target.name === 'lng') schedule('pan');
        };
        const onFocusRequest = () => {
          if (timer) clearTimeout(timer);
          apply('fit');
        };
        form?.addEventListener('input', onInput);
        form?.addEventListener(MAP_FOCUS_EVENT, onFocusRequest);

        // The card can still be settling when the map initialises; Leaflet sizes itself once, from the
        // container, and a stale size is the classic half-drawn map.
        const resize = setTimeout(() => map.invalidateSize(), 0);

        detach = () => {
          if (timer) clearTimeout(timer);
          clearTimeout(resize);
          form?.removeEventListener('input', onInput);
          form?.removeEventListener(MAP_FOCUS_EVENT, onFocusRequest);
        };

        apply('fit');
        setStatus('ready');
      } catch {
        // The free supplier guarantees nothing and a chunk can fail to load. Say so, and leave the boxes
        // above — which are what actually gets saved — completely untouched.
        if (!cancelled) setStatus('unavailable');
      }
    })();

    return () => {
      cancelled = true;
      detach?.();
      mapRef.current?.remove();
      mapRef.current = null;
      tileRef.current = null;
    };
  }, [tileUrl, maxZoom, subdomains]);

  // The Satellite swap is a tile-source change and nothing else — the marker, the circle and the view all
  // stay exactly where they are. It can only ever run when the seam reported a satellite URL.
  useEffect(() => {
    const tiles = tileRef.current;
    if (status !== 'ready' || !tiles) return;
    tiles.setUrl(satellite && provider.satelliteTileUrl !== null ? provider.satelliteTileUrl : tileUrl);
  }, [satellite, provider.satelliteTileUrl, tileUrl, status]);

  // Leaflet writes its own English titles onto the zoom buttons. Six locales are the house rule, and this
  // is the only text Leaflet renders that is not ours.
  useEffect(() => {
    if (status !== 'ready') return;
    const root = canvasRef.current;
    const label = (selector: string, text: string) => {
      const el = root?.querySelector(selector);
      if (el instanceof HTMLElement) {
        el.title = text;
        el.setAttribute('aria-label', text);
      }
    };
    label('.leaflet-control-zoom-in', t('mapZoomIn'));
    label('.leaflet-control-zoom-out', t('mapZoomOut'));
  }, [status, t]);

  const viewButton = 'rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45';
  return (
    <div ref={hostRef} className="px-4 pb-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('mapHeading')}</span>
        <div className="inline-flex items-center gap-0.5 rounded-md border border-input p-0.5">
          <button
            type="button"
            aria-pressed={!satellite}
            onClick={() => setSatellite(false)}
            className={`${viewButton} ${satellite ? 'text-muted-foreground hover:bg-accent' : 'bg-primary text-primary-foreground'}`}
          >
            {t('mapStandardView')}
          </button>
          {/* ⚠️ RENDERED, AND VISIBLY OFF. Every supplier of satellite imagery — Google, Mapbox, MapTiler,
              Esri — requires an account and billing, so the keyless seam reports no satellite and this
              control says so out loud. Dropping the button and hoping nobody looks for it was the one
              thing the plan promised not to do. */}
          <button
            type="button"
            disabled={!satelliteAvailable}
            aria-pressed={satellite}
            aria-describedby={satelliteAvailable ? undefined : 'clocking-map-satellite-note'}
            title={satelliteAvailable ? undefined : t('mapSatelliteUnavailable')}
            onClick={() => setSatellite(true)}
            className={`${viewButton} ${satellite ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
          >
            {t('mapSatelliteView')}
          </button>
        </div>
      </div>

      <div className="relative h-80 w-full overflow-hidden rounded-md border border-border bg-muted sm:h-96">
        <div ref={canvasRef} className="absolute inset-0" />
        {status !== 'ready' && (
          <p className="absolute inset-0 z-[800] flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
            {status === 'loading' ? t('mapLoading') : t('mapUnavailable')}
          </p>
        )}
        {status === 'ready' && !hasPoint && (
          <p className="pointer-events-none absolute inset-x-0 bottom-0 z-[800] bg-background/90 px-3 py-1.5 text-center text-xs text-muted-foreground">
            {t('mapNoPoint')}
          </p>
        )}
      </div>

      <p className="mt-1.5 text-[11px] text-muted-foreground">{provider.attribution}</p>
      {!satelliteAvailable && (
        <p id="clocking-map-satellite-note" className="mt-1 text-xs text-muted-foreground">
          {t('mapSatelliteUnavailable')}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{t('mapManualHint')}</p>
    </div>
  );
}
