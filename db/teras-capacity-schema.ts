/** AI v2 Phase 2, P2-4 — the Drizzle declaration of the HR capacity ledger's baseline (migration 0966).
 *
 * WHY NOT db/teras-schema.ts. That file is inside the approved provider-data source closure
 * (scripts/ai-provider-data-source-manifest.mjs), so any edit there changes the approved digest. This table is part of no
 * provider request: it is declared here and imported only by core/capacity/* and tests (the db/teras-chat-schema.ts
 * precedent). Fold into db/schema.ts when the next approval of that closure is taken.
 *
 * Append-only: a new baseline is a new row with the next version; the database refuses an update or a delete. */
import {date,integer,jsonb,numeric,pgTable,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,tenant} from './schema';
import type {CapacityBaselineItems} from '../core/capacity/types';

export const terasCapacityBaseline=pgTable('teras_capacity_baseline',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:uuid('tenant_id').notNull().references(()=>tenant.id),
 companyId:uuid('company_id').notNull().references(()=>company.id),version:integer('version').notNull(),
 periodFrom:date('period_from').notNull(),periodTo:date('period_to').notNull(),
 minutesPerStaffAction:numeric('minutes_per_staff_action',{precision:6,scale:1}),
 items:jsonb('items').$type<CapacityBaselineItems>().notNull(),
 setByUserId:uuid('set_by_user_id').notNull().references(()=>appUser.id),setAt:timestamp('set_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('teras_capacity_baseline_tenant_id_company_id_version_key').on(t.tenantId,t.companyId,t.version)]);
