import { EventEmitter, Client, randomBytes, RedisValue } from './deps.ts';
import { ACQUIRE_SCRIPT, EXTEND_SCRIPT, RELEASE_SCRIPT } from './scripts.ts';
import { ClientExecutionResult, ExecutionStats, ExecutionResult, Settings, RedlockAbortSignal, } from './types.ts';
import { ResourceLockedError, ExecutionError } from './errors.ts'
import Lock from './lock.ts';
import { SHA1 } from './crypto.ts';

// Define default settings.
const defaultSettings: Readonly<Settings> = {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 100,
  automaticExtensionThreshold: 500,
};

// Modifyng this object is forbidden.
Object.freeze(defaultSettings);

/**
 * A redlock object is instantiated with an array of at least one redis client
 * and an optional `options` object. Properties of the Redlock object should NOT
 * be changed after it is first used, as doing so could have unintended
 * consequences for live locks.
 */
export default class Redlock extends EventEmitter {
  public readonly clients: Set<Client>;
  public readonly settings: Settings;
  public readonly scripts: {
    readonly acquireScript: { value: string; hash: string };
    readonly extendScript: { value: string; hash: string };
    readonly releaseScript: { value: string; hash: string };
  };

  public constructor(
    clients: Iterable<Client>,
    settings: Partial<Settings> = {},
    scripts: {
      readonly acquireScript?: string | ((script: string) => string);
      readonly extendScript?: string | ((script: string) => string);
      readonly releaseScript?: string | ((script: string) => string);
    } = {}
  ) {
    super();

    // Prevent crashes on error events.
    this.on("error", () => {
      // Because redlock is designed for high availability, it does not care if
      // a minority of redis instances/clusters fail at an operation.
      //
      // However, it can be helpful to monitor and log such cases. Redlock emits
      // an "error" event whenever it encounters an error, even if the error is
      // ignored in its normal operation.
      //
      // This function serves to prevent Deno's default behavior of crashing
      // when an "error" event is emitted in the absence of listeners.
    });

    // Customize the settings for this instance. Use default settings or user provided settings
    this.settings = {
      driftFactor:
        typeof settings.driftFactor === "number"
          ? settings.driftFactor
          : defaultSettings.driftFactor,
      retryCount:
        typeof settings.retryCount === "number"
          ? settings.retryCount
          : defaultSettings.retryCount,
      retryDelay:
        typeof settings.retryDelay === "number"
          ? settings.retryDelay
          : defaultSettings.retryDelay,
      retryJitter:
        typeof settings.retryJitter === "number"
          ? settings.retryJitter
          : defaultSettings.retryJitter,
      automaticExtensionThreshold:
        typeof settings.automaticExtensionThreshold === "number"
          ? settings.automaticExtensionThreshold
          : defaultSettings.automaticExtensionThreshold,
    };

    // Use custom scripts and script modifiers.
    const acquireScript =
      typeof scripts.acquireScript === "function"
        ? scripts.acquireScript(ACQUIRE_SCRIPT)
        : ACQUIRE_SCRIPT;
    const extendScript =
      typeof scripts.extendScript === "function"
        ? scripts.extendScript(EXTEND_SCRIPT)
        : EXTEND_SCRIPT;
    const releaseScript =
      typeof scripts.releaseScript === "function"
        ? scripts.releaseScript(RELEASE_SCRIPT)
        : RELEASE_SCRIPT;

    /**
     * Script value will be used in initial EVAL call to Redis nodes
     * Hash will be used in subsequent EVALSHA calls to nodes
     */
    this.scripts = {
      acquireScript: {
        value: acquireScript,
        hash: SHA1(acquireScript),
      },
      extendScript: {
        value: extendScript,
        hash: SHA1(extendScript),
      },
      releaseScript: {
        value: releaseScript,
        hash: SHA1(releaseScript),
      },
    };

    this.clients = new Set(clients);
    if (this.clients.size === 0) {
      throw new Error(
        "Redlock must be instantiated with at least one Redis client."
      );
    }
  }

  /**
   * Generate a cryptographically random string which will be lock value
   */
  private _random(): string {
    return randomBytes(16).toString("hex");
  }

  /**
   * This method runs `.quit()` on all client connections.
   */
   public async quit(): Promise<void> {
    const results = [];
    for (const client of this.clients) {
      results.push(client.quit());
    }
    await Promise.all(results);
  }

