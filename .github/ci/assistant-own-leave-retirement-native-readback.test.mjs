/** Authored UNRUN import/closed-boundary source tests only, NOT native database evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAiDeliveryOwnLeaveRetirementNativeReadback} from './assistant-own-leave-retirement-native-readback.mjs';
test('invalid source root/fixture cannot load application modules or acquire an owner',async()=>{
 for(const input of [{},{root:'relative',owner:{client:{}}},{root:'/fictional/root',owner:{client:{}},fixture:{state:'not-prepared'}},{root:'/fictional/root',owner:{client:{}},fixture:{state:'native_prerequisites_prepared_not_experienced',limits:{uiTargetEffects:'not_executed'}}}])await assert.rejects(createAiDeliveryOwnLeaveRetirementNativeReadback(input));
});
test('readback is readonly, current-principal/canonical-custody owned and never decrypts or changes native data',()=>{
 const source=readFileSync(new URL('./assistant-own-leave-retirement-native-readback.mjs',import.meta.url),'utf8');
 for(const prohibited of ['createDb(','client.end(','owner.client.end(','JSON.parse(p.review','unsealOwnLeave','ciphertext as','wrapped_dek as','UPDATE app.','DELETE FROM','INSERT INTO','TRUNCATE ','process.env.DATABASE_URL=','fetch('])assert(!source.includes(prohibited));
 for(const required of ['read committed read only','SET TRANSACTION READ ONLY','app.principal(','readOwnLeaveActorTx','listOwnLeaveReviewsTx','assistant_own_leave_review_content','bodyCount','pairedRefsPresent','boundNativeOutcomeTransactionTx','current_database()','rolsuper or rolbypassrls','same(p.expected,expected)'])assert(source.includes(required));
 assert(source.includes("phases=['baseline','prepared','discarded','reopened','reopened_again']"));
});
