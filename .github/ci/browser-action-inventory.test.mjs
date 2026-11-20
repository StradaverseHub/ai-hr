import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
 serverActionCoverage,serverActionPageMatcher,serverActionRegistry,
} from '../../scripts/performance/system-route-manifest.mjs';

const appPathRoutes={
 '/page':'/',
 '/payroll/page':'/payroll',
 '/people/[id]/page':'/people/[id]',
 '/people/settings/page':'/people/settings',
};
const routesManifest={dynamicRoutes:[{page:'/people/[id]',regex:'^/people/[^/]+$'}]};

test('labels server-action destinations by compiled static route or dynamic template',()=>{
 const pageFor=serverActionPageMatcher(appPathRoutes,routesManifest);
 assert.equal(pageFor('/'),'/');
 assert.equal(pageFor('/payroll/'),'/payroll');
 assert.equal(pageFor('/people/settings'),'/people/settings');
 assert.equal(pageFor('/people/fictional-record'),'/people/[id]');
 assert.equal(pageFor('/unregistered/fictional-record'),null);
});

test('shared action registration earns evidence only for its observed destination',()=>{
 const registrations=serverActionRegistry(appPathRoutes,{
  node:{
   shared:{workers:{'app/page':{},'app/payroll/page':{},'app/people/[id]/page':{}}},
   payrollOnly:{workers:{'app/payroll/page':{}}},
   unmapped:{workers:{'app/api/action/route':{}}},
   untouched:{workers:{'app/people/settings/page':{}}},
  },
  edge:{shared:{workers:{'app/payroll/page':{}}}},
 });
 const coverage=serverActionCoverage(registrations,new Map([
  ['shared',new Set(['/payroll','/people/[id]'])],
  ['payrollOnly',new Set(['/people/settings'])],
  ['unmapped',new Set([null])],
 ]));
 assert.equal(coverage.registered,4);
 assert.equal(coverage.acceptedInPassedJourneys,3);
 assert.equal(coverage.withMatchingPageEvidence,1);
 assert.equal(coverage.withoutMatchingPageEvidence,2);
 assert.equal(coverage.withoutPage,1);
 assert.equal(coverage.matchedPageRegistrations,2);
 assert.equal(coverage.pagesWithMatchingEvidence,2);
 assert.deepEqual(coverage.byPageWorker.map(row=>[row.path,row.registrations,row.acceptedInPassedJourneys]),[
  ['/',1,0],['/payroll',2,1],['/people/[id]',1,1],['/people/settings',1,0],
 ]);
});
