import {readFileSync} from 'node:fs';
import {sql,asc} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {adminCtx,migrateTestDb,resetDb,seedBase,owner,closeAll,type Base} from './harness';
import {createProfileOption} from '../core/profile-options';
import {createJobGrade} from '../core/admin';
import {createGradeGroup} from '../packs/leave/service';
import * as s from '../db/schema';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const migration=readFileSync(new URL('../db/migrations/3400_system_label_company_scope.sql',import.meta.url),'utf8');
describe('System Labels populated-baseline migration rehearsal',()=>{
 it('applies the exact new SQL over populated pre-scope tables while preserving all identities and values',async()=>{
  const option=await createProfileOption(adminCtx(b),{category:'division',value:'MIGRATION_PRESERVED',label:'Existing division'});
  const grade=await createJobGrade(adminCtx(b),{code:'MIGRATION_GRADE',name:'Existing grade'});
  const group=await createGradeGroup(adminCtx(b),{name:'Existing group',gradeIds:[grade.id]});
  const before={options:await owner.db.select().from(s.profileOption).orderBy(asc(s.profileOption.id)),grades:await owner.db.select().from(s.jobGrade).orderBy(asc(s.jobGrade.id)),groups:await owner.db.select().from(s.gradeGroup).orderBy(asc(s.gradeGroup.id)),members:await owner.db.select().from(s.gradeGroupMember).orderBy(asc(s.gradeGroupMember.id))};
  const rolledBack=new Error('Rehearsal completed; restore fixture schema');
  let rehearsed=false;
  try{await owner.db.transaction(async tx=>{
   // Model the real preceding schema inside this rollback-only disposable fixture transaction.
   await tx.execute(sql.raw(`DO $$ DECLARE p record; f record; BEGIN
    FOR p IN SELECT schemaname,tablename,policyname FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'label_scope_%' LOOP
     EXECUTE format('DROP POLICY %I ON %I.%I',p.policyname,p.schemaname,p.tablename); END LOOP;
    FOR f IN SELECT proc.oid::regprocedure signature FROM pg_proc proc JOIN pg_namespace ns ON ns.oid=proc.pronamespace WHERE ns.nspname='app' AND proc.proname LIKE 'system_label_%' AND proc.proname IN('system_label_scope_applies','system_label_scope_read','system_label_scope_admin','system_label_scope_guard','system_label_person_company','system_label_value_scope_allowed','system_label_selection_guard','system_label_catalog_conflicts','system_label_employment_company') LOOP
     EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE',f.signature); END LOOP;
    DROP FUNCTION app.profile_option_value_allowed(text,text,text,uuid);
    ALTER TABLE profile_option DROP COLUMN scope_company_ids CASCADE;
    ALTER TABLE job_grade DROP COLUMN scope_company_ids CASCADE;
    ALTER TABLE grade_group DROP COLUMN scope_company_ids CASCADE;
   END $$;`));
   await tx.execute(sql.raw(migration));
   expect(await tx.select().from(s.profileOption).orderBy(asc(s.profileOption.id))).toEqual(before.options);
   expect(await tx.select().from(s.jobGrade).orderBy(asc(s.jobGrade.id))).toEqual(before.grades);
   expect(await tx.select().from(s.gradeGroup).orderBy(asc(s.gradeGroup.id))).toEqual(before.groups);
   expect(await tx.select().from(s.gradeGroupMember).orderBy(asc(s.gradeGroupMember.id))).toEqual(before.members);
   expect(before.options.find(r=>r.id===option.id)?.scopeCompanyIds).toBeNull();
   expect(before.grades.find(r=>r.id===grade.id)?.scopeCompanyIds).toBeNull();
   expect(before.groups.find(r=>r.id===group.id)?.scopeCompanyIds).toBeNull();
   rehearsed=true;throw rolledBack;
  });}catch(error){if(error!==rolledBack)throw error;}
  expect(rehearsed).toBe(true);
 });
});
