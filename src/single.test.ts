import { formatWithOptions } from "util";
import test, { ExecutionContext } from "ava";
import Redis, { Redis as Client, Cluster } from "ioredis";
import Redlock, { ExecutionError, ResourceLockedError } from "./index.js";

async function fail(
  t: ExecutionContext<unknown>,
  error: unknown
): Promise<void> {
  if (!(error instanceof ExecutionError)) {
    throw error;
  }

  t.fail(`${error.message}
---
${(await Promise.all(error.attempts))
  .map(
    (s, i) =>
      `ATTEMPT ${i}: ${formatWithOptions(
        { colors: true },
        {
          membershipSize: s.membershipSize,
          quorumSize: s.quorumSize,
          votesForSize: s.votesFor.size,
          votesAgainstSize: s.votesAgainst.size,
          votesAgainstError: s.votesAgainst.values(),
        }
      )}`
  )
  .join("\n\n")}
`);
}

async function waitForCluster(redis: Cluster): Promise<void> {
  async function checkIsReady(): Promise<boolean> {
    return (
      ((await redis.cluster("INFO")) as string).match(
        /^cluster_state:(.+)$/m
      )?.[1] === "ok"
    );
  }

  let isReady = await checkIsReady();
  while (!isReady) {
    console.log("Waiting for cluster to be ready...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isReady = await checkIsReady();
  }

  async function checkIsWritable(): Promise<boolean> {
    try {
      return ((await redis.set("isWritable", "true")) as string) === "OK";
    } catch (error) {
      console.error(`Cluster unable to receive writes: ${error}`);
      return false;
    }
  }

  let isWritable = await checkIsWritable();
  while (!isWritable) {
    console.log("Waiting for cluster to be writable...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isWritable = await checkIsWritable();
  }
}

function run(namespace: string, redis: Client | Cluster): void {
  test.before(async () => {
    await (redis instanceof Cluster && redis.isCluster
      ? waitForCluster(redis)
      : null);
  });

  test.before(async () => {
    await redis
      .keys("*")
      .then((keys) => (keys?.length ? redis.del(keys) : null));
  });

  test(`${namespace} - refuses to use a non-integer duration`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = Number.MAX_SAFE_INTEGER / 10;

      // Acquire a lock.
      await redlock.acquire(["{redlock}float"], duration);

      t.fail("Expected the function to throw.");
    } catch (error) {
      t.is(
        (error as Error).message,
        "Duration must be an integer value in milliseconds."
      );
    }
  });

  test(`${namespace} - acquires, extends, and releases a single lock`, async (t) => {
    try {
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
        Math.floor((await redis.pttl("{redlock}a")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redis.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redis.pttl("{redlock}a")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}a"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - acquires, extends, and releases a multi-resource lock`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Acquire a lock.
      let lock = await redlock.acquire(
        ["{redlock}a1", "{redlock}a2"],
        duration
      );
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
        Math.floor((await redis.pttl("{redlock}a1")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redis.pttl("{redlock}a2")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
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
        Math.floor((await redis.pttl("{redlock}a1")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redis.pttl("{redlock}a2")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}a1"), null);
      t.is(await redis.get("{redlock}a2"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - locks fail when redis is unreachable`, async (t) => {
    try {
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
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - locks automatically expire`, async (t) => {
    try {
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
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - individual locks are exclusive`, async (t) => {
    try {
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
        Math.floor((await redis.pttl("{redlock}c")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
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
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - overlapping multi-locks are exclusive`, async (t) => {
    try {
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
        Math.floor((await redis.pttl("{redlock}c1")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redis.pttl("{redlock}c2")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
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
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - the \`using\` helper acquires, extends, and releases locks`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 500;

      const valueP: Promise<string | null> = redlock.using(
        ["{redlock}x"],
        duration,
        {
          automaticExtensionThreshold: 200,
        },
        async (signal) => {
          const lockValue = await redis.get("{redlock}x");
          t.assert(
            typeof lockValue === "string",
            "The lock value was not correctly acquired."
          );

          // Wait to ensure that the lock is extended
          await new Promise((resolve) => setTimeout(resolve, 700, undefined));

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

      await valueP;

      t.is(await redis.get("{redlock}x"), null, "The lock was not released.");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - the \`using\` helper is exclusive`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 500;

      let locked = false;
      const [lock1, lock2] = await Promise.all([
        await redlock.using(
          ["{redlock}y"],
          duration,
          {
            automaticExtensionThreshold: 200,
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
            await new Promise((resolve) => setTimeout(resolve, 700, undefined));

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
            automaticExtensionThreshold: 200,
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
            await new Promise((resolve) => setTimeout(resolve, 700, undefined));

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
    } catch (error) {
      fail(t, error);
    }
  });
}

run("instance", new Redis({ host: "redis-single-instance" }));

run("cluster", new Cluster([{ host: "redis-single-cluster-1" }]));
