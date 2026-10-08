/**
 * r423 (83c0d3c8, plan point 13) — HR'S DAY DETAIL SHOWS WHERE EACH SELF-SERVICE CLOCKING WAS MADE.
 *
 * The plan told the reporter: with the switch OFF "the phone's position is still saved with the clocking,
 * marked 'geofencing not required', so HR can see where it was made". This renders the REAL day page
 * (app/attendance/individual/[date]/page.tsx) against a real database for the three shapes a punch can have:
 *   (a) a geofenced capture  → the matched site, "distance N m of R m allowed";
 *   (b) a switch-OFF capture → "Geofencing not required" + the recorded coordinates as a map link;
 *   (c) a manual (HR-typed) punch → no evidence line at all.
 * The evidence is read under the caller's session through the pack facade; the capture table's RLS is
 * can_see_employment, the same visibility as the page's own rows, so a caller who cannot see an employee
 * gets no evidence for them either (pinned below).
 *
 * File-level mocks: scopedSession() returns the module-level SESSION; getTranslations is the REAL English
 * catalogue through next-intl's createTranslator (so ICU arguments are exercised, not echoed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createClockingLocation, setClockingControl } from '../core/clocking-location';
import { registerDevice } from '../core/attendance-device';
import { captureEmployeeClock, clockCaptureEvidence } from '../core/attendance-clock';
import { checkIn } from '../core/attendance';
import { todayInKualaLumpur } from '../lib/hr-date';

const EN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8'));
let SESSION: SessionContext;
let SCOPE: string[] = [];
vi.mock('../lib/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/scope')>()),
  scopedSession: async () => ({ s: SESSION, scopeIds: SCOPE, allowedCount: SCOPE.length }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => createTranslator({ locale: 'en', messages: EN, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

import DayPage from '../app/attendance/individual/[date]/page';

let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  SESSION = adminCtx(b);
  SCOPE = [b.companyId];
});
afterEach(() => vi.useRealTimers());

const DATE = () => todayInKualaLumpur();
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');
async function render(employmentId: string): Promise<string> {
  const tree = await DayPage({ params: Promise.resolve({ date: DATE() }), searchParams: Promise.resolve({ emp: employmentId }) });
  return visible(
    renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'Asia/Kuala_Lumpur', messages: EN, children: tree as never })),
  );
}

/** An employee who clocks in on the Clock screen (photo + registered device), with the switch as given. */
async function clocker(name: string, geofenced: boolean) {
  const admin = adminCtx(b);
  const h = await hireEmployee(admin, {
    person: { fullName: name, primaryEmail: `${randomUUID()}@test.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const userId = await createAppUser(b.tenantId, h.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: h.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId), grants: [{ role: 'employee', companyId: null }] };
  const site = await createClockingLocation(admin, { name: `Klang Office ${name}`, lat: 3.0448, lng: 101.4455, radiusM: 100, companyIds: [b.companyId] });
  if (geofenced) await setClockingControl(admin, { employmentId: h.employmentId, enabled: true, clockingLocationIds: [site.id] });
  const device = await registerDevice(ctx, { employmentId: h.employmentId, label: 'Synthetic browser' });
  const photo = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#246' } }).jpeg().toBuffer();
  return { h, ctx, site, device, photo };
}
const clockAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

describe('r423 — the day detail’s punch trail carries each clocking’s location evidence', () => {
  it('(a) a geofenced capture shows the matched site and "distance N m of R m allowed"', async () => {
    const x = await clocker('Geo Ina', true);
    clockAt(`${DATE()}T09:00:10+08:00`);
    // ~0.0003° north ≈ 33 m from the site — inside its 100 m.
    await captureEmployeeClock(x.ctx, { action: 'in', requestId: randomUUID(), deviceToken: x.device.deviceToken, lat: 3.0451, lng: 101.4455, accuracy: 8, photo: x.photo, mime: 'image/jpeg' });
    vi.useRealTimers();
    const html = await render(x.h.employmentId);
    expect(html).toContain('data-clock-evidence="geofenced"');
    expect(html).toMatch(/Klang Office Geo Ina · distance 3\d m of 100 m allowed/);
    expect(html).not.toContain('data-clock-evidence="not-enforced"');
  });

  it('(b) a switch-OFF capture shows "Geofencing not required" and the recorded coordinates as an OpenStreetMap link', async () => {
    const x = await clocker('Free Ali', false);
    clockAt(`${DATE()}T09:00:10+08:00`);
    await captureEmployeeClock(x.ctx, { action: 'in', requestId: randomUUID(), deviceToken: x.device.deviceToken, lat: 5.416404, lng: 100.332712, accuracy: 12.4, photo: x.photo, mime: 'image/jpeg' });
    vi.useRealTimers();
    const html = await render(x.h.employmentId);
    expect(html).toContain('data-clock-evidence="not-enforced"');
    expect(html).toContain('Geofencing not required');
    expect(html).toContain('href="https://www.openstreetmap.org/?mlat=5.41640&amp;mlon=100.33271#map=18/5.41640/100.33271"');
    expect(html).toContain('target="_blank"');
    expect(html).toMatch(/rel="noopener[^"]*"/);
    expect(html).toContain('5.41640, 100.33271 ± 12 m');
    expect(html).not.toContain('data-clock-evidence="geofenced"');
  });

  it('(c) a manual (HR-typed) punch shows no evidence line', async () => {
    const x = await clocker('Manual Mei', true);
    await checkIn(adminCtx(b), { employmentId: x.h.employmentId, date: DATE(), time: '09:00', manual: true });
    const html = await render(x.h.employmentId);
    expect(html, 'the punch trail rendered (non-vacuity)').toContain(EN.attendance.punchTrail);
    expect(html).not.toContain('data-clock-evidence');
    expect(html).not.toContain('openstreetmap.org/?mlat');
  });

  it('RLS: a caller who cannot see the employee gets no evidence for their capture', async () => {
    const x = await clocker('Hidden Hui', false);
    clockAt(`${DATE()}T09:00:10+08:00`);
    const receipt = await captureEmployeeClock(x.ctx, { action: 'in', requestId: randomUUID(), deviceToken: x.device.deviceToken, lat: 3.1, lng: 101.6, accuracy: 5, photo: x.photo, mime: 'image/jpeg' });
    vi.useRealTimers();
    expect((await clockCaptureEvidence(adminCtx(b), [receipt.id])).get(receipt.id)?.geofenced).toBe(false);
    const stranger = await clocker('Stranger Sam', false);
    expect((await clockCaptureEvidence(stranger.ctx, [receipt.id])).size, 'another employee sees nothing').toBe(0);
    const foreign = await seedBase();
    expect((await clockCaptureEvidence(adminCtx(foreign), [receipt.id])).size, 'another tenant sees nothing').toBe(0);
  });

  it('the three strings exist in all six locales with their ICU arguments', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const a = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8')).attendance;
      for (const arg of ['{site}', '{distance}', '{radius}']) expect(a.clockEvidenceGeofenced, `${loc} ${arg}`).toContain(arg);
      expect(a.clockEvidenceNotRequired, loc).toBeTruthy();
      for (const arg of ['{lat}', '{lng}', '{accuracy}']) expect(a.clockEvidenceCoordinates, `${loc} ${arg}`).toContain(arg);
      if (loc !== 'en') expect(a.clockEvidenceNotRequired, `${loc} is translated`).not.toBe(EN.attendance.clockEvidenceNotRequired);
    }
  });
});
