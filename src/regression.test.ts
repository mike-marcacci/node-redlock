import test from "ava";
import type { Redis as Client } from "ioredis";
import Redlock, { ExecutionError, Lock } from "./index.js";
import type { RedlockAbortSignal, Settings } from "./index.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface KeyEntry {
  value: string;
  expiresAt: number;
}

// --- Script discriminators ---
//
// Pitfall: The fixed ACQUIRE_SCRIPT **also contains** `redis.call("get", key) ~= ARGV[1]`
// (it now checks whether the key blocking us is our own). Any interceptor that identifies
// EXTEND solely using that string will falsely identify ACQUIRE as an extension, allowing
// tests to pass when **no extension ever occurred**.
// Only `redis.call("exists"` is unique to ACQUIRE, and exists both before and after the fix—
// allowing the same mock to work for both versions so red-green comparisons remain meaningful.
const ACQUIRE_MARKER = 'redis.call("exists"';
const EXTEND_MARKER = 'redis.call("get", key) ~= ARGV[1]';
const RELEASE_MARKER = 'redis.pcall("del"';

const isAcquireScript = (script: string): boolean =>
  script.includes(ACQUIRE_MARKER);
const isExtendScript = (script: string): boolean =>
  script.includes(EXTEND_MARKER) && !script.includes(ACQUIRE_MARKER);
const isReleaseScript = (script: string): boolean =>
  script.includes(RELEASE_MARKER);

interface AcquireObservation {
  granted: boolean;
  blocker: string | null;
  /** The key that blocked us carried our *own* value (the F2 defect). */
  selfBlocked: boolean;
  /** We were granted while one of the keys already held our own value. */
  reacquiredOwn: boolean;
}

class MockRedisClient {
  public store = new Map<string, KeyEntry>();
  public delayMs = 0;
  public failExtend = false;
  public failRelease = false;
  public acquireLog: AcquireObservation[] = [];

  private _entry(key: string): KeyEntry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  public get(key: string): string | null {
    const e = this._entry(key);
    return e ? e.value : null;
  }

  public set(key: string, value: string, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  public evalsha(): Promise<number> {
    throw new Error("NOSCRIPT No matching script.");
  }

  public async eval(
    script: string,
    numKeys: number,
    args: (string | number)[]
  ): Promise<number> {
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);

    if (isAcquireScript(script)) {
      const lockValue = argv[0];
      const ttl = Number(argv[1]);

      // The blocking condition is determined by the script text: before the fix,
      // it only checks exists (blocking even on identical values, i.e., self-blocking);
      // after the fix, it blocks only if the value differs. Hardcoding either behavior
      // would make the mock faithful to only one version of src, defeating the purpose
      // of red-green comparisons.
      const valueAware = script.includes(EXTEND_MARKER);
      let reacquiredOwn = false;

      for (const key of keys) {
        const e = this._entry(key);
        if (!e) continue;
        if (valueAware && e.value === lockValue) {
          reacquiredOwn = true;
          continue;
        }
        this.acquireLog.push({
          granted: false,
          blocker: e.value,
          selfBlocked: e.value === lockValue,
          reacquiredOwn: false,
        });
        return 0;
      }

      for (const key of keys) {
        this.set(key, lockValue, ttl);
      }
      this.acquireLog.push({
        granted: true,
        blocker: null,
        selfBlocked: false,
        reacquiredOwn,
      });
      return keys.length;
    }

    if (isExtendScript(script)) {
      if (this.failExtend) {
        return 0;
      }
      const lockValue = argv[0];
      const ttl = Number(argv[1]);

      for (const key of keys) {
        const e = this._entry(key);
        if (!e || e.value !== lockValue) {
          return 0;
        }
      }

      for (const key of keys) {
        this.set(key, lockValue, ttl);
      }
      return keys.length;
    }

    if (isReleaseScript(script)) {
      if (this.failRelease) {
        return 0;
      }
      const lockValue = argv[0];
      let deleted = 0;
      for (const key of keys) {
        const e = this._entry(key);
        if (e && e.value === lockValue) {
          this.store.delete(key);
          deleted++;
        }
      }
      return deleted;
    }

    throw new Error("Unknown script in mock");
  }
}

