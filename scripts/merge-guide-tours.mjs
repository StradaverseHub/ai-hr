// One-off: turn the guide-tours workflow output into lib/module-tours.json + onboarding.tour.* i18n keys.
//   node scripts/merge-guide-tours.mjs <workflow-output.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node scripts/merge-guide-tours.mjs <workflow-output.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(outPath, 'utf8'));
const tours = (raw?.result?.tours ?? raw?.tours ?? []).filter(Boolean);
if (!tours.length) {
  console.error('No tours in workflow output');
  process.exit(1);
}

const moduleTours = {}; // → lib/module-tours.json
const enText = {}; // → onboarding.tour.<tourId>.<stepId>.{title,body}

for (const tour of tours) {
  const { tourId, steps } = tour;
  const outSteps = [];
  enText[tourId] = {};
  for (const s of steps) {
    const titleKey = `tour.${tourId}.${s.id}.title`;
    const bodyKey = `tour.${tourId}.${s.id}.body`;
    const step = {
      id: s.id,
      target: s.target ?? null,
      route: s.route ?? null,
      titleKey,
      bodyKey,
      placement: s.placement,
    };
    if (Array.isArray(s.roles) && s.roles.length) step.roles = s.roles;
    outSteps.push(step);
    enText[tourId][s.id] = { title: s.title, body: s.body };
  }
  moduleTours[tourId] = { id: tourId, steps: outSteps };
}

// 1) module-tours.json (consumed by lib/onboarding-tour.ts)
writeFileSync(join(process.cwd(), 'lib', 'module-tours.json'), JSON.stringify(moduleTours, null, 2) + '\n');

// 2) onboarding.tour.* into en.json
const enPath = join(process.cwd(), 'messages', 'en.json');
const en = JSON.parse(readFileSync(enPath, 'utf8'));
en.onboarding = en.onboarding ?? {};
en.onboarding.tour = enText;
writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n');

const stepCount = Object.values(moduleTours).reduce((n, t) => n + t.steps.length, 0);
console.error(`Wrote ${Object.keys(moduleTours).length} module tours (${stepCount} steps) → lib/module-tours.json`);
console.error(`Added ${stepCount * 2} onboarding.tour.* keys to en.json`);
console.error(`Tours: ${Object.keys(moduleTours).join(', ')}`);