  /**
   * This method acquires locks on the specified resources
   * for the duration specified by the `duration` setting
   */
   public async acquire(
    resources: string[],
    duration: number,
    settings?: Partial<Settings>
  ): Promise<Lock> {
    if (Math.floor(duration) !== duration) {
      throw new Error("Duration must be an integer value in milliseconds.");
    }
    const start = performance.now();
    const value = this._random();

    try {
      const { attempts } = await this._execute(
        this.scripts.acquireScript,
        resources,
        [value, duration],
        settings
      );

      // Add 2 milliseconds to the drift to account for Redis expires precision,
      // which is 1 ms, plus the configured allowable drift factor.
      const drift =
        Math.round(
          (settings?.driftFactor ?? this.settings.driftFactor) * duration
        ) + 2;

      return new Lock(
        this,
        resources,
        value,
        attempts,
        start + duration - drift
      )
    } catch (error) {
      // If there was an error acquiring the lock, release any partial lock
      // state that may exist on a minority of clients.
      await this._execute(this.scripts.releaseScript, resources, [value], {
        retryCount: 0,
      }).catch(() => {
        // Any error here will be ignored.
      });

      throw error;
    }
  }
  /**
 * This method unlocks the provided lock from all servers still persisting it.
 * It will fail with an error if it is unable to release the lock on a quorum
 * of nodes, but will make no attempt to restore the lock in the case of a
 * failure to release. It is safe to re-attempt a release or to ignore the
 * error, as the lock will automatically expire after its timeout.
 */
  public release(
    lock: Lock,
    settings?: Partial<Settings>
  ): Promise<ExecutionResult> {
    // Immediately invalidate the lock.
    lock.expiration = 0;

    // Attempt to release the lock.
    return this._execute(
      this.scripts.releaseScript,
      lock.resources,
      [lock.value],
      settings
    );
  }

  /**
   * This method extends a valid lock by the provided `duration`.
   */
  public async extend(
    existing: Lock,
    duration: number,
    settings?: Partial<Settings>
  ): Promise<Lock> {
    if (Math.floor(duration) !== duration) {
      throw new Error("Duration must be an integer value in milliseconds.");
    }
    const start = performance.now();

    // The lock has already expired.
    if (existing.expiration < performance.now()) {
      throw new ExecutionError("Cannot extend an already-expired lock.", []);
    }

    const { attempts } = await this._execute(
      this.scripts.extendScript,
      existing.resources,
      [existing.value, duration],
      settings
    );

    // Invalidate the existing lock.
    existing.expiration = 0;

    // Add 2 milliseconds to the drift to account for Redis expires precision,
    // which is 1 ms, plus the configured allowable drift factor.
    const drift =
      Math.round(
        (settings?.driftFactor ?? this.settings.driftFactor) * duration
      ) + 2;

    const replacement = new Lock(
      this,
      existing.resources,
      existing.value,
      attempts,
      start + duration - drift
    );
    return replacement;
  }

  /*
 * This method returns a summary of results. Because the result of an attempt
 * can sometimes be determined before all requests are finished, each attempt
 * contains a Promise that will resolve ExecutionStats once all requests are
 * finished. A rejection of these promises should be considered undefined
 * behavior and should cause a crash.
 */
  private async _execute(
    script: { value: string; hash: string },
    keys: string[],
    args: RedisValue[],
    _settings?: Partial<Settings>
  ): Promise<ExecutionResult> {
    const settings = _settings
      ? {
          ...this.settings,
          ..._settings,
        }
      : this.settings;

    // For the purpose of easy config serialization, we treat a retryCount of
    // -1 as equivalent to Infinity.
    const maxAttempts =
      settings.retryCount === -1 ? Infinity : settings.retryCount + 1;

    const attempts: Promise<ExecutionStats>[] = [];
    while (true) {
      const { vote, stats } = await this._attemptOperation(script, keys, args);
      attempts.push(stats);

      // The operation achieved a quorum in favor.
      if (vote === "for") {
        return { attempts };
      }

      // Wait before reattempting.
      if (attempts.length < maxAttempts) {
        await new Promise((resolve) => {
          setTimeout(
            resolve,
            Math.max(
              0,
              settings.retryDelay +
                Math.floor((Math.random() * 2 - 1) * settings.retryJitter)
            ),
            undefined
          );
        });
      } else {
        throw new ExecutionError(
          "The operation was unable to achieve a quorum during its retry window.",
          attempts
        );
      }
    }
  }

  private async _attemptOperation(
    script: { value: string; hash: string },
    keys: string[],
    args: RedisValue[],
  ): Promise<
    | { vote: "for"; stats: Promise<ExecutionStats> }
    | { vote: "against"; stats: Promise<ExecutionStats> }
  > {
    return await new Promise((resolve) => {
      const clientResults: Promise<ClientExecutionResult>[] = [];
      for (const client of this.clients) {
        clientResults.push(   
          this._attemptOperationOnClient(client, script, keys, args)
        );
      }

      // This object contains a summary of results.
      const stats: ExecutionStats = {
        membershipSize: clientResults.length,
        quorumSize: Math.floor(clientResults.length / 2) + 1,
        votesFor: new Set<Client>(),
        votesAgainst: new Map<Client, Error>(),
      };

      let done: () => void;
      const statsPromise = new Promise<ExecutionStats>((resolve) => {
        done = () => resolve(stats);
      });

      // This is the expected flow for all successful and unsuccessful requests.
      const onResultResolve = (clientResult: ClientExecutionResult): void => {
        switch (clientResult.vote) {
          case "for":
            stats.votesFor.add(clientResult.client);
            break;
          case "against":
            stats.votesAgainst.set(clientResult.client, clientResult.error);
            break;
        }
        // A quorum has determined a success.
        if (stats.votesFor.size === stats.quorumSize) {
          resolve({
            vote: "for",
            stats: statsPromise,
          });
        }
        // A quorum has determined a failure.
        if (stats.votesAgainst.size === stats.quorumSize) {
          resolve({
            vote: "against",
            stats: statsPromise,
          });
        }
        // All votes are in.
        if (
          stats.votesFor.size + stats.votesAgainst.size ===
          stats.membershipSize
        ) {
          done();
        }
      };
      // This is unexpected and should crash to prevent undefined behavior.
      const onResultReject = (error: Error): void => {
        throw error;
      };

      for (const result of clientResults) {
        result.then(onResultResolve, onResultReject);
      }
    });
  }

