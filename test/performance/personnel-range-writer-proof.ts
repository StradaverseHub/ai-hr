/** Disposable delta maintenance for a fixed range proof. Not a trigger, migration or writer contract. */
import type postgres from 'postgres';

type Create=(ddl:string,drop:string)=>Promise<void>;
export type NativeWriterTx=postgres.TransactionSql;

const orderTable='app.performance_personnel_order';
const signatureTable='app.performance_personnel_count';
const blocksTable='app.performance_personnel_blocks';
export const lifecycleDates=['resignation_date','last_working_date','terminated_on','final_confirmation_date',
 'confirmation_date','probation_end_date','provisional_end_on','blacklisted_at'] as const;

export async function installDisposableRangeWriter(create:Create){
 const nameBounds='app.performance_personnel_name_bounds',companyBounds='app.performance_personnel_company_bounds';
 await create('create table '+nameBounds+' as select distinct on(tenant_id,name_block) tenant_id,name_block,name,employment_id from '+orderTable+
  ' order by tenant_id,name_block,name,employment_id','drop table '+nameBounds);
 await create('create table '+companyBounds+' as select distinct on(tenant_id,company_block) tenant_id,company_block,company_folded,name_folded,employment_id from '+orderTable+
  ' order by tenant_id,company_block,company_folded,name_folded,employment_id','drop table '+companyBounds);
 await create('create index performance_personnel_name_boundary on '+nameBounds+'(tenant_id,name,employment_id) include(name_block)',
  'drop index app.performance_personnel_name_boundary');
 await create('create index performance_personnel_company_boundary on '+companyBounds+'(tenant_id,company_folded,name_folded,employment_id) include(company_block)',
  'drop index app.performance_personnel_company_boundary');
 const refresh='app.performance_personnel_refresh_order';
 const columns=lifecycleDates.join(','),employmentDates=lifecycleDates.map(date=>'e.'+date).join(',');
 const scopeGroups='tenant_id,company_id',signature=scopeGroups+','+columns;
 // Negative deltas need an existing row; the constraints below forbid an accidental underflow.
 // We do not materialize any cached permission. The read proof still evaluates native grants.
 const refreshSql=`
 CREATE FUNCTION ${refresh}(subject_ids uuid[]) RETURNS void
 LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $maintain$
 DECLARE previous ${orderTable}[]; bad boolean;
 BEGIN
  WITH removed AS (
   DELETE FROM ${orderTable} o WHERE o.employment_id=ANY(subject_ids) RETURNING o AS prior
  ) SELECT coalesce(array_agg(prior),ARRAY[]::${orderTable}[]) INTO previous FROM removed;

  INSERT INTO ${orderTable}(tenant_id,company_id,employment_id,name,name_folded,company_folded,name_block,company_block,${columns})
  SELECT e.tenant_id,e.company_id,e.id,p.full_name,lower(p.full_name),lower(c.legal_name),
   coalesce((select b.name_block from ${nameBounds} b where b.tenant_id=e.tenant_id
    and (b.name,b.employment_id)<=(p.full_name,e.id) order by b.name desc,b.employment_id desc limit 1),0),
   coalesce((select b.company_block from ${companyBounds} b where b.tenant_id=e.tenant_id
    and (b.company_folded,b.name_folded,b.employment_id)<=(lower(c.legal_name),lower(p.full_name),e.id)
    order by b.company_folded desc,b.name_folded desc,b.employment_id desc limit 1),0),
   ${employmentDates}
  FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
  WHERE e.id=ANY(subject_ids) AND e.voided_at IS NULL ORDER BY e.id;

  WITH row_delta AS (
   SELECT o.*,-1 AS delta FROM unnest(previous) o
   UNION ALL SELECT o.*,1 FROM ${orderTable} o WHERE o.employment_id=ANY(subject_ids)
  ), range_delta AS (
   SELECT tenant_id,company_id,'name' AS sort,name_block AS block_no,delta FROM row_delta
   UNION ALL SELECT tenant_id,company_id,'company',company_block,delta FROM row_delta
  ), deltas AS (
   SELECT tenant_id,company_id,sort,block_no,sum(delta)::bigint AS delta
   FROM range_delta GROUP BY 1,2,3,4 HAVING sum(delta)<>0
  ), updated AS (
   INSERT INTO ${blocksTable} AS target(tenant_id,company_id,sort,block_no,quantity)
   SELECT tenant_id,company_id,sort,block_no,delta FROM deltas ORDER BY tenant_id,sort,company_id,block_no
   ON CONFLICT(tenant_id,sort,company_id,block_no) DO UPDATE SET quantity=target.quantity+excluded.quantity
   RETURNING quantity
  ) SELECT EXISTS(SELECT 1 FROM updated WHERE quantity<0) INTO bad;
  IF bad THEN RAISE EXCEPTION 'Invalid Personnel fixture range delta' USING ERRCODE='55000'; END IF;

  WITH row_delta AS (
   SELECT o.*,-1 AS delta FROM unnest(previous) o
   UNION ALL SELECT o.*,1 FROM ${orderTable} o WHERE o.employment_id=ANY(subject_ids)
  ), deltas AS (
   SELECT ${signature},sum(delta)::bigint AS delta FROM row_delta GROUP BY 1,2,3,4,5,6,7,8,9,10 HAVING sum(delta)<>0
  ), updated AS (
   INSERT INTO ${signatureTable} AS target(${signature},quantity)
   SELECT ${signature},delta FROM deltas ORDER BY ${signature}
   ON CONFLICT(${signature}) DO UPDATE SET quantity=target.quantity+excluded.quantity
   RETURNING quantity
  ) SELECT EXISTS(SELECT 1 FROM updated WHERE quantity<0) INTO bad;
  IF bad THEN RAISE EXCEPTION 'Invalid Personnel fixture signature delta' USING ERRCODE='55000'; END IF;
 END
 $maintain$;`;
 // This procedure runs only as fixture owner. No app role can call it or write the scratch tables.
 await create(refreshSql+'revoke all on function '+refresh+'(uuid[]) from public,ai_hr_app','drop function '+refresh+'(uuid[])');
 return (tx:NativeWriterTx,ids:string[])=>tx`select app.performance_personnel_refresh_order(${ids}::uuid[])`;
}
