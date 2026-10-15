import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {TENANT_STATUS_GOOD_STANDING} from '../core/entitlement-types';
it('keeps the private SQL delivery standing mirror identical to the canonical write boundary',()=>{
 const sql=readFileSync(new URL('../db/migrations/0549_employee_master_delivery.sql',import.meta.url),'utf8');
 const match=sql.match(/CREATE FUNCTION identity_email\.report_tenant_available[\s\S]*?t\.status IN \(([^)]+)\)/);
 expect(match).not.toBeNull();
 const statuses=[...match![1].matchAll(/'([^']+)'/g)].map(value=>value[1]);
 expect(new Set(statuses)).toEqual(TENANT_STATUS_GOOD_STANDING);
});