function makeClients(n: number): MockRedisClient[] {
  return Array.from({ length: n }, () => new MockRedisClient());
}

test("F1 fix: acquire() throws ExecutionError when round-trip takes longer than validity", async (t) => {
  const clients = makeClients(3);
  for (const c of clients) {
    c.delayMs = 100;
  }

  const redlock = new Redlock(clients as unknown as Client[]);
  const duration = 50; // duration 50ms, delay 100ms -> validity < 0

  await t.throwsAsync(
    async () => {
      await redlock.acquire(["test-resource"], duration);
    },
    {
      instanceOf: ExecutionError,
      message:
        /The lock validity time has elapsed before quorum was achieved\./,
    }
  );

  // Compensation release must have cleaned up the acquired keys
  for (const c of clients) {
    t.is(
      c.get("test-resource"),
      null,
      "Partial key must be released on failure"
    );
  }
});

test("F5 fix: extend() throws ExecutionError when extension round-trip exceeds validity", async (t) => {
  const clients = makeClients(3);
  const redlock = new Redlock(clients as unknown as Client[]);

  const lock = await redlock.acquire(["extend-resource"], 500);
  t.true(lock.expiration > Date.now(), "Lock initially valid");

  // Inject delay exceeding duration
  for (const c of clients) {
    c.delayMs = 120;
  }

  await t.throwsAsync(
    async () => {
      await lock.extend(60);
    },
    {
      instanceOf: ExecutionError,
      message:
        /The lock validity time has elapsed before extension was achieved\./,
    }
  );
});

test("F2 fix: retry is NOT blocked by keys left by the client's own previous attempt", async (t) => {
  const clients = makeClients(3);

  // Client 2 and 3 occupied by a foreign lock for 50ms
  clients[1].set("retry-resource", "FOREIGN", 50);
  clients[2].set("retry-resource", "FOREIGN", 50);

  const redlock = new Redlock(clients as unknown as Client[]);

  // Attempt 1: succeeds on client 0, fails on 1 and 2 (no quorum).
  // Attempt 2: retry after 60ms when foreign locks expire.
  // Prior to fix, client 0 would be blocked by its own key from attempt 1!
  const lock = await redlock.acquire(["retry-resource"], 2000, {
    retryCount: 2,
    retryDelay: 60,
    retryJitter: 0,
  });

  t.truthy(lock, "Acquire succeeded on retry without self-blocking");
  t.is(clients[0].get("retry-resource"), lock.value);
  t.is(clients[1].get("retry-resource"), lock.value);
  t.is(clients[2].get("retry-resource"), lock.value);

  // The assertions above are NOT enough on their own: quorum here is 2 of 3, so
  // even while client 0 was self-blocked the acquisition still succeeded via
  // clients 1 and 2 — and client 0 still held the same value, left over from
  // attempt 1. The defect is only observable on client 0's own votes.
  const log = clients[0].acquireLog;
  t.false(
    log.some((e) => e.selfBlocked),
    "Client 0 was never blocked by its own value"
  );
  t.true(
    log.some((e) => e.granted && !e.reacquiredOwn),
    "Attempt 1 was a fresh acquisition on client 0"
  );
  t.true(
    log.some((e) => e.granted && e.reacquiredOwn),
    "Attempt 2 re-acquired client 0 over its own leftover key (the fixed path)"
  );
});

