import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {catalogueOf,mergeCatalogueChanges,policyWithCatalogue} from '../packs/performance/onehr/catalogue-default-model';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
describe('catalogue defaults across review years',()=>{
 it('carries definitions without personal assignments or operational policy',()=>{
  const p=defaultPolicy(framework);p.profiles=[{id:randomUUID(),name:'Analyst',grade:'12',companyId:null,employmentIds:[randomUUID()],competencies:[]}];p.windows.pm_results={opensAt:null,closesAt:new Date().toISOString()};p.modules.pm=false;p.minValid=1;
  const next=policyWithCatalogue(defaultPolicy(framework),catalogueOf(p));
  expect(next.profiles[0]).not.toHaveProperty('employmentIds');expect(next.windows).toEqual({});expect(next.modules.pm).toBe(true);expect(next.minValid).toBe(4);
 });
 it('merges unrelated identities, removes routes explicitly and refuses stale overwrites',()=>{
  const p=defaultPolicy(framework),x={id:randomUUID(),name:'Analyst',grade:'12',companyId:null,competencies:[]},y={...x,id:randomUUID(),name:'Lead'};p.profiles=[x,y];p.careerRoutes=[{fromProfileId:x.id,toProfileId:y.id,kind:'pinned'}];const original=catalogueOf(p),current=structuredClone(original),edit=structuredClone(original);
  current.profiles[0].name='Updated Analyst';edit.profiles[1].name='Updated Lead';edit.careerRoutes=[];
  const merged=mergeCatalogueChanges(original,edit,current);expect(merged.profiles.map(p=>p.name)).toEqual(['Updated Analyst','Updated Lead']);expect(merged.careerRoutes).toEqual([]);
  edit.profiles[0].name='Stale Analyst';expect(()=>mergeCatalogueChanges(original,edit,current)).toThrow(/another cycle/);
  edit.profiles[0].name='Updated Analyst';expect(()=>mergeCatalogueChanges(original,edit,current)).not.toThrow();
 });
 it('keeps a newer framework when editing only a job profile and refuses conflicting framework edits',()=>{
  const original=catalogueOf(defaultPolicy(framework)),current=structuredClone(original),edit=structuredClone(original);current.framework[0].statements[0].text='Current shared description';
  edit.profiles=[{id:randomUUID(),name:'Analyst',grade:'12',companyId:null,competencies:[]}];expect(mergeCatalogueChanges(original,edit,current).framework).toEqual(current.framework);
  edit.framework[0].statements[0].text='Stale framework edit';expect(()=>mergeCatalogueChanges(original,edit,current)).toThrow(/framework was changed/);
 });
});
