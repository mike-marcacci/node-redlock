import { ResourceLockedError, ExecutionError } from '../errors.ts'
import Redlock from '../redlock.ts'
import { assert, assertNotEquals, fail } from "https://deno.land/std@0.141.0/testing/asserts.ts"
import { assertEquals } from "https://deno.land/std@0.141.0/testing/asserts.ts";
import { connect } from "../deps.ts";

interface TestStepDefinition {
    fn: (t: TestContext) => void | Promise<void>;
    ignore?: boolean;
    name: string;
    sanitizeExit?: boolean;
    sanitizeOps?: boolean;
    sanitizeResources?: boolean;
}

interface TestContext {
    name: string;
    origin: string;
    parent?: TestContext;
    step(t: TestStepDefinition): Promise<boolean>;
    step(name: string, fn: (t: TestContext) => void | Promise<void>): Promise<boolean>;
}

const redis = await connect({hostname: "127.0.0.1", port: 6379});

Deno.test("acquires, extends, and releases a lock with a single resource", async (t) => {
    try {
        const redlock = new Redlock([redis]);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

        // acquire the lock
        let lock = await redlock.acquire(["{redlock}a"], duration);
        assertEquals(await redis.get("{redlock}a"), lock.value, "lock value incorrect.");

        // extend the lock
        lock = await lock.extend(3 * duration);
        assertEquals(await redis.get("{redlock}a"), lock.value, "lock value incorrect.");

        // release the lock.
        await lock.release();
        assertEquals(await redis.get("{redlock}a"), null, "lock failed to release");
    } catch (error) {
        fail(error);
      }
});

Deno.test("acquires, extends, and releases a multi-resource lock", async (t) => {
    try {
        const redlock = new Redlock([redis]);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

        // acquire the lock
        let lock = await redlock.acquire(["{redlock}a1", "{redlock}a2"], duration);
        assertEquals(await redis.get("{redlock}a1"), lock.value, "a1 lock value incorrect.");
        assertEquals(await redis.get("{redlock}a2"), lock.value, "a2 lock value incorrect.");

        // extend the lock
        lock = await lock.extend(3 * duration);
        assertEquals(await redis.get("{redlock}a1"), lock.value, "a1 lock value incorrect.");
        assertEquals(await redis.get("{redlock}a2"), lock.value, "a2 lock value incorrect.");

        // release the lock.
        await lock.release();
        assertEquals(await redis.get("{redlock}a1"), null, "a1 lock failed to release");
        assertEquals(await redis.get("{redlock}a2"), null, "a1 lock failed to release");
    } catch (error) {
        fail(error);
    } 
});

Deno.test("if communication with Redis goes down, the lock fails", async (t) => {
    try {
        // redis.on("error", () => {
        //     // ignore redis-generated errors
        //   });
        const redlock = new Redlock([redis]);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);
        try {
            await redlock.acquire(["{redlock}b"], duration);
            throw new Error("lock shouldn't be acquired");
        } catch (error) {
            if (!(error instanceof ExecutionError)) {
                throw error;
            }
            assertEquals(error.attempts.length, 11, "incorrect number of retries");
            for (const e of await Promise.allSettled(error.attempts)) {
                assertEquals(e.status, "fulfilled");
                if (e.status === "fulfilled") {
                    for (const v of e.value?.votesAgainst?.values()) {
                        assertEquals(v.message, "Connection is closed.");
                    }
                }
            }
        }
    } catch (error) {
          fail(error);
    }
});

Deno.test("automatic expiration for locks", async (t) => {
    try {
        const redlock = new Redlock([redis]);
        const duration = 200;
        const lock = await redlock.acquire(["{redlock}d"], duration);
        assertEquals(await redis.get("{redlock}d"),  lock.value, "lock value incorrect");

        // Wait until the lock expires.
        await new Promise((resolve) => setTimeout(resolve, 300, undefined));

        // Attempt to acquire another lock on the same resource.
        const lock2 = await redlock.acquire(["{redlock}d"], duration);
        assertEquals(await redis.get("{redlock}d"), lock2.value, "lock2 value is incorrect");

        // Release the lock.
        await lock2.release();
        assertEquals(await redis.get("{redlock}d"), null, "lock failed to release");
    } catch (error) {
        fail(error);
    }
});

