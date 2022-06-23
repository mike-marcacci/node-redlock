import Redlock from "./redlock.ts";
import Lock from "./lock.ts";
import { ACQUIRE_SCRIPT, EXTEND_SCRIPT, RELEASE_SCRIPT } from './scripts.ts';
import { ClientExecutionResult, ExecutionStats, ExecutionResult } from './types.ts';

export default Redlock;
export { Lock, ACQUIRE_SCRIPT, EXTEND_SCRIPT, RELEASE_SCRIPT };
export type { ClientExecutionResult, ExecutionStats, ExecutionResult };