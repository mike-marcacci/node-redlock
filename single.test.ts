import { ResourceLockedError, ExecutionError } from './errors.ts'
import Redlock from './redlock.ts'
import { assert, assertNotEquals, fail } from "https://deno.land/std@0.141.0/testing/asserts.ts"
import { assertEquals } from "https://deno.land/std@0.141.0/testing/asserts.ts";
import { connect } from "https://deno.land/x/redis@v0.25.5/mod.ts";
  

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
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
     
        const redlock = new Redlock(redis);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

        // acquire the lock
        let lock = await redlock.acquire(["{redlock}a"], duration);
        assertEquals(await redis.get("{redlock}a"), lock.value, "lock value incorrect.");

        // extend the lock
        lock = await lock.extend(3 * duration);
        assertEquals(await redis.get("{redlock}a"), lock.value, "lock value incorrect.");

        // release the lock.
        await lock.release();
        assertEquals(await redis.get("{redlock}a"), undefined);
    } catch (error) {
        fail(error);
      }
});

Deno.test("acquires, extends, and releases a multi-resource lock", async (t) => {
    try {
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
        const redlock = new Redlock(redis);
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
        assertEquals(await redis.get("{redlock}a1"), undefined);
        assertEquals(await redis.get("{redlock}a2"), undefined);
    } catch (error) {
        fail(error);
    } 
});


Deno.test("if communication with Redis goes down, the lock fails", async (t) => {
    try {
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
        const redlock = new Redlock(redis);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);
        redlock.on("error", () => {
            // ignore redis-generated errors
        });
        try {
            await redlock.acquire(["{redlock}8"], duration);
        } catch (error) {
            if (!(error instanceof ExecutionError)) {
                throw error;
            }
            assertEquals(error.attempts.length, 11, "incorrect number of retries");
            for (const e of await Promise.allSettled(error.attempts)) {
                assertEquals(e.status, "fulfilled");
                if (e.status === "fulfilled") {
                    for (const v of e.value?.votesAgainst?.values()) {
                        assertEquals(v.message, "The operation was applied to: 0 of the 1 requested resources.");
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
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
        const redlock = new Redlock(redis);
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
        assertEquals(await redis.get("{redlock}d"), undefined);
    } catch (error) {
        fail(error);
    }
});

Deno.test("locks are exclusive", async (t) => {
    try {
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
        const redlock = new Redlock(redis);
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
          assertEquals(await redis.get("{redlock}c"), undefined);
    } catch (error) {
          fail(error);
    }
});

Deno.test("overlapping multi-locks are exclusive", async () => {
    try {
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
        const redlock = new Redlock(redis);
        const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

        // Acquire a lock.
        const lock = await redlock.acquire(["{redlock}14", "{redlock}25"], duration);
        assertEquals(await redis.get("{redlock}14"), lock.value, "lock not acquired successfully");
        assertEquals(await redis.get("{redlock}25"), lock.value, "lock not acquired successfully");

        try {
            await redlock.acquire(["{redlock}25", "{redlock}36"], duration);
            throw new Error("lock shouldn't be acquired");
        } catch (error) {
            if (!(error instanceof ExecutionError)) {
              throw error;
            }
            assertEquals(await redis.get("{redlock}14"), lock.value, "original lock value shouldn't be changed.");
            assertEquals(await redis.get("{redlock}25"), lock.value, "original lock value shouldn't be changed.");
            assertEquals(await redis.get("{redlock}36"), undefined);
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
          assertEquals(await redis.get("{redlock}14"), undefined);
          assertEquals(await redis.get("{redlock}25"), undefined);
    } catch(error) {
        fail(error);
    }
});

Deno.test("the using helper acquires, extends, and releases locks", async (t) => {
    try {
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
        const redlock = new Redlock(redis);
        const duration = 500;
        let locked = false;
        const [valueP] = await Promise.all([await redlock.using(["{redlock}94"], duration, 
            { automaticExtensionThreshold: 200 },
            async (signal) => {
                assertEquals(locked, false, "The resource must not already be locked.");
                locked = true;
                const lockValue = await redis.get("{redlock}94");
                assert(typeof lockValue === "string", "lock value not acquired.");
    
                // Wait to ensure that the lock is extended
                await new Promise((resolve) => setTimeout(resolve, 700, undefined));

                assertEquals(signal.error, undefined, "signal shouldn't have an error.");
                assertEquals(signal.aborted, false, "signal shouldn't be aborted.");
                assertEquals(await redis.get("{redlock}94"), lockValue, "lock value shouldn't have changed.");
                return lockValue;
            }
        )]);
        assertNotEquals(valueP, "wut", "The locks must be different.");
        assertEquals(await redis.get("{redlock}94"), undefined);
    } catch (error) {
        fail(error);
    }
});

Deno.test("the using helper is exclusive", async (t) => {
    try {
        await redis
        .keys("*")
        .then((keys) => {
            for (let i = 0; i < keys.length; i++) {
                redis.del(keys[i]);
            }
        });
        const redlock = new Redlock(redis);
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

                assertEquals(signal.error, undefined, "The signal shouldn't have an error.");
                assertEquals(signal.aborted, false, "The signal shouldn't be aborted.");
                assertEquals(await redis.get("{redlock}y"), lockValue, "lock value shouldn't have changed.");
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
        assertEquals(await redis.get("{redlock}y"), undefined);
    } catch (error) {
      fail(error);
    }
});