Deno.test("locks are exclusive", async (t) => {
    try {
        const redlock = new Redlock([redis]);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

        // Acquire a lock.
        const lock = await redlock.acquire(["{redlock}c"], duration);
        assertEquals(await redis.get("{redlock}c"),  lock.value, "lock value is incorrect.");

        try {
            await redlock.acquire(["{redlock}c"], duration);
            throw new Error("lock shouldn't be acquired.");
          } catch (error) {
            if (!(error instanceof ExecutionError)) {
              throw error;
            }
            assertEquals(error.attempts.length, 11, "incorrect number of retries");
    
            for (const e of await Promise.allSettled(error.attempts)) {
                assertEquals(e.status, "fulfilled");
                if (e.status === "fulfilled") {
                    for (const v of e.value?.votesAgainst?.values()) {
                        assert(v instanceof ResourceLockedError, "The error must be a ResourceLockedError.")
                    }
                }
            }
        }
    
          // Release the lock.
          await lock.release();
          const release = assertEquals(await redis.get("{redlock}c"), null, "The lock failed to release");
    } catch (error) {
          fail(error);
    }
});

Deno.test("overlapping multi-locks are exclusive", async (t) => {
    try {
        const redis = await connect({hostname: "127.0.0.1", port: 6379});
        const redlock = new Redlock([redis]);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);
        // Acquire a lock.
        const lock = await redlock.acquire(["{redlock}c1", "{redlock}c2"], duration);
        assertEquals(await redis.get("{redlock}c1"), lock.value, "lock not acquired successfully");
        assertEquals(await redis.get("{redlock}c2"), lock.value, "lock not acquired successfully");

        try {
            await redlock.acquire(["{redlock}c2", "{redlock}c3"], duration);
            throw new Error("lock shouldn't be acquired");
        } catch (error) {
            if (!(error instanceof ExecutionError)) {
              throw error;
            }
            assertEquals(await redis.get("{redlock}c1"), lock.value, "original lock value shouldn't be changed.");
            assertEquals(await redis.get("{redlock}c2"), lock.value, "original lock value shouldn't be changed.");
            assertEquals(await redis.get("{redlock}c3"), null, "new resource must remained unlocked.");
            assertEquals(error.attempts.length, 11, "incorrect number of retries");

            for (const e of await Promise.allSettled(error.attempts)) {
                assertEquals(e.status, "fulfilled");
                if (e.status === "fulfilled") {
                    for (const v of e.value?.votesAgainst?.values()) {
                        assert(v instanceof ResourceLockedError, "The error must be a ResourceLockedError.");
                    }
                }
            }
        }
    
          // Release the lock.
          await lock.release();
          assertEquals(await redis.get("{redlock}c1"), null, "c1 lock failed to release");
          assertEquals(await redis.get("{redlock}c2"), null, "c2 lock failed to release");
          assertEquals(await redis.get("{redlock}c3"), null, "c3 lock failed to release");
    } catch(error) {
        fail(error);
    }
});

Deno.test("the using helper acquires, extends, and releases locks", async (t) => {
    try {
        const redis = await connect({hostname: "127.0.0.1", port: 6379});
        const redlock = new Redlock([redis]);
        const duration = 500;
        const valueP = redlock.using(["{redlock}x"], duration, 
            { automaticExtensionThreshold: 200 },
            async (signal) => {
              const lockValue = await redis.get("{redlock}x");
              assert(typeof lockValue === "string", "lock value not acquired.");
    
              // Wait to ensure that the lock is extended
              await new Promise((resolve) => setTimeout(resolve, 700, undefined));

              assertEquals(signal.aborted, false, "signal shouldn't be aborted.");
              assertEquals(signal.error, undefined, "signal shouldn't have an error.");
              assertEquals(await redis.get("{redlock}x"), lockValue, "lock value shouldn't have changed.");
    
              return lockValue;
            }
        );
        await valueP;
        assertEquals(await redis.get("{redlock}x"), null, "lock failed to release.");
    } catch (error) {
        fail(error);
    }
});

