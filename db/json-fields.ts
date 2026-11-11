/** A Drizzle select's field map carried inside one bundled JSON statement, decoded exactly as that select returns it
 * (core/pre-salary/before-payroll-bundle.ts, docs/adr/2026-11-10-home-request-read-scope.md decision 11).
 *
 * The rules are db/json-row.ts's, applied to a select's own field map instead of a table's columns:
 *  - a column whose JSON form equals its driver form (text, uuid, enum, boolean, integer, date, time, json) is sent as
 *    itself; any other column (numeric, bigint, timestamp, …) is sent as its `::text` output, which is byte for byte the
 *    text the driver receives, and is decoded by that column's own `mapFromDriverValue`;
 *  - an SQL expression mapped with a column (`sql\`…\`.mapWith(column)`) follows that column's rule;
 *  - any other SQL expression is sent as written. The driver returns such an expression untyped (db/client.ts keeps
 *    every date and timestamp as text), so a caller sends a timestamp, numeric or bigint expression as `::text`
 *    itself; boolean, integer, text, date, uuid, enum and json expressions are JSON-faithful as they are.
 * A value that arrives in the wrong form fails closed rather than decoding to a nearby value. */
import {Column,is,sql,SQL,type DriverValueDecoder} from 'drizzle-orm';
import {jsonFaithful} from './json-row';

export type JsonField=Column|SQL|SQL.Aliased;
export type JsonFieldMap=Readonly<Record<string,JsonField>>;
type Decoded<F extends JsonFieldMap>={[K in keyof F]:F[K] extends Column?F[K]['_']['data']|null:F[K] extends SQL<infer T>|SQL.Aliased<infer T>?T:never};

const SAFE_KEY=/^[A-Za-z_][A-Za-z0-9_]*$/;
const expression=(field:SQL|SQL.Aliased):SQL=>is(field,SQL.Aliased)?field.sql:field;
/** The decoder Drizzle applies to a field's driver value: the column's own, or the expression's (identity unless mapped). */
const decoderOf=(field:JsonField):DriverValueDecoder<unknown,unknown>|Column|null=>{
 if(is(field,Column))return field;
 const decoder=(expression(field) as unknown as {decoder?:DriverValueDecoder<unknown,unknown>}).decoder;
 return decoder&&typeof decoder.mapFromDriverValue==='function'?decoder:null;
};

/** `jsonb_build_object('<key>', <field>, …)` in the field map's own keys (fifty pairs per call, concatenated). */
export function jsonFieldsSql(fields:JsonFieldMap):SQL{
 const parts=Object.entries(fields).map(([key,field])=>{
  if(!SAFE_KEY.test(key))throw new Error('Unsafe field name in a bundled read.');
  const name=sql.raw(`'${key}'`),value=is(field,Column)?sql`${field}`:sql`(${expression(field)})`;
  const column=decoderOf(field);
  return column&&is(column,Column)&&!jsonFaithful(column)?sql`${name},${value}::text`:sql`${name},${value}`;
 });
 const chunks:SQL[]=[];
 for(let index=0;index<parts.length;index+=50)chunks.push(sql`jsonb_build_object(${sql.join(parts.slice(index,index+50),sql`,`)})`);
 return chunks.length?sql.join(chunks,sql` || `):sql`'{}'::jsonb`;
}

/** One row of `jsonFieldsSql(fields)`, as the select over `fields` returns it. */
export function decodeJsonFields<F extends JsonFieldMap>(fields:F,json:Record<string,unknown>):Decoded<F>{
 const out:Record<string,unknown>={};
 for(const [key,field] of Object.entries(fields)){
  if(!(key in json))throw new Error(`Bundled field ${key} is missing.`);
  const value=json[key],decoder=decoderOf(field);
  if(value===null||!decoder){out[key]=value;continue;}
  // A timestamp's JSON form uses 'T'; its driver text never does. Any other non-faithful value must be text.
  if(is(decoder,Column)&&!jsonFaithful(decoder)&&(typeof value!=='string'||(/^PgTimestamp/.test(decoder.columnType)&&value.includes('T'))))
   throw new Error(`Bundled field ${key} did not arrive as driver text.`);
  // Drizzle maps every field's driver value through its decoder, faithful or not (a date-mode date, a custom type).
  out[key]=decoder.mapFromDriverValue(value);
 }
 return out as Decoded<F>;
}

/** Rows as one jsonb array in the statement's own order and page: `(select … where … order by … limit n)`.
 * `order` is the owner's ORDER BY; the aggregate keeps that order through the row number it assigns. */
export function jsonRowsSql(p:Readonly<{row:SQL;from:SQL;where?:SQL;order?:SQL;limit?:number}>):SQL{
 const where=p.where?sql` where ${p.where}`:sql``;
 if(!p.order)return sql`(select coalesce(jsonb_agg(${p.row}),'[]'::jsonb) from ${p.from}${where})`;
 return sql`(select coalesce(jsonb_agg(bundle_page.bundle_row order by bundle_page.bundle_ord),'[]'::jsonb) from (select ${p.row} as bundle_row,
  row_number() over (order by ${p.order}) as bundle_ord from ${p.from}${where} order by ${p.order}${p.limit===undefined?sql``:sql` limit ${p.limit}`}) bundle_page)`;
}
/** A bundled array of `jsonFieldsSql(fields)` rows, decoded. */
export function decodeJsonFieldRows<F extends JsonFieldMap>(fields:F,value:unknown):Decoded<F>[]{
 if(!Array.isArray(value))throw new Error('A bundled section is not a row array.');
 return value.map(row=>decodeJsonFields(fields,row as Record<string,unknown>));
}
