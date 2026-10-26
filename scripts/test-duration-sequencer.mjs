/** Opt-in scheduling; inherit Vitest's exact sharding behavior. */
import {BaseSequencer} from 'vitest/node';
import {orderTestSpecifications} from './test-duration-order.mjs';
export default class DurationSequencer extends BaseSequencer{
 async sort(files){
  return orderTestSpecifications(files,{root:this.ctx.config.root,getFileTestResults:key=>this.ctx.cache.getFileTestResults(key)});
 }
}
