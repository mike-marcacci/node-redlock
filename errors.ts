import { ExecutionStats } from './types.ts';

/*
 * This error indicates a failure due to the existence of another lock for one
 * or more of the requested resources.
 */
export class ResourceLockedError extends Error {
    constructor(public readonly message: string) {
      super();
      this.name = "ResourceLockedError";
    }
  }
  
  /*
   * This error indicates a failure of an operation to pass with a quorum.
   */
  export class ExecutionError extends Error {
    constructor(
      public readonly message: string,
      public readonly attempts: ReadonlyArray<Promise<ExecutionStats>>
    ) {
      super();
      this.name = "ExecutionError";
    }
  }