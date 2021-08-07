import test from "ava";
import Redis, { Redis as Client, Cluster } from "ioredis";
import Redlock, { ExecutionError, ResourceLockedError } from "./index.js";

function run(namespace: string, redis: Client | Cluster): void {
  test.before(async () => {
    await redis
      .keys("*")
      .then((keys) => (keys?.length ? redis.del(keys) : null));
  });

  test(`${namespace} - acquires, extends, and releases a single lock`, async (t) => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    let lock = await redlock.acquire(["{redlock}a"], duration);
    t.is(
      await redis.get("{redlock}a"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}a")) / 100),
      Math.floor(duration / 100),
      "The lock expiration was off by more than 100ms"
    );

    // Extend the lock.
    lock = await lock.extend(3 * duration);
    t.is(
      await redis.get("{redlock}a"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}a")) / 100),
      Math.floor((3 * duration) / 100),
      "The lock expiration was off by more than 100ms"
    );

    // Release the lock.
    await lock.release();
    t.is(await redis.get("{redlock}a"), null);
  });

  test(`${namespace} - acquires, extends, and releases a multi-resource lock`, async (t) => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    let lock = await redlock.acquire(["{redlock}a1", "{redlock}a2"], duration);
    t.is(
      await redis.get("{redlock}a1"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      await redis.get("{redlock}a2"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}a1")) / 100),
      Math.floor(duration / 100),
      "The lock expiration was off by more than 100ms"
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}a2")) / 100),
      Math.floor(duration / 100),
      "The lock expiration was off by more than 100ms"
    );

    // Extend the lock.
    lock = await lock.extend(3 * duration);
    t.is(
      await redis.get("{redlock}a1"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      await redis.get("{redlock}a2"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}a1")) / 100),
      Math.floor((3 * duration) / 100),
      "The lock expiration was off by more than 100ms"
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}a2")) / 100),
      Math.floor((3 * duration) / 100),
      "The lock expiration was off by more than 100ms"
    );

    // Release the lock.
    await lock.release();
    t.is(await redis.get("{redlock}a1"), null);
    t.is(await redis.get("{redlock}a2"), null);
  });

  test(`${namespace} - locks fail when redis is unreachable`, async (t) => {
    const redis = new Redis({
      host: "127.0.0.1",
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      retryStrategy: () => null,
      reconnectOnError: () => false,
    });

    redis.on("error", () => {
      // ignore redis-generated errors
    });

    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);
    try {
      await redlock.acquire(["{redlock}b"], duration);
      throw new Error("This lock should not be acquired.");
    } catch (error) {
      if (!(error instanceof ExecutionError)) {
        throw error;
      }

      t.is(
        error.attempts.length,
        11,
        "A failed acquisition must have the configured number of retries."
      );

      for (const e of await Promise.allSettled(error.attempts)) {
        t.is(e.status, "fulfilled");
        if (e.status === "fulfilled") {
          for (const v of e.value?.votesAgainst?.values()) {
            t.is(v.message, "Connection is closed.");
          }
        }
      }
    }
  });

  test(`${namespace} - locks automatically expire`, async (t) => {
    const redlock = new Redlock([redis]);

    const duration = 200;

    // Acquire a lock.
    const lock = await redlock.acquire(["{redlock}d"], duration);
    t.is(
      await redis.get("{redlock}d"),
      lock.value,
      "The lock value was incorrect."
    );

    // Wait until the lock expires.
    await new Promise((resolve) => setTimeout(resolve, 300, undefined));

    // Attempt to acquire another lock on the same resource.
    const lock2 = await redlock.acquire(["{redlock}d"], duration);
    t.is(
      await redis.get("{redlock}d"),
      lock2.value,
      "The lock value was incorrect."
    );

    // Release the lock.
    await lock2.release();
    t.is(await redis.get("{redlock}d"), null);
  });

  test(`${namespace} - individual locks are exclusive`, async (t) => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    const lock = await redlock.acquire(["{redlock}c"], duration);
    t.is(
      await redis.get("{redlock}c"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}c")) / 100),
      Math.floor(duration / 100),
      "The lock expiration was off by more than 100ms"
    );

    // Attempt to acquire another lock on the same resource.
    try {
      await redlock.acquire(["{redlock}c"], duration);
      throw new Error("This lock should not be acquired.");
    } catch (error) {
      if (!(error instanceof ExecutionError)) {
        throw error;
      }

      t.is(
        error.attempts.length,
        11,
        "A failed acquisition must have the configured number of retries."
      );

      for (const e of await Promise.allSettled(error.attempts)) {
        t.is(e.status, "fulfilled");
        if (e.status === "fulfilled") {
          for (const v of e.value?.votesAgainst?.values()) {
            t.assert(
              v instanceof ResourceLockedError,
              "The error must be a ResourceLockedError."
            );
          }
        }
      }
    }

    // Release the lock.
    await lock.release();
    t.is(await redis.get("{redlock}c"), null);
  });

  test(`${namespace} - overlapping multi-locks are exclusive`, async (t) => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    const lock = await redlock.acquire(
      ["{redlock}c1", "{redlock}c2"],
      duration
    );
    t.is(
      await redis.get("{redlock}c1"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      await redis.get("{redlock}c2"),
      lock.value,
      "The lock value was incorrect."
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}c1")) / 100),
      Math.floor(duration / 100),
      "The lock expiration was off by more than 100ms"
    );
    t.is(
      Math.floor((await redis.pttl("{redlock}c2")) / 100),
      Math.floor(duration / 100),
      "The lock expiration was off by more than 100ms"
    );

    // Attempt to acquire another lock with overlapping resources
    try {
      await redlock.acquire(["{redlock}c2", "{redlock}c3"], duration);
      throw new Error("This lock should not be acquired.");
    } catch (error) {
      if (!(error instanceof ExecutionError)) {
        throw error;
      }

      t.is(
        await redis.get("{redlock}c1"),
        lock.value,
        "The original lock value must not be changed."
      );
      t.is(
        await redis.get("{redlock}c2"),
        lock.value,
        "The original lock value must not be changed."
      );
      t.is(
        await redis.get("{redlock}c3"),
        null,
        "The new resource must remain unlocked."
      );

      t.is(
        error.attempts.length,
        11,
        "A failed acquisition must have the configured number of retries."
      );

      for (const e of await Promise.allSettled(error.attempts)) {
        t.is(e.status, "fulfilled");
        if (e.status === "fulfilled") {
          for (const v of e.value?.votesAgainst?.values()) {
            t.assert(
              v instanceof ResourceLockedError,
              "The error must be a ResourceLockedError."
            );
          }
        }
      }
    }

    // Release the lock.
    await lock.release();
    t.is(await redis.get("{redlock}c1"), null);
    t.is(await redis.get("{redlock}c2"), null);
    t.is(await redis.get("{redlock}c3"), null);
  });

  test(`${namespace} - the \`using\` helper acquires, extends, and releases locks`, async (t) => {
    const redlock = new Redlock([redis]);

    const duration = 300;

    await redlock.using(
      ["{redlock}x"],
      duration,
      {
        automaticExtensionThreshold: 100,
      },
      async (signal) => {
        const lockValue = await redis.get("{redlock}x");
        t.assert(
          typeof lockValue === "string",
          "The lock value was not correctly acquired."
        );

        // Wait to ensure that the lock is extended
        await new Promise((resolve) => setTimeout(resolve, 400, undefined));

        t.is(signal.aborted, false, "The signal must not be aborted.");
        t.is(signal.error, undefined, "The signal must not have an error.");

        t.is(
          await redis.get("{redlock}x"),
          lockValue,
          "The lock value should not have changed."
        );

        return lockValue;
      }
    );

    t.is(await redis.get("{redlock}x"), null, "The lock was not released.");
  });

  test(`${namespace} - the \`using\` helper is exclusive`, async (t) => {
    const redlock = new Redlock([redis]);

    const duration = 300;

    let locked = false;
    const [lock1, lock2] = await Promise.all([
      await redlock.using(
        ["{redlock}y"],
        duration,
        {
          automaticExtensionThreshold: 100,
        },
        async (signal) => {
          t.is(locked, false, "The resource must not already be locked.");
          locked = true;

          const lockValue = await redis.get("{redlock}y");
          t.assert(
            typeof lockValue === "string",
            "The lock value was not correctly acquired."
          );

          // Wait to ensure that the lock is extended
          await new Promise((resolve) => setTimeout(resolve, 400, undefined));

          t.is(signal.error, undefined, "The signal must not have an error.");
          t.is(signal.aborted, false, "The signal must not be aborted.");

          t.is(
            await redis.get("{redlock}y"),
            lockValue,
            "The lock value should not have changed."
          );

          locked = false;
          return lockValue;
        }
      ),
      await redlock.using(
        ["{redlock}y"],
        duration,
        {
          automaticExtensionThreshold: 100,
        },
        async (signal) => {
          t.is(locked, false, "The resource must not already be locked.");
          locked = true;

          const lockValue = await redis.get("{redlock}y");
          t.assert(
            typeof lockValue === "string",
            "The lock value was not correctly acquired."
          );

          // Wait to ensure that the lock is extended
          await new Promise((resolve) => setTimeout(resolve, 400, undefined));

          t.is(signal.error, undefined, "The signal must not have an error.");
          t.is(signal.aborted, false, "The signal must not be aborted.");

          t.is(
            await redis.get("{redlock}y"),
            lockValue,
            "The lock value should not have changed."
          );

          locked = false;
          return lockValue;
        }
      ),
    ]);

    t.not(lock1, lock2, "The locks must be different.");

    t.is(await redis.get("{redlock}y"), null, "The lock was not released.");
  });
}

run("instance", new Redis({ host: "redis-single-instance" }));

if (process.env.SKIP_CLUSTER_TESTS !== "true") {
  run("cluster", new Cluster([{ host: "redis-single-cluster-1" }]));
}
