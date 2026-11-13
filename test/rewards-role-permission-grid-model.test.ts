/** Board db14e49c: the Role permissions catalogue - agreed defaults, the options each cell offers, locked cells,
 * batch validation and version compare/restore arithmetic. Pure; no database. */
import {describe,expect,it} from 'vitest';
import {
 REWARD_LIMIT_CONTROLS_ROW_ENABLED,permissionRows,rewardPermissionCatalogue,rewardAccessRoles,rewardDefaultLevel,rewardLevelOptions,rewardCellLock,rewardScopeLabel,
 rewardBatchProblems,applyRewardPermissionChanges,compareRewardPermissionMatrices,rewardLockedOverrides,effectiveRewardLevel,rolePermission,rewardLevelRank,
} from '../packs/rewards/access-policy-model';
import en from '../messages/en.json';

describe('Role permissions catalogue',()=>{
 it('corrects the rows: renamed, added and removed pages',()=>{
  const ids=permissionRows.map(r=>r.id);
  expect(ids).toContain('promotions.view');expect(ids).not.toContain('cycles.view' as never);
  expect(en.rewardAccessPolicy.permissions.review.view).toBe('Reviewing Team Rewards');
  expect(en.rewardAccessPolicy.permissions.promotions.view).toBe('Promotion nominations');
  expect(en.rewardAccessPolicy.permissions.restricted.view).toBe('Restricted (EC) direct reports');
  expect(en.rewardAccessPolicy.roles.hr_admin).toBe('HR Admin');expect(en.rewardAccessPolicy.roles.payroll).toBe('Payroll');
  expect('cycles' in en.rewardAccessPolicy.permissions).toBe(false);
 });
 it('shows and saves the Limit Controls row now that its page follows the grid (board fc804e8c)',()=>{
  expect(REWARD_LIMIT_CONTROLS_ROW_ENABLED).toBe(true);
  expect(permissionRows.filter(r=>r.id==='limits.view')).toEqual([{id:'limits.view',category:'pages',kind:'page',editable:true}]);
  expect(rewardBatchProblems([{role:'ctro',capability:'limits.view',after:'none'}],[])).toEqual([]);
  // The default stays the ceiling: CTRO cannot be widened to Full; Group Rewards can drop to View only or —.
  expect(rewardBatchProblems([{role:'ctro',capability:'limits.view',after:'full'}],[]).map(p=>p.code)).not.toEqual([]);
  expect(rewardLevelOptions('gr','limits.view')).toEqual(['full','view','none']);
  expect(rewardLevelOptions('ctro','limits.view')).toEqual(['view','none']);
  expect(rewardLevelOptions('bu','limits.view')).toEqual(['none']);
 });
 it('sets the agreed defaults that match what the server already allows',()=>{
  const row=(capability:Parameters<typeof rewardDefaultLevel>[1])=>Object.fromEntries(rewardAccessRoles.map(role=>[role,rewardDefaultLevel(role,capability)]));
  // Board 60f1fdcd (migration 5600): Group Rewards, CTRO and HR Admin edit Salary Structures, Bonus Matrices and company PAT.
  expect(row('salary.view')).toEqual({bu:'none',bg:'none',proxy_bg:'none',gr:'full',ctro:'full',ec:'none',pbp:'none',hr_admin:'full',payroll:'none'});
  expect(row('bonus.view')).toEqual(row('salary.view'));expect(row('pat.manage')).toEqual(row('salary.view'));
  expect(row('senior.manage')).toEqual({bu:'none',bg:'none',proxy_bg:'none',gr:'full',ctro:'view',ec:'view',pbp:'none',hr_admin:'none',payroll:'none'});
  expect(row('restricted.view')).toEqual({bu:'none',bg:'none',proxy_bg:'none',gr:'step',ctro:'step',ec:'step',pbp:'none',hr_admin:'none',payroll:'none'});
  // CTRO and HR Admin get no Full on configuration pages the database does not let them use (plans and Rewards Access).
  for(const capability of ['plans.manage','access.manage'] as const){expect(rewardDefaultLevel('ctro',capability)).not.toBe('full');expect(rewardDefaultLevel('hr_admin',capability)).toBe('none');}
  // PBP has no case decision in SQL (app.reward_role_native_capability), so the grid no longer claims View only.
  expect(rewardDefaultLevel('pbp','cases.decide')).toBe('none');
  expect(rewardDefaultLevel('proxy_bg','offcycle.decide')).toBe('step');
 });
 it('offers only the options that make sense for the row, never above the default',()=>{
  expect(rewardLevelOptions('gr','salary.view')).toEqual(['full','view','none']);
  expect(rewardLevelOptions('ctro','salary.view')).toEqual(['full','view','none']);
  expect(rewardLevelOptions('hr_admin','bonus.view')).toEqual(['full','view','none']);
  expect(rewardLevelOptions('hr_admin','pat.manage')).toEqual(['full','none']);
  expect(rewardLevelOptions('bu','review.view')).toEqual(['view','none']);
  expect(rewardLevelOptions('proxy_bg','offcycle.decide')).toEqual(['step','none']);
  expect(rewardLevelOptions('gr','plans.manage')).toEqual(['full','none']);
  expect(rewardLevelOptions('ec','restricted.view')).toEqual(['step','view']);
  expect(rewardLevelOptions('bu','salary.view')).toEqual(['none']);
  for(const row of rewardPermissionCatalogue)if(row.editable)for(const role of rewardAccessRoles)for(const level of rewardLevelOptions(role,row.id))expect(rewardLevelRank(level)).toBeLessThanOrEqual(rewardLevelRank(rewardDefaultLevel(role,row.id)));
 });
 it('locks the fixed rules and explains why',()=>{
  expect(rewardCellLock('gr','access.manage')).toBe('accessKeeper');
  expect(rewardCellLock('bu','own.never')).toBe('ownNever');expect(rolePermission('bu','own.never')).toBe('never');
  expect(rewardCellLock('ctro','route')).toBe('route');
  for(const role of ['bu','bg','gr','ctro','ec'] as const)expect(rewardCellLock(role,'review.decide')).toBe('approvalOrder');
  expect(rewardCellLock('proxy_bg','review.decide')).toBeNull();
  expect(rewardCellLock('hr_admin','review.view')).toBe('notApplicable');
  expect(en.rewardAccessPolicy.grid.locks.accessKeeper).toBe("Group Rewards keeps Rewards Access so it can't lock itself out.");
 });
 it('names the scope type per role',()=>{
  expect(Object.fromEntries(rewardAccessRoles.map(role=>[role,rewardScopeLabel(role)]))).toEqual({bu:'assignedCompanies',bg:'assignedBusinessUnits',proxy_bg:'assignedBusinessUnits',gr:'wholeGroup',ctro:'wholeGroup',ec:'wholeGroup',pbp:'assignedCompaniesView',hr_admin:'none',payroll:'assignedCompanies'});
 });
 it('refuses a whole batch with one bad cell: locked, wider than default, own role or duplicate',()=>{
  expect(rewardBatchProblems([{role:'bu',capability:'review.view',after:'none'},{role:'gr',capability:'access.manage',after:'none'}],[])).toEqual([{role:'gr',capability:'access.manage',code:'locked'}]);
  expect(rewardBatchProblems([{role:'ctro',capability:'limits.view',after:'full'}],[])).toEqual([{role:'ctro',capability:'limits.view',code:'option'}]);
  expect(rewardBatchProblems([{role:'ctro',capability:'bonus.view',after:'none'}],['ctro'])).toEqual([{role:'ctro',capability:'bonus.view',code:'held'}]);
  expect(rewardBatchProblems([{role:'bu',capability:'own.never',after:'none'}],[])).toEqual([{role:'bu',capability:'own.never',code:'unknown'}]);
  expect(rewardBatchProblems([{role:'bu',capability:'review.view',after:'none'},{role:'bu',capability:'review.view',after:'view'}],[])[0].code).toBe('duplicate');
  // A locked cell may go back to its default (clearing an older saved setting that removed an approval step).
  expect(rewardBatchProblems([{role:'bu',capability:'review.decide',after:'step'}],[])).toEqual([]);
  expect(rewardBatchProblems([{role:'bu',capability:'review.decide',after:'none'}],[])).toEqual([{role:'bu',capability:'review.decide',code:'locked'}]);
 });
 it('stores only cells that differ from their default and compares versions cell by cell',()=>{
  const v1=applyRewardPermissionChanges({},[{role:'ctro',capability:'bonus.view',after:'none'},{role:'bu',capability:'review.view',after:'view'}]);
  expect(v1).toEqual({'ctro:bonus.view':'none'});
  const v2=applyRewardPermissionChanges(v1,[{role:'ctro',capability:'bonus.view',after:'view'},{role:'gr',capability:'salary.view',after:'view'}]);
  // CTRO's Bonus Matrices default is Full (5600), so View only is a narrowing that is stored.
  expect(v2).toEqual({'ctro:bonus.view':'view','gr:salary.view':'view'});
  expect(compareRewardPermissionMatrices(v1,v2)).toEqual([{role:'gr',capability:'salary.view',before:'full',after:'view'},{role:'ctro',capability:'bonus.view',before:'none',after:'view'}]);
  expect(effectiveRewardLevel('ctro','limits.view','full')).toBe('view');
  expect(rewardLockedOverrides({'bu:review.decide':'none','ctro:bonus.view':'none'})).toEqual([{role:'bu',capability:'review.decide',level:'none'}]);
 });
});
