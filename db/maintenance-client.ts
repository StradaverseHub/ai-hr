/** Dedicated operator custody connection. No application singleton, tenant impersonation or shared pool. */
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';

export function createMaintenanceDb(connectionString:string) {
  if(!connectionString.trim())throw new Error('AI retention maintenance could not be confirmed.');
  // Postgres.js timeout options are seconds. This factory never opens a connection merely by import;
  // its sole consumer owns one transaction and always closes the dedicated pool in its finally block.
  const client=postgres(connectionString,{max:1,connect_timeout:5,idle_timeout:5,max_lifetime:60});
  return {db:drizzle(client),close:()=>client.end({timeout:5})};
}

/** Structural input also accepts a test-owner database without taking ownership of its pool. */
export type MaintenanceDatabase=Pick<ReturnType<typeof createMaintenanceDb>,'db'>;
