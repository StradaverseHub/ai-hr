/** Fixed existing native benchmark entry. The shared owner admits its exact
 * real lifecycle profile before any hooks, constructors or SQL. */
import {registerEmployeeChoiceBenchmark} from './performance/employee-choice-benchmark-harness';
registerEmployeeChoiceBenchmark('exact-ascii');
