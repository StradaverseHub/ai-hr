import {expect, it} from 'vitest';
import {actionCensusIdentity, mergeActionCensus} from '../scripts/performance/browser-action-census.mjs';

const registry = new Map([
  ['synthetic-action-beta', new Set(['/personnel/[id]', '/payroll'])],
  ['synthetic-action-alpha', new Set(['/payroll'])],
  ['synthetic-unmapped', new Set<string>()],
]);
const {identity, ordinals} = actionCensusIdentity(registry);
const response = {page: '/payroll', matchedWorker: true, status: 200, elapsedMs: 320, actionOrdinal: ordinals.get('synthetic-action-beta')};
const report = (actionLane: string, role: string, serverActionResponses = [response]) => ({
  sourceSha: 'a'.repeat(40),
  buildId: 'fictional-build',
  actionLane,
  serverActionCensus: identity,
  serverActionInventory: {withMatchingPageEvidence: 1, matchedPageRegistrations: 1},
  journeys: [
    {role, status: 'observed', serverActionResponses},
    {role, status: 'failed', serverActionResponses: [{...response, actionOrdinal: undefined}]},
  ],
});

it('assigns stable build ordinals and deduplicates an action across lanes and page workers', () => {
  const reordered = actionCensusIdentity(new Map([...registry].reverse().map(([id, pages]) => [id, new Set([...pages].reverse())])));
  expect(reordered.identity).toEqual(identity);
  expect(reordered.ordinals).toEqual(ordinals);
  expect(actionCensusIdentity(new Map([...registry, ['synthetic-another', new Set(['/payroll'])]])).identity).not.toEqual(identity);

  const payroll = report('payroll', 'companyHR');
  payroll.journeys[0].serverActionResponses.push({...response, matchedWorker: false, actionOrdinal: undefined});
  payroll.journeys[0].serverActionResponses.push({...response, status: 500, actionOrdinal: undefined});
  const workforce = report('workforce', 'groupHR', [{...response, page: '/personnel/[id]', elapsedMs: 410}]);
  const samePage = report('approvals', 'companyHR', [{...response, elapsedMs: 180}]);
  const merged = mergeActionCensus([workforce, payroll, samePage]);
  expect(merged).toMatchObject({
    registered: 3,
    matchedActions: 1,
    matchedPageRegistrations: 2,
    missingLanes: ['shell'],
    byPageRole: [
      {page: '/payroll', role: 'companyHR', actions: 1, observations: 2, maxResponseMs: 320},
      {page: '/personnel/[id]', role: 'groupHR', actions: 1, observations: 1, maxResponseMs: 410},
    ],
  });
  expect(JSON.stringify(merged)).not.toContain('synthetic-action');
});

it('rejects cross-build, duplicate and incomplete coverage evidence', () => {
  const payroll = report('payroll', 'companyHR');
  const workforce = report('workforce', 'groupHR');
  expect(() => mergeActionCensus([payroll, {...workforce, buildId: 'other'}])).toThrow('different builds');
  expect(() => mergeActionCensus([payroll, {...workforce, sourceSha: 'b'.repeat(40)}])).toThrow('different source');
  expect(() => mergeActionCensus([payroll, {...workforce, serverActionCensus: {...identity, registryDigest: '1'.repeat(64)}}])).toThrow('different registries');
  expect(() => mergeActionCensus([payroll, payroll])).toThrow('duplicate action lane');
  expect(() => mergeActionCensus([report('payroll', 'companyHR', [])])).toThrow('differs from its observed responses');
  expect(() => mergeActionCensus([report('payroll', 'companyHR', [{...response, actionOrdinal: undefined}])])).toThrow('valid build ordinal');
});