test.serial(
  "F6 fix: using() cleans up all timers and leaves no unhandled timeout after return",
  async (t) => {
    const clients = makeClients(3);
    const redlock = new Redlock(clients as unknown as Client[], {
      retryCount: 0,
      retryDelay: 0,
      retryJitter: 0,
      automaticExtensionThreshold: 50,
    });

    const duration = 200;
    let extendStartedResolve: () => void;
    const extendStarted = new Promise<void>((r) => (extendStartedResolve = r));
    let openExtendGate: () => void;
    const extendGate = new Promise<void>((r) => (openExtendGate = r));
    let extendIntercepted = 0;
    let extendFinished = false;
    let extendInFlightAtReturn = false;

    // Hold the extension at an explicit gate so the routine can return while the
    // extension is genuinely in flight.
    //
    // The gate is a bare Promise on purpose: a sleep() here would create a
    // setTimeout of its own, and this test counts lingering timers — the
    // harness must not contribute any.
    for (const c of clients) {
      const origEval = c.eval.bind(c);
      c.eval = async (script, numKeys, args) => {
        if (isExtendScript(script)) {
          extendIntercepted++;
          extendStartedResolve();
          await extendGate;
          const result = await origEval(script, numKeys, args);
          extendFinished = true;
          return result;
        }
        return origEval(script, numKeys, args);
      };
    }

    // Track global setTimeout / clearTimeout
    const activeTimers = new Set<NodeJS.Timeout>();
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const handle = origSetTimeout(() => {
        activeTimers.delete(handle);
        fn(...args);
      }, ms);
      activeTimers.add(handle);
      return handle;
    }) as typeof setTimeout;

    globalThis.clearTimeout = ((handle?: NodeJS.Timeout) => {
      if (handle) activeTimers.delete(handle);
      return origClearTimeout(handle);
    }) as typeof clearTimeout;

    const baseline = new Set(activeTimers);

    try {
      const result = await redlock.using(
        ["leak-resource"],
        duration,
        async () => {
          await extendStarted;
          extendInFlightAtReturn = !extendFinished;
          // Let using() reach the "routine done, extension still in flight"
          // state before the extension is allowed to complete. setImmediate is
          // not a setTimeout, so it is not counted as a lingering timer.
          setImmediate(openExtendGate);
          return "ROUTINE_DONE";
        }
      );

      t.is(result, "ROUTINE_DONE");

      // Preconditions: without these, "no lingering timers" would also hold in
      // the case where no extension ever ran — a vacuous pass.
      t.true(extendIntercepted > 0, "An automatic extension actually ran");
      t.true(
        extendInFlightAtReturn,
        "The routine returned while the extension was still in flight"
      );

      const leaked = [...activeTimers].filter((h) => !baseline.has(h));
      t.is(leaked.length, 0, "No lingering timers after using() completes");
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  }
);

test("F7 fix: using() propagates routine error without masking when release fails", async (t) => {
  const clients = makeClients(3);
  for (const c of clients) {
    c.failRelease = true; // release will fail
  }

  const redlock = new Redlock(clients as unknown as Client[], {
    retryCount: 0,
    automaticExtensionThreshold: 100,
  });

  const customError = new Error("Custom Business Logic Error");

  await t.throwsAsync(
    async () => {
      await redlock.using(["err-resource"], 500, async () => {
        throw customError;
      });
    },
    {
      is: customError,
      message: "Custom Business Logic Error",
    }
  );
});

test("F7 fix: using() propagates signal.error when abort occurs rather than release error", async (t) => {
  const clients = makeClients(3);
  for (const c of clients) {
    c.failExtend = true;
    c.failRelease = true;
  }

  const redlock = new Redlock(clients as unknown as Client[], {
    retryCount: 0,
    retryDelay: 0,
    retryJitter: 0,
    automaticExtensionThreshold: 50,
  });

  // Lock duration 160ms, extension fails -> abort signal triggered
  let captured: RedlockAbortSignal | undefined;
  const error = await t.throwsAsync(
    async () => {
      await redlock.using(["abort-resource"], 160, async (signal) => {
        captured = signal;
        await sleep(250); // wait for extension to fail and lock to expire
        t.true(signal.aborted, "Signal aborted");
        return "ROUTINE_FINISH";
      });
    },
    {
      instanceOf: ExecutionError,
      message:
        /The operation was unable to achieve a quorum during its retry window\./,
    }
  );

  // The message alone proves nothing: before the fix, the error thrown from the
  // `finally` block (the failing release) carried exactly the same message. The
  // discriminating assertion is *identity* — the thrown error must be the very
  // object recorded on the signal, not a look-alike from the release path.
  t.truthy(captured?.error, "signal.error was set when the lock was lost");
  t.is(
    error,
    captured?.error,
    "using() rethrows signal.error itself, not the release error"
  );
});

// Counting eval calls cannot measure retryCount inside `using()`: when an
// extension fails, `using()` re-invokes extend() recursively for as long as the
// lock is still valid (src/index.ts, the `running && lock.expiration > Date.now()`
// branch). With retryDelay 0 that is a tight microtask loop — measured at 4149
// eval calls in ~50ms. So the two properties are asserted separately, each in a
// deterministic way.