Deno.test("the using helper is exclusive", async (t) => {
    try {
        const redlock = new Redlock([redis]);
        const duration = 500;
        let locked = false;
        const [lock1, lock2] = await Promise.all([await redlock.using(["{redlock}y"], duration,
            { automaticExtensionThreshold: 200 },
            async (signal) => {
                assertEquals(locked, false, "The resource must not already be locked.");
                locked = true;
                const lockValue = await redis.get("{redlock}y");
                assert(typeof lockValue === "string", "The lock value was not correctly acquired.");

                // Wait to ensure that the lock is extended
                await new Promise((resolve) => setTimeout(resolve, 700, undefined));

                assertEquals(signal.error, undefined, "The signal must not have an error.");
                assertEquals(signal.aborted, false, "The signal must not be aborted.");
                assertEquals(await redis.get("{redlock}y"), lockValue, "The lock value should not have changed.");
                locked = false;
                return lockValue;
            }
        ),
        await redlock.using(["{redlock}y"], duration,
            { automaticExtensionThreshold: 200 },
            async (signal) => {
                assertEquals(locked, false, "The resource must not already be locked.")
                locked = true;
                const lockValue = await redis.get("{redlock}y");
                assert(typeof lockValue === "string", "The lock value was not correctly acquired.");

                // Wait to ensure that the lock is extended
                await new Promise((resolve) => setTimeout(resolve, 700, undefined));

                assertEquals(signal.error, undefined, "The signal must not have an error.");
                assertEquals(signal.aborted, false, "The signal must not be aborted.")
                assertEquals(await redis.get("{redlock}y"), lockValue, "The lock value should not have changed.");
                locked = false;

                return lockValue;
            }
        )]);
        assertNotEquals(lock1, lock2, "The locks must be different.");
        assertEquals(await redis.get("{redlock}y"), null, "The lock was not released.")
    } catch (error) {
      fail(error);
    }
});

Deno.test("the using helper is exclusive", async (t) => {
    try {
        const redlock = new Redlock([redis]);
        const duration = 500;
        let locked = false;
        const [lock1, lock2] = await Promise.all([
            await redlock.using(["{redlock}y"], duration, { automaticExtensionThreshold: 200 },
            async (signal) => {
                assertEquals(locked, false, "The resource must not already be locked.")
                locked = true;
                const lockValue = await redis.get("{redlock}y");
                assert(typeof lockValue === "string", "The lock value was not correctly acquired.");
    
                // Wait to ensure that the lock is extended
                await new Promise((resolve) => setTimeout(resolve, 700, undefined));
    
                assertEquals(signal.error, undefined, "The signal must not have an error.");
                assertEquals(signal.aborted, false, "The signal must not be aborted.");
                assertEquals(await redis.get("{redlock}y"), lockValue, "The lock value should not have changed.");
    
                locked = false;
                return lockValue;
              }),
            await redlock.using(["{redlock}y"], duration, { automaticExtensionThreshold: 200 },
            async (signal) => {
                assertEquals(locked, false, "The resource must not already be locked.")
                locked = true;
                const lockValue = await redis.get("{redlock}y");
                assert(typeof lockValue === "string", "The lock value was not correctly acquired.")
    
                // Wait to ensure that the lock is extended
                await new Promise((resolve) => setTimeout(resolve, 700, undefined));
    
                assertEquals(signal.error, undefined, "The signal must not have an error.");
                assertEquals(signal.aborted, false, "The signal must not be aborted.");
                assertEquals(await redis.get("{redlock}y"), lockValue, "The lock value should not have changed.");
    
                locked = false;
                return lockValue;
              }
            ),
          ]);
    
          assertNotEquals(lock1, lock2, "The locks must be different.");
          assertEquals(await redis.get("{redlock}y"), null, "The lock was not released.")
    } catch (error) {
        fail(error);
    }
});
