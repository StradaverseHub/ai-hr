/** Actual read-only endpoint proof. host(inet) returns the address without PostgreSQL's CIDR suffix. */
export async function readReportFixtureConnections(app,owner){
 const [application]=await app`select current_user as name,current_database() as database,host(inet_server_addr()) as server_addr,inet_server_port() as server_port,(select oid::text from pg_database where datname=current_database()) as database_oid,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
 const [migration]=await owner`select current_user as name,current_database() as database,host(inet_server_addr()) as server_addr,inet_server_port() as server_port,(select oid::text from pg_database where datname=current_database()) as database_oid`;
 return {application,migration};
}
export function assertReportFixtureConnections({application:app,migration:owner},{database,ownerName}){
 if(app?.name!=='ai_hr_app'||app.rolsuper||app.rolbypassrls||app.database!==database||owner?.database!==database||owner.name!==ownerName||!['127.0.0.1','::1'].includes(app.server_addr)||app.server_port!==5433||owner.server_addr!==app.server_addr||owner.server_port!==app.server_port||owner.database_oid!==app.database_oid)throw new Error('Actual Reports role/database proof refused.');
}
