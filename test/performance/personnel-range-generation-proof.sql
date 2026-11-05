-- Disposable test objects. The hosted test drops the whole private schema.
create schema perf_personnel_generation;
create table perf_personnel_generation.head(
 tenant_id uuid primary key, generation uuid not null, state text not null check(state in ('building','active'))
);
create table perf_personnel_generation.dirty(
 id bigint generated always as identity primary key,
 generation uuid not null, kind text not null, subject_id uuid not null
);
create index on perf_personnel_generation.dirty(generation);
create view perf_personnel_generation.source as
 select e.tenant_id,e.company_id,e.id,e.person_id,p.full_name as name,
  jsonb_build_object('blacklisted',e.blacklisted_at,'resigned',e.resignation_date,'last_working',e.last_working_date,
   'terminated',e.terminated_on,'final_confirmation',e.final_confirmation_date,'confirmation',e.confirmation_date,
   'probation',e.probation_end_date,'provisional',e.provisional_end_on) as lifecycle
 from public.employment e
 join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id
 join public.company c on c.id=e.company_id and c.tenant_id=e.tenant_id
 where e.voided_at is null;
create table perf_personnel_generation.boundary(
 generation uuid not null, block integer not null, name text not null, id uuid not null,
 primary key(generation,block)
);
create index on perf_personnel_generation.boundary(generation,name,id) include(block);
create table perf_personnel_generation.fact(
 generation uuid not null, id uuid not null, person_id uuid not null, company_id uuid not null,
 name text not null, lifecycle jsonb not null, block integer not null,
 primary key(generation,id)
);
create index on perf_personnel_generation.fact(generation,person_id);
create index on perf_personnel_generation.fact(generation,block,name,id) include(company_id);
create table perf_personnel_generation.range_count(
 generation uuid not null, block integer not null, company_id uuid not null, quantity bigint not null check(quantity>0),
 primary key(generation,block,company_id)
);
create table perf_personnel_generation.lifecycle_count(
 generation uuid not null, company_id uuid not null, lifecycle jsonb not null, quantity bigint not null,
 primary key(generation,company_id,lifecycle)
);

create function perf_personnel_generation.capture() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare subject record; active uuid;
begin
 if tg_op='DELETE' then subject:=old; else subject:=new; end if;
 if tg_op='UPDATE' then
  if tg_table_name='person' then
   if (new.id,new.tenant_id,new.full_name) is not distinct from (old.id,old.tenant_id,old.full_name) then return null; end if;
  elsif tg_table_name='employment' then
   if (new.id,new.tenant_id,new.company_id,new.person_id,new.voided_at,new.blacklisted_at,new.resignation_date,
    new.last_working_date,new.terminated_on,new.final_confirmation_date,new.confirmation_date,new.probation_end_date,new.provisional_end_on)
    is not distinct from
    (old.id,old.tenant_id,old.company_id,old.person_id,old.voided_at,old.blacklisted_at,old.resignation_date,
     old.last_working_date,old.terminated_on,old.final_confirmation_date,old.confirmation_date,old.probation_end_date,old.provisional_end_on)
   then return null; end if;
  end if;
  -- An identity move needs both before/after witnesses. This small proof explicitly refuses it.
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id then
   raise exception 'Unsupported identity move in the disposable projection fixture' using errcode='55000';
  end if;
 end if;
 select generation into active from perf_personnel_generation.head where tenant_id=subject.tenant_id for share;
 if found then insert into perf_personnel_generation.dirty(generation,kind,subject_id) values(active,tg_table_name,subject.id); end if;
 return null;
end $$;
create trigger perf_personnel_generation_person after insert or update or delete on public.person
 for each row execute function perf_personnel_generation.capture();
create trigger perf_personnel_generation_employment after insert or update or delete on public.employment
 for each row execute function perf_personnel_generation.capture();

create trigger perf_personnel_generation_company after insert or delete on public.company
 for each row execute function perf_personnel_generation.capture();

create function perf_personnel_generation.repair(p_tenant uuid,p_cap integer) returns integer
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare active uuid; marker_ids bigint[]; subjects uuid[]; touched integer[];
 previous perf_personnel_generation.fact[];
