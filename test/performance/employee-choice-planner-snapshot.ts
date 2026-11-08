/** Read-only diagnostics for the owned fictional fixture, outside timed ports. */
import {owner} from '../harness';
export async function employeeChoicePlannerSnapshot(){
 const relations=await owner.client`select n.nspname,c.relname,c.relkind,c.reltuples,c.relpages,c.relallvisible,
  pg_relation_size(c.oid)::text as relation_bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and (c.relname in ('employment','person','assignment','company','department','business_unit')
   or c.oid in(select i.indexrelid from pg_index i where i.indrelid in('employment'::regclass,'person'::regclass,'assignment'::regclass,'company'::regclass,'department'::regclass,'business_unit'::regclass)))
  order by c.relname`;
 const columns=await owner.client`select schemaname,tablename,attname,inherited,null_frac,avg_width,n_distinct,correlation,
  most_common_vals::text as most_common_vals,most_common_freqs,
  array_length(histogram_bounds,1) as histogram_entries
  from pg_stats where schemaname='public' and tablename in ('employment','person','assignment','company','department','business_unit')
   and attname in ('id','person_id','employment_id','tenant_id','company_id','department_id','business_unit_id','terminated_on','valid_to','superseded_at')
  order by tablename,attname,inherited`;
 const analysis=await owner.client`select relname,n_live_tup,n_dead_tup,n_mod_since_analyze,last_analyze,last_autoanalyze
  from pg_stat_all_tables where schemaname='public' and relname in ('employment','person','assignment','company','department','business_unit') order by relname`;
 const settings=await owner.client`select name,setting,unit,source from pg_settings where name in
  ('server_version_num','random_page_cost','seq_page_cost','cpu_tuple_cost','cpu_index_tuple_cost','cpu_operator_cost','effective_cache_size',
   'default_statistics_target','jit_above_cost','jit_inline_above_cost','jit_optimize_above_cost','enable_hashjoin','enable_mergejoin','enable_nestloop','plan_cache_mode','geqo_threshold') order by name`;
 return {relations,columns,analysis,settings,settingsScope:'Owned fixture owner session; native per-call identity/settings remain separately recorded.'};
}