  private async _attemptOperationOnClient(
    client: Client,
    script: { value: string; hash: string },
    keys: string[],
    args: RedisValue[]
  ): Promise<ClientExecutionResult> {
    try {
      let result: number;
      try {
        const shaResult = await client.evalsha(script.hash, keys, args) as unknown;

        if (typeof shaResult !== "number") {
          throw new Error(
            `Unexpected result of type ${typeof shaResult} returned from redis.`
          );
        }

        result = shaResult;
      } catch (error) {
        // If the redis server does not already have the script cached,
        // reattempt the request with the script's raw text.
        if (
          !(error instanceof Error) ||
          !error.message.startsWith("-NOSCRIPT")
        ) {
          throw error;
        }
        const rawResult = (await client.eval(script.value, keys, args)) as unknown;

        if (typeof rawResult !== "number") {
          throw new Error(
            `Unexpected result of type ${typeof rawResult} returned from redis.`
          );
        }

        result = rawResult;
      }

      // One or more of the resources was already locked.
      if (result !== keys.length) {
        throw new ResourceLockedError(
          `The operation was applied to: ${result} of the ${keys.length} requested resources.`
        );
      }

      return {
        vote: "for",
        client,
        value: result,
      };
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error(
          `Unexpected type ${typeof error} thrown with value: ${error}`
        );
      }
      // Emit the error on the redlock instance for observability.
      this.emit("error", error);
      return {
        vote: "against",
        client,
        error,
      };
    }
  }

  /**
   * 
   * @param resources the redis client ID
   * @param duration 
   * @param settings optional settings
   * @param routine the callback function which uses/manipulates information on the redis client while lock is in place
   */
   public async using<T>(
    resources: string[],
    duration: number,
    settings: Partial<Settings>,
    routine?: (signal: RedlockAbortSignal) => Promise<T>
  ): Promise<T>;

  public async using<T>(
    resources: string[],
    duration: number,
    routine: (signal: RedlockAbortSignal) => Promise<T>
  ): Promise<T>;

  public async using<T>(
    resources: string[],
    duration: number,
    settingsOrRoutine:
      | undefined
      | Partial<Settings>
      | ((signal: RedlockAbortSignal) => Promise<T>),
    optionalRoutine?: (signal: RedlockAbortSignal) => Promise<T>
  ): Promise<T> {

    if (Math.floor(duration) !== duration) {
      throw new Error("Duration must be an integer value in milliseconds.");
    }
    const settings =
      settingsOrRoutine && typeof settingsOrRoutine !== "function"
        ? {
            ...this.settings,
            ...settingsOrRoutine,
          }
        : this.settings;

    const routine = optionalRoutine ?? settingsOrRoutine;
    if (typeof routine !== "function") {
      throw new Error("INVARIANT: routine is not a function.");
    }

    if (settings.automaticExtensionThreshold > duration - 100) {
      throw new Error(
        "A lock `duration` must be at least 100ms greater than the `automaticExtensionThreshold` setting."
      );
    }

    // The AbortController/AbortSignal pattern allows the routine to be notified
    // of a failure to extend the lock, and subsequent expiration. In the event
    // of an abort, the error object will be made available at `signal.error`.
    const controller = new AbortController();

    const signal = controller.signal as RedlockAbortSignal;

    function queue(): void {
      timeout = setTimeout(
        () => (extension = extend()),
        lock.expiration - performance.now() - settings.automaticExtensionThreshold
      );
    }

    async function extend(): Promise<void> {
      timeout = undefined;
      try {
        lock = await lock.extend(duration);
        queue();
      } catch (error) {
        if (!(error instanceof Error)) {
          throw new Error(`Unexpected thrown ${typeof error}: ${error}.`);
        }

        if (lock.expiration > performance.now()) {
          return (extension = extend());
        }

        signal.error = error instanceof Error ? error : new Error(`${error}`);
        controller.abort();
      }
    }

    let timeout: undefined | number;
    let extension: undefined | Promise<void>;
    let lock = await this.acquire(resources, duration, settings);
    queue();

    try {
      return await routine(signal);
    } finally {
      // Clean up the timer.
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      // Wait for an in-flight extension to finish.
      if (extension) {
        await extension.catch(() => {
          // An error here doesn't matter at all, because the routine has
          // already completed, and a release will be attempted regardless. The
          // only reason for waiting here is to prevent possible contention
          // between the extension and release.
        });
      }
      await lock.release();
    }
  }
}