begin
 if p_cap is null or p_cap<1 or p_cap>8 then raise exception 'Invalid fixture repair bound'; end if;
 select generation into strict active from perf_personnel_generation.head where tenant_id=p_tenant and state='active' for update nowait;
 select array(select d.id from perf_personnel_generation.dirty d where generation=active order by id limit p_cap) into marker_ids;
 if cardinality(marker_ids)=0 then return 0; end if;
 if exists(select 1 from perf_personnel_generation.dirty where id=any(marker_ids) and kind='company') then return -1; end if;
 select array(
  select id from (
   select subject_id as id from perf_personnel_generation.dirty where id=any(marker_ids) and kind='employment'
   union
   select f.id from perf_personnel_generation.fact f join perf_personnel_generation.dirty d on d.subject_id=f.person_id
    where f.generation=active and d.id=any(marker_ids) and d.kind='person'
   union
   select e.id from public.employment e join perf_personnel_generation.dirty d on d.subject_id=e.person_id
    where e.tenant_id=p_tenant and d.id=any(marker_ids) and d.kind='person'
  ) changed limit p_cap+1
 ) into subjects;
 if cardinality(subjects)>p_cap then return -1; end if;

 with removed as (
  delete from perf_personnel_generation.fact f where f.generation=active and f.id=any(subjects) returning f as prior
 ) select coalesce(array_agg(prior),array[]::perf_personnel_generation.fact[]) into previous from removed;
 insert into perf_personnel_generation.fact(generation,id,person_id,company_id,name,lifecycle,block)
 select active,s.id,s.person_id,s.company_id,s.name,s.lifecycle,
  coalesce((select b.block from perf_personnel_generation.boundary b where b.generation=active and (b.name,b.id)<=(s.name,s.id)
   order by b.name desc,b.id desc limit 1),0)
 from perf_personnel_generation.source s where s.tenant_id=p_tenant and s.id=any(subjects);

 select array(select block from unnest(previous) union select block from perf_personnel_generation.fact where generation=active and id=any(subjects)) into touched;
 delete from perf_personnel_generation.range_count where generation=active and block=any(touched);
 insert into perf_personnel_generation.range_count
 select generation,block,company_id,count(*) from perf_personnel_generation.fact where generation=active and block=any(touched)
 group by generation,block,company_id;

 insert into perf_personnel_generation.lifecycle_count as target
 select active,company_id,lifecycle,sum(delta) from (
  select company_id,lifecycle,-1 as delta from unnest(previous)
  union all select company_id,lifecycle,1 from perf_personnel_generation.fact where generation=active and id=any(subjects)
 ) signed group by company_id,lifecycle having sum(delta)<>0
 on conflict(generation,company_id,lifecycle) do update set quantity=target.quantity+excluded.quantity;
 if exists(select 1 from perf_personnel_generation.lifecycle_count where generation=active and quantity<0) then
  raise exception 'Invalid fixture lifecycle delta';
 end if;
 delete from perf_personnel_generation.lifecycle_count where generation=active and quantity=0;
 delete from perf_personnel_generation.dirty where id=any(marker_ids);
 return cardinality(marker_ids);
end $$;

create function app.performance_personnel_generation_page(page_companies uuid[],facet_companies uuid[],page_size integer,page_offset integer,as_of date)
returns table(rows jsonb,total integer,status_counts jsonb)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 with ready as materialized (
  select h.generation from perf_personnel_generation.head h
  where h.tenant_id=app.current_tenant_id() and h.state='active'
   and not exists(select 1 from perf_personnel_generation.dirty d where d.generation=h.generation)
 ), permitted as materialized (
  select c.id from public.company c where c.tenant_id=app.current_tenant_id() and app.access_workforce_projection_company(c.id)
 ), blocks as (
  select b.block,sum(b.quantity)::bigint as quantity,
   sum(sum(b.quantity)) over(order by b.block rows unbounded preceding)::bigint as running
  from perf_personnel_generation.range_count b join ready r using(generation)
  where b.company_id=any(page_companies) and b.company_id in(select id from permitted) group by b.block
 ), anchor as (
  select block,(page_offset-(running-quantity))::int as local_offset from blocks where running>page_offset order by block limit 1
 ), selected as materialized (
  select f.id,f.name from perf_personnel_generation.fact f join ready r using(generation)
  where f.company_id=any(page_companies) and f.company_id in(select id from permitted) and f.block>=(select block from anchor)
  order by f.block,f.name,f.id limit page_size offset (select local_offset from anchor)
 ), details(value) as materialized (
  select value from app.access_workforce_list_rows_for_ids(array(select id from selected))d(value)
 ), counts as materialized (
  select app.employment_status_on((lifecycle->>'blacklisted')::timestamptz,(lifecycle->>'resigned')::date,
   (lifecycle->>'last_working')::date,(lifecycle->>'terminated')::date,(lifecycle->>'final_confirmation')::date,
   (lifecycle->>'confirmation')::date,(lifecycle->>'probation')::date,(lifecycle->>'provisional')::date,as_of) as status,
   sum(quantity) filter(where company_id=any(page_companies))::int as page_count,
   sum(quantity) filter(where company_id=any(facet_companies))::int as facet_count
  from perf_personnel_generation.lifecycle_count join ready using(generation)
  where company_id in(select id from permitted) group by 1
 )
 select coalesce((select jsonb_agg(d.value order by s.name,s.id) from selected s join details d
    on (d.value->>'employmentId')::uuid=s.id),'[]'::jsonb),
  coalesce((select sum(page_count)::int from counts),0),
  coalesce((select jsonb_agg(jsonb_build_object('status',status,'count',facet_count)) from counts where facet_count>0),'[]'::jsonb)
 from ready
 where page_companies is not null and facet_companies is not null and page_size between 0 and 25 and page_offset>=0
  and (select count(*) from selected)=(select count(*) from details)
$$;

revoke all on schema perf_personnel_generation from public,ai_hr_app;
revoke all on all functions in schema perf_personnel_generation from public,ai_hr_app;
revoke all on function app.performance_personnel_generation_page(uuid[],uuid[],integer,integer,date) from public,ai_hr_app;
grant execute on function app.performance_personnel_generation_page(uuid[],uuid[],integer,integer,date) to ai_hr_app;
