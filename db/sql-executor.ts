import {type Assume,type SQLWrapper} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type postgres from 'postgres';

/** The statement-only interface shared by app transactions and kernel-fenced owner transactions. */
export type SqlExecutor={
 execute<Row extends Record<string,unknown>=Record<string,unknown>>(statement:SQLWrapper|string):PromiseLike<postgres.RowList<Assume<Row,postgres.Row>[]>>;
};
const dialect=new PgDialect();
/** Uses the caller's reserved connection and transaction. Does not acquire a connection or establish authority. */
export function reservedSqlExecutor(connection:postgres.ReservedSql):SqlExecutor{
 return {execute<Row extends Record<string,unknown>=Record<string,unknown>>(statement:SQLWrapper|string){
  const query=typeof statement==='string'?{sql:statement,params:[]}:dialect.sqlToQuery(statement.getSQL());
  // PgDialect emits driver parameters; its generic query interface erases their serializer types.
  return connection.unsafe<Assume<Row,postgres.Row>[]>(query.sql,query.params as postgres.ParameterOrJSON<never>[]);
 }};
}
