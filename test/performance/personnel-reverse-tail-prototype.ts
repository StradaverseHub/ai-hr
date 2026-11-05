/** Test-only structural rewrite of the canonical query. Native owners and bound values stay intact. */
import {PgDialect} from 'drizzle-orm/pg-core';
import {sql,type SQL} from 'drizzle-orm';
import {expect} from 'vitest';
import {personnelListPageSql} from '../../core/read';

export function personnelReverseTailPrototype(
 page:Parameters<typeof personnelListPageSql>[0],facets:Parameters<typeof personnelListPageSql>[1],
):SQL{
 const compiled=new PgDialect().sqlToQuery(personnelListPageSql(page,facets,{
  source:sql`app.access_workforce_list_facts()`,materialized:true,projectPageFacts:true,
 }));
 let text=compiled.sql;
 const selectedStart=text.indexOf('selected_page as materialized(');
 const selectedEnd=text.indexOf('), page_projection(value)as materialized(',selectedStart);
 const statusStart=text.indexOf('), status_counts as materialized(');
 const finalStart=text.indexOf('\n      select coalesce',statusStart);
 expect(selectedStart).toBeGreaterThan(0);expect(selectedEnd).toBeGreaterThan(selectedStart);
 expect(statusStart).toBeGreaterThan(selectedEnd);expect(finalStart).toBeGreaterThan(statusStart);
 const selected=text.slice(selectedStart+'selected_page as materialized('.length,selectedEnd);
 const selection=selected.match(/([\s\S]*?)where workforce_row\.page_matches\s+order by ([\s\S]*?) limit (\$\d+) offset (\$\d+)\s*$/);
 expect(selection).not.toBeNull();
 const [,projection,order,limit,offset]=selection!;
 const keys=order.split(',').map(key=>key.trim());
 expect(keys.every(key=>/^workforce_row\.[a-z_]+$/.test(key))).toBe(true);
 let status=text.slice(statusStart+3,finalStart);
 expect(status.split('::int as page_count,')).toHaveLength(2);
 status=status.replace('::int as page_count,','::int as page_count,\n          count(*)filter(where workforce_row.page_matches)::bigint as page_rows,');
 const size='coalesce((select sum(page_rows)::bigint from status_counts),0::bigint)';
 const reverse=`(${offset}>0 and ${offset}<${size} and ${offset}>=${size}/2)`;
 const ascending=`${projection}where workforce_row.page_matches and ${offset}<${size} and not ${reverse}
        order by ${order} limit ${limit} offset ${offset}`;
 const descending=`${projection}where workforce_row.page_matches and ${reverse}
        order by ${keys.map(key=>key+' desc').join(',')}
        limit least(${limit},greatest(${size}-${offset},0)) offset greatest(${size}-${offset}-${limit},0)`;
 const chosenOrder=keys.map(key=>key.replace('workforce_row.','chosen.')).join(',');
 const replacement=`selected_page as materialized(
        select chosen.* from ((${ascending}) union all (${descending})) chosen order by ${chosenOrder}
      `;
 text=text.slice(0,statusStart)+')'+text.slice(finalStart);
 text=text.slice(0,selectedStart)+status+',\n      '+replacement+text.slice(selectedEnd);
 // Rebind every original placeholder through Drizzle. No value or request text is SQL syntax.
 const pieces=text.split(/(\$\d+)/g).map(piece=>{
  if(!/^\$\d+$/.test(piece))return sql.raw(piece);
  const index=Number(piece.slice(1))-1;
  expect(index).toBeGreaterThanOrEqual(0);expect(index).toBeLessThan(compiled.params.length);
  return sql`${compiled.params[index]}`;
 });
 return sql.join(pieces,sql.raw(''));
}