test.serial(
  "settings pass-through: using() forwards its per-call settings to lock.extend",
  async (t) => {
    const clients = makeClients(3);
    const redlock = new Redlock(clients as unknown as Client[], {
      retryCount: 5,
      retryDelay: 200,
    });

    const perCall: Partial<Settings> = {
      retryCount: 0,
      retryDelay: 0,
      retryJitter: 0,
      automaticExtensionThreshold: 50,
    };

    // Capture the second argument `using()` hands to Lock#extend. This is the
    // property under test, observed directly rather than inferred from counts.
    const captured: (Partial<Settings> | undefined)[] = [];
    const originalExtend = Lock.prototype.extend;
    Lock.prototype.extend = function (
      this: Lock,
      duration: number,
      settings?: Partial<Settings>
    ): Promise<Lock> {
      captured.push(settings);
      return originalExtend.call(this, duration, settings);
    };

    try {
      // Extension succeeds here: no failure loop, exactly one extension.
      const result = await redlock.using(
        ["settings-resource"],
        200,
        perCall,
        async () => {
          await sleep(250);
          return "DONE";
        }
      );
      t.is(result, "DONE");
    } finally {
      Lock.prototype.extend = originalExtend;
    }

    // Precondition: an automatic extension actually happened.
    t.true(captured.length > 0, "Lock#extend was actually called");

    // Before the fix, `using()` called `lock.extend(duration)` with no second
    // argument, so every captured value was undefined.
    t.not(captured[0], undefined, "extend received a settings argument");

    // `using()` merges the per-call settings over the instance settings, so the
    // captured object is the full merged set (it also carries driftFactor etc.).
    // What matters is that the per-call overrides won.
    t.like(
      captured[0],
      perCall,
      "using() forwards its per-call settings to extend"
    );
    t.is(
      captured[0]?.retryCount,
      0,
      "retryCount is the per-call 0, not the instance's 5"
    );
  }
);

test("settings pass-through: lock.extend honours the retryCount it is given", async (t) => {
  const clients = makeClients(3);
  // Instance is configured with retryCount 5 -> 6 attempts per client if the
  // per-call settings are ignored.
  const redlock = new Redlock(clients as unknown as Client[], {
    retryCount: 5,
    retryDelay: 0,
    retryJitter: 0,
  });

  const lock = await redlock.acquire(["retrycount-resource"], 10_000);

  // Only now start failing extensions, so acquisition is unaffected.
  let extendAttemptsCount = 0;
  for (const c of clients) {
    const origEval = c.eval.bind(c);
    c.eval = async (script, numKeys, args) => {
      if (isExtendScript(script)) {
        extendAttemptsCount++;
        return 0; // force failure
      }
      return origEval(script, numKeys, args);
    };
  }

  // Called directly, so there is no `using()` retry loop in play: the attempt
  // count is exactly (retryCount + 1) * clients.
  await t.throwsAsync(
    async () => {
      await lock.extend(10_000, {
        retryCount: 0,
        retryDelay: 0,
        retryJitter: 0,
      });
    },
    { instanceOf: ExecutionError }
  );

  t.is(
    extendAttemptsCount,
    3,
    "retryCount: 0 means exactly 1 attempt on each of the 3 clients"
  );
});

test("Liveness defect: acquire() throws ExecutionError instead of hanging when even nodes tie", async (t) => {
  // In an even-node configuration (N=2, quorumSize=2), a 1:1 tie vote
  // (1 for, 1 against) must resolve as a failure ("against") rather than
  // leaving the outer attempt Promise permanently pending.
  const clients = makeClients(2);
  clients[1].set("tie-resource", "OCCUPIED_BY_ANOTHER_CLIENT", 10_000);

  const redlock = new Redlock(clients as unknown as Client[], {
    retryCount: 0,
    retryDelay: 0,
    retryJitter: 0,
  });

  await t.throwsAsync(
    async () => {
      await redlock.acquire(["tie-resource"], 1000);
    },
    {
      instanceOf: ExecutionError,
      message:
        /The operation was unable to achieve a quorum during its retry window\./,
    }
  );
});
