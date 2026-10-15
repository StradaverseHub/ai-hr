import {expect,it} from 'vitest';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {buildAssessmentOverview,type OverviewCounts} from '../packs/performance/onehr/overview-model';
const policy=defaultPolicy(framework),now=new Date(),group:OverviewCounts={id:'a',name:'A',businessGroup:'A',company:'',people:250,counts:{pm:{done:249,total:250},f360:{done:1,total:8},competency:{done:0,total:0},calibration:{done:0,total:1},idp:{done:0,total:250}}};
it('floors source overview percentages and weights totals by actual work, not group percentages',()=>{
 const other={...group,id:'b',name:'B',people:1,counts:{...group.counts,pm:{done:1,total:1},f360:{done:2,total:2}}};
 const result=buildAssessmentOverview(policy,'cycle',[group,other],now);expect(result.rows[0].cells.pm.pct).toBe(99);expect(result.rows[0].cells.f360.pct).toBe(12);expect(result.totals.cells.f360).toMatchObject({done:3,total:10,pct:30});expect(result.notes.behind).toBe('A');expect(result.rows[0].cells.pm.href).toContain('progressGroup=A');
});
it('shows a future opening instead of fabricated zero completion, while retaining already submitted work',()=>{
 const p={...policy,windows:{...policy.windows,pm_results:{opensAt:new Date(now.getTime()+86400000).toISOString(),closesAt:null}}};
 const empty={...group,counts:{...group.counts,pm:{done:0,total:250}}};expect(buildAssessmentOverview(p,'cycle',[empty],now).rows[0].cells.pm).toMatchObject({pct:null,state:'not_open',href:null});expect(buildAssessmentOverview(p,'cycle',[group],now).rows[0].cells.pm.pct).toBe(99);
});
it('omits disabled modules and distinguishes no assignments from pending work',()=>{
 const p={...policy,modules:{...policy.modules,pm:false,idp:false,calibration:false}};
 const result=buildAssessmentOverview(p,'cycle',[group],now);expect(result.modules).toEqual(['f360','competency']);expect(result.rows[0].cells.competency).toMatchObject({total:0,pct:null,href:null});expect(result.notes.behind).toBeNull();
});
