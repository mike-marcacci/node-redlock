import test from "ava";
import Client from "ioredis";
import Redlock, { ExecutionError, ResourceLockedError } from "./redlock";

const redis = new Client({ host: "redis_single_instance" });

test("acquires, extends, and releases a single lock", async (t) => {
  const redlock = new Redlock([redis]);

  const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

  // Acquire a lock.
  const lock = await redlock.acquire(["a"], duration);
  t.is(await redis.get("a"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redis.pttl("a")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Extend the lock.
  await lock.extend(3 * duration);
  t.is(await redis.get("a"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redis.pttl("a")) / 100),
    Math.floor((3 * duration) / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Release the lock.
  await lock.release();
  t.is(await redis.get("a"), null);
});

test("acquires, extends, and releases a multi-resource lock", async (t) => {
  const redlock = new Redlock([redis]);

  const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

  // Acquire a lock.
  const lock = await redlock.acquire(["a1", "a2"], duration);
  t.is(await redis.get("a1"), lock.value, "The lock value was incorrect.");
  t.is(await redis.get("a2"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redis.pttl("a1")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );
  t.is(
    Math.floor((await redis.pttl("a2")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Extend the lock.
  await lock.extend(3 * duration);
  t.is(await redis.get("a1"), lock.value, "The lock value was incorrect.");
  t.is(await redis.get("a2"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redis.pttl("a1")) / 100),
    Math.floor((3 * duration) / 100),
    "The lock expiration was off by more than 100ms"
  );
  t.is(
    Math.floor((await redis.pttl("a2")) / 100),
    Math.floor((3 * duration) / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Release the lock.
  await lock.release();
  t.is(await redis.get("a1"), null);
  t.is(await redis.get("a2"), null);
});

test("locks fail when redis is unreachable", async (t) => {
  const redis = new Client({
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

  // Extend the lock.
  try {
    await redlock.acquire(["b"], duration);
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
          t.assert(v.message, "Error: Connection is closed.");
        }
      }
    }
  }
});

test("locks automatically expire", async (t) => {
  const redlock = new Redlock([redis]);

  const duration = 200;

  // Acquire a lock.
  const lock = await redlock.acquire(["d"], duration);
  t.is(await redis.get("d"), lock.value, "The lock value was incorrect.");

  // Wait until the lock expires.
  await new Promise((resolve) => setTimeout(resolve, 300, undefined));

  // Attempt to acquire another lock on the same resource.
  const lock2 = await redlock.acquire(["d"], duration);
  t.is(await redis.get("d"), lock2.value, "The lock value was incorrect.");

  // Release the lock.
  await lock2.release();
  t.is(await redis.get("d"), null);
});

test("individual locks are exclusive", async (t) => {
  const redlock = new Redlock([redis]);

  const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

  // Acquire a lock.
  const lock = await redlock.acquire(["c"], duration);
  t.is(await redis.get("c"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redis.pttl("c")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Attempt to acquire another lock on the same resource.
  try {
    await redlock.acquire(["c"], duration);
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
  t.is(await redis.get("c"), null);
});

test("overlapping multi-locks are exclusive", async (t) => {
  const redlock = new Redlock([redis]);

  const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

  // Acquire a lock.
  const lock = await redlock.acquire(["c1", "c2"], duration);
  t.is(await redis.get("c1"), lock.value, "The lock value was incorrect.");
  t.is(await redis.get("c2"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redis.pttl("c1")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );
  t.is(
    Math.floor((await redis.pttl("c2")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Attempt to acquire another lock with overlapping resources
  try {
    await redlock.acquire(["c2", "c3"], duration);
    throw new Error("This lock should not be acquired.");
  } catch (error) {
    if (!(error instanceof ExecutionError)) {
      throw error;
    }

    t.is(
      await redis.get("c1"),
      lock.value,
      "The original lock value must not be changed."
    );
    t.is(
      await redis.get("c2"),
      lock.value,
      "The original lock value must not be changed."
    );
    t.is(await redis.get("c3"), null, "The new resource must remain unlocked.");

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
  t.is(await redis.get("c1"), null);
  t.is(await redis.get("c2"), null);
  t.is(await redis.get("c3"), null);
});

test("the `using` helper acquires, extends, and releases locks", async (t) => {
  const redlock = new Redlock([redis]);

  const duration = 300;

  await redlock.using(
    ["x"],
    duration,
    {
      automaticExtensionThreshold: 100,
    },
    async (signal) => {
      const lockValue = await redis.get("x");
      t.assert(
        typeof lockValue === "string",
        "The lock value was not correctly acquired."
      );

      // Wait to ensure that the lock is extended
      await new Promise((resolve) => setTimeout(resolve, 400, undefined));

      t.is(signal.aborted, false, "The signal must not be aborted.");
      t.is(signal.error, undefined, "The signal must not have an error.");

      t.is(
        await redis.get("x"),
        lockValue,
        "The lock value should not have changed."
      );

      return lockValue;
    }
  );

  t.is(await redis.get("x"), null, "The lock was not released.");
});

test("the `using` helper is exclusive", async (t) => {
  const redlock = new Redlock([redis]);

  const duration = 300;

  let locked = false;
  const [lock1, lock2] = await Promise.all([
    await redlock.using(
      ["y"],
      duration,
      {
        automaticExtensionThreshold: 100,
      },
      async (signal) => {
        t.is(locked, false, "The resource must not already be locked.");
        locked = true;

        const lockValue = await redis.get("y");
        t.assert(
          typeof lockValue === "string",
          "The lock value was not correctly acquired."
        );

        // Wait to ensure that the lock is extended
        await new Promise((resolve) => setTimeout(resolve, 400, undefined));

        t.is(signal.error, undefined, "The signal must not have an error.");
        t.is(signal.aborted, false, "The signal must not be aborted.");

        t.is(
          await redis.get("y"),
          lockValue,
          "The lock value should not have changed."
        );

        locked = false;
        return lockValue;
      }
    ),
    await redlock.using(
      ["y"],
      duration,
      {
        automaticExtensionThreshold: 100,
      },
      async (signal) => {
        t.is(locked, false, "The resource must not already be locked.");
        locked = true;

        const lockValue = await redis.get("y");
        t.assert(
          typeof lockValue === "string",
          "The lock value was not correctly acquired."
        );

        // Wait to ensure that the lock is extended
        await new Promise((resolve) => setTimeout(resolve, 400, undefined));

        t.is(signal.error, undefined, "The signal must not have an error.");
        t.is(signal.aborted, false, "The signal must not be aborted.");

        t.is(
          await redis.get("y"),
          lockValue,
          "The lock value should not have changed."
        );

        locked = false;
        return lockValue;
      }
    ),
  ]);

  t.not(lock1, lock2, "The locks must be different.");

  t.is(await redis.get("y"), null, "The lock was not released.");
});

const redisA = new Client({ host: "redis_multi_instance_a" });
const redisB = new Client({ host: "redis_multi_instance_b" });
const redisC = new Client({ host: "redis_multi_instance_c" });

test("multi - acquires, extends, and releases a single lock", async (t) => {
  const redlock = new Redlock([redisA, redisB, redisC]);

  const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

  // Acquire a lock.
  const lock = await redlock.acquire(["a"], duration);
  t.is(await redisA.get("a"), lock.value, "The lock value was incorrect.");
  t.is(await redisB.get("a"), lock.value, "The lock value was incorrect.");
  t.is(await redisC.get("a"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redisA.pttl("a")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );
  t.is(
    Math.floor((await redisB.pttl("a")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );
  t.is(
    Math.floor((await redisC.pttl("a")) / 100),
    Math.floor(duration / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Extend the lock.
  await lock.extend(3 * duration);
  t.is(await redisA.get("a"), lock.value, "The lock value was incorrect.");
  t.is(await redisB.get("a"), lock.value, "The lock value was incorrect.");
  t.is(await redisC.get("a"), lock.value, "The lock value was incorrect.");
  t.is(
    Math.floor((await redisA.pttl("a")) / 100),
    Math.floor((3 * duration) / 100),
    "The lock expiration was off by more than 100ms"
  );
  t.is(
    Math.floor((await redisB.pttl("a")) / 100),
    Math.floor((3 * duration) / 100),
    "The lock expiration was off by more than 100ms"
  );
  t.is(
    Math.floor((await redisC.pttl("a")) / 100),
    Math.floor((3 * duration) / 100),
    "The lock expiration was off by more than 100ms"
  );

  // Release the lock.
  await lock.release();
  t.is(await redisA.get("a"), null);
  t.is(await redisB.get("a"), null);
  t.is(await redisC.get("a"), null);
});
