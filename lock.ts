import { ExecutionStats, ExecutionResult } from './types.ts'
import Redlock from './redlock.ts'

/*
 * An object of this type is returned when a resource is successfully locked. It
 * contains convenience methods `release` and `extend` which perform the
 * associated Redlock method on itself.
 */
export default class Lock {
    constructor(
      public readonly redlock: Redlock,
      public readonly resources: string[],
      public readonly value: string,
      public readonly attempts: ReadonlyArray<Promise<ExecutionStats>>,
      public expiration: number
    ) {}

    async release(): Promise<ExecutionResult> {
      return await this.redlock.release(this);
    }

    async extend(duration: number): Promise<Lock> {
      return await this.redlock.extend(this, duration);
    }
  }