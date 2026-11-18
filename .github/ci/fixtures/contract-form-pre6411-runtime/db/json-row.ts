/** Rows carried inside one bundled JSON statement, decoded exactly as the driver would have returned them.
 *
 * `to_jsonb` and `jsonb_build_object` keep text, uuid, enum, boolean, integer, date, time, json and their arrays in
 * the form the driver hands to Drizzle. Every other column (numeric, bigint, timestamp, interval and anything
 * custom) is sent as its `::text` output instead, which is byte-for-byte what the driver receives for it, so the
 * column's own `mapFromDriverValue` produces the identical value. A column that arrives in the wrong form fails
 * closed rather than decoding to a nearby value. */
import {getTableColumns,getTableName,is,sql,type Column,type SQL,type Table} from 'drizzle-orm';
import {PgArray} from 'drizzle-orm/pg-core';

const JSON_FAITHFUL=new Set(['PgText','PgVarchar','PgChar','PgUUID','PgEnumColumn','PgEnumObjectColumn','PgBoolean','PgInteger',
 'PgSmallInt','PgSerial','PgSmallSerial','PgDoublePrecision','PgReal','PgDateString','PgDate','PgTime','PgJson','PgJsonb']);
/** Whether the JSON form of this column already equals its driver form. */
export function jsonFaithful(column:Column):boolean{
 if(is(column,PgArray))return jsonFaithful((column as unknown as {baseColumn:Column}).baseColumn);
 return JSON_FAITHFUL.has(column.columnType);
}
const SAFE_NAME=/^[a-z_][a-z0-9_]*$/;
const literal=(name:string)=>{if(!SAFE_NAME.test(name))throw new Error('Unsafe column name in a bundled read.');return sql.raw(`'${name}'`);};
/** `alias.column`, for statements that read one table under several aliases. */
export const columnRefSql=(alias:string,column:Column)=>sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
const pairs=(alias:string,columns:readonly Column[])=>columns.map(column=>jsonFaithful(column)
 ?sql`${literal(column.name)},${columnRefSql(alias,column)}`:sql`${literal(column.name)},${columnRefSql(alias,column)}::text`);
/** jsonb_build_object accepts at most fifty pairs, so longer lists are concatenated. */
function buildObject(parts:SQL[]):SQL{
 const chunks:SQL[]=[];
 for(let index=0;index<parts.length;index+=50)chunks.push(sql`jsonb_build_object(${sql.join(parts.slice(index,index+50),sql`,`)})`);
 return chunks.length?sql.join(chunks,sql` || `):sql`'{}'::jsonb`;
}
/** The named columns of `alias`, keyed by database column name. */
export function jsonColumnsSql(alias:string,columns:readonly Column[]):SQL{return buildObject(pairs(alias,columns));}
/** Every column of `alias` (a row of `table`), keyed by database column name. */
export function jsonRowSql(table:Table,alias:string):SQL{
 const textual=Object.values(getTableColumns(table)).filter(column=>!jsonFaithful(column));
 return textual.length?sql`(to_jsonb(${sql.identifier(alias)}) || ${buildObject(pairs(alias,textual))})`:sql`to_jsonb(${sql.identifier(alias)})`;
}
/** The columns of `table` that `jsonRowSql` must send as text, by database name (for hand-written SQL functions). */
export function textColumnNames(table:Table):string[]{
 return Object.values(getTableColumns(table)).filter(column=>!jsonFaithful(column)).map(column=>column.name);
}

function driverValue(column:Column,value:unknown){
 if(value===null)return null;
 // A timestamp's JSON form uses 'T'; its driver text never does. Any other non-faithful column must be text.
 if(!jsonFaithful(column)&&(typeof value!=='string'||(/^PgTimestamp/.test(column.columnType)&&value.includes('T'))))
  throw new Error(`Bundled ${getTableName(column.table)}.${column.name} did not arrive as driver text.`);
 return column.mapFromDriverValue(value);
}
const tsKeys=new WeakMap<Table,Map<Column,string>>();
function keyOf(column:Column){
 let keys=tsKeys.get(column.table);
 if(!keys){keys=new Map(Object.entries(getTableColumns(column.table)).map(([key,value])=>[value as Column,key]));tsKeys.set(column.table,keys);}
 const key=keys.get(column);
 if(!key)throw new Error('Unknown column in a bundled read.');
 return key;
}
/** Decode the named columns (or all of `table`) into an object keyed like Drizzle's own select result. */
export function decodeJsonColumns(columns:readonly Column[],json:Record<string,unknown>):Record<string,unknown>{
 const out:Record<string,unknown>={};
 for(const column of columns){
  if(!(column.name in json))throw new Error(`Bundled ${getTableName(column.table)}.${column.name} is missing.`);
  out[keyOf(column)]=driverValue(column,json[column.name]);
 }
 return out;
}
export function decodeJsonRow<T extends Table>(table:T,json:Record<string,unknown>):T['$inferSelect']{
 return decodeJsonColumns(Object.values(getTableColumns(table)),json) as T['$inferSelect'];
}

/** A decoded row per source table, for projecting a Drizzle field map exactly as that select would return it. */
export type JsonRowSources=ReadonlyMap<Table,Record<string,unknown>|null|undefined>;
/** Drizzle's select of `fields` over the given (inner-joined) rows: undefined when a joined row is absent. */
export function projectFields<F extends Record<string,Column>>(fields:F,sources:JsonRowSources):{[K in keyof F]:F[K]['_']['data']|null}|undefined{
 const out:Record<string,unknown>={};
 for(const [name,column] of Object.entries(fields)){
  const row=sources.get(column.table);
  if(row==null)return undefined;
  const key=keyOf(column);
  if(!(key in row))throw new Error(`Bundled ${getTableName(column.table)}.${column.name} was not loaded.`);
  out[name]=row[key];
 }
 return out as {[K in keyof F]:F[K]['_']['data']|null};
}
