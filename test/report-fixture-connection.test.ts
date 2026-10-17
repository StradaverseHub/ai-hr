import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {client} from '../db/client';
import {owner,migrateTestDb,closeAll} from './harness';
import {readReportFixtureConnections,assertReportFixtureConnections} from '../scripts/report-fixture-connection.mjs';
beforeAll(migrateTestDb);afterAll(closeAll);
describe('actual Reports fixture loopback endpoint proof',()=>{
 it('accepts actual PostgreSQL host addresses while inet text retains its network prefix',async()=>{
  const actual=await readReportFixtureConnections(client,owner.client);
  const [raw]=await client`select inet_server_addr()::text as cidr,current_database() as database`;
  expect(raw.cidr).toMatch(/\/(32|128)$/);
  expect(actual.application.server_addr).toMatch(/^(127\.0\.0\.1|::1)$/);
  expect(actual.migration.server_addr).toBe(actual.application.server_addr);
  expect(()=>assertReportFixtureConnections(actual,{database:raw.database,ownerName:decodeURIComponent(new URL(process.env.TEST_MIGRATION_DATABASE_URL!).username)})).not.toThrow();
 });
 it('continues to refuse remote addresses, mismatched databases/ports/OIDs and privileged app roles',async()=>{
  const actual=await readReportFixtureConnections(client,owner.client),expected={database:actual.application.database,ownerName:actual.migration.name};
  for(const patch of [{server_addr:'192.0.2.1'},{server_addr:'127.0.0.1/32'},{server_port:5432},{database:'other'},{rolsuper:true},{rolbypassrls:true}])expect(()=>assertReportFixtureConnections({...actual,application:{...actual.application,...patch}},expected)).toThrow();
  expect(()=>assertReportFixtureConnections({...actual,migration:{...actual.migration,database_oid:'0'}},expected)).toThrow();
 });
});
