import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGuides, loadOperatorGuides } from '../lib/guide-catalog';
import { guideTourId, tourSteps, TOURS, toursForRoles } from '../lib/onboarding-tour';

describe('knowledge-base walkthrough coverage', () => {
  it('offers a runnable walkthrough for every bundled tenant guide and its audience', () => {
    for (const { meta } of loadGuides()) {
      const id = guideTourId(meta.slug);
      expect(id, meta.slug).not.toBeNull();
      const roles = meta.audience === 'hr_admin' ? ['hr_admin'] : meta.audience === 'manager' ? ['manager'] : ['employee'];
      expect(tourSteps(id!, roles).length, meta.slug).toBeGreaterThan(1);
    }
    expect(guideTourId('company-policy')).toBeNull();
    expect(guideTourId(null)).toBeNull();
  });

  it('offers operator walkthroughs only to operators and keeps their steps inside the console', () => {
    const guides = loadOperatorGuides();
    expect(guides.length).toBeGreaterThan(0);
    for (const guide of guides) {
      const id = guideTourId(guide.slug)!;
      expect(id, guide.slug).toBeTruthy();
      const steps = tourSteps(id, ['operator']);
      expect(steps.length).toBeGreaterThan(1);
      expect(steps.every(step => step.route === '/operator')).toBe(true);
      for (const roles of [['employee'], ['manager'], ['hr_admin'], ['super_admin'], []]) {
        expect(tourSteps(id, roles)).toEqual([]);
        expect(toursForRoles(roles)[id]).toBeUndefined();
      }
    }
  });

  it('anchors the new walkthroughs in implemented routes and actual UI sections', () => {
    let checked = 0;
    for (const tour of Object.values(TOURS)) for (const step of tour.steps) {
      if (!('text' in step)) continue;
      expect(step.text.lang).toBe('en');
      expect(step.text.title.trim().length).toBeGreaterThan(5);
      expect(step.text.body.trim().length).toBeGreaterThan(40);
      expect(step.route).toMatch(/^\/[a-z/-]+$/);
      const page = join(process.cwd(), 'app', step.route!, 'page.tsx');
      expect(existsSync(page), step.route).toBe(true);
      if (!step.target) continue;
      const anchor = step.target.match(/^\[data-tour="([a-z-]+)"\]$/)?.[1];
      expect(anchor, step.target).toBeTruthy();
      let source = readFileSync(page, 'utf8');
      if (step.route === '/mobile-preview') source += readFileSync('components/mobile-preview/mobile-builder.tsx', 'utf8');
      if (anchor!.startsWith('operator-guide-')) {
        expect(source).toContain('data-tour={`operator-guide-${guide.slug}`}');
        expect(loadOperatorGuides().some(g => 'operator-guide-' + g.slug === anchor)).toBe(true);
      } else {
        expect(source, `${tour.id}: ${step.route} ${anchor}`).toContain(`data-tour="${anchor}"`);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(25);
  });

  it('retains translation keys in the existing tours', () => {
    const messages = JSON.parse(readFileSync('messages/en.json', 'utf8'));
    let checked = 0;
    for (const tour of Object.values(TOURS)) for (const step of tour.steps) {
      if ('text' in step) continue;
      for (const key of [step.titleKey, step.bodyKey]) {
        const value = key.split('.').reduce((node, part) => node?.[part], messages.onboarding);
        expect(typeof value, key).toBe('string');
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });
});
