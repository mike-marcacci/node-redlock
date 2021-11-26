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

function run(
  namespace: string,
  redisA: Client | Cluster,
  redisB: Client | Cluster,
  redisC: Client | Cluster
): void {
  test.before(async () => {
    await Promise.all([
      redisA.keys("*").then((keys) => (keys?.length ? redisA.del(keys) : null)),
      redisB.keys("*").then((keys) => (keys?.length ? redisB.del(keys) : null)),
      redisC.keys("*").then((keys) => (keys?.length ? redisC.del(keys) : null)),
    ]);
  });

  test(`${namespace} - acquires, extends, and releases a single lock`, async (t) => {
    try {
      const redlock = new Redlock([redisA, redisB, redisC]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Acquire a lock.
      let lock = await redlock.acquire(["{redlock}a"], duration);
      t.is(
        await redisA.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redisA.pttl("{redlock}a")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redisB.pttl("{redlock}a")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redisC.pttl("{redlock}a")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redisA.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}a"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.floor((await redisA.pttl("{redlock}a")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redisB.pttl("{redlock}a")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redisC.pttl("{redlock}a")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redisA.get("{redlock}a"), null);
      t.is(await redisB.get("{redlock}a"), null);
      t.is(await redisC.get("{redlock}a"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - succeeds when a minority of clients fail`, async (t) => {
    try {
      const redlock = new Redlock([redisA, redisB, redisC]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Set a value on redisC so that lock acquisition fails.
      await redisC.set("{redlock}b", "other");

      // Acquire a lock.
      let lock = await redlock.acquire(["{redlock}b"], duration);
      t.is(
        await redisA.get("{redlock}b"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}b"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}b"),
        "other",
        "The lock value was changed."
      );
      t.is(
        Math.floor((await redisA.pttl("{redlock}b")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redisB.pttl("{redlock}b")) / 200),
        Math.floor(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        await redisC.pttl("{redlock}b"),
        -1,
        "The lock expiration was changed"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redisA.get("{redlock}b"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}b"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}b"),
        "other",
        "The lock value was changed."
      );
      t.is(
        Math.floor((await redisA.pttl("{redlock}b")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.floor((await redisB.pttl("{redlock}b")) / 200),
        Math.floor((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        await redisC.pttl("{redlock}b"),
        -1,
        "The lock expiration was changed"
      );

      // Release the lock.
      await lock.release();
      t.is(await redisA.get("{redlock}b"), null);
      t.is(await redisB.get("{redlock}b"), null);
      t.is(await redisC.get("{redlock}b"), "other");
      await redisC.del("{redlock}b");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - fails when a majority of clients fail`, async (t) => {
    try {
      const redlock = new Redlock([redisA, redisB, redisC]);

      const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

      // Set a value on redisB and redisC so that lock acquisition fails.
      await redisB.set("{redlock}c", "other1");
      await redisC.set("{redlock}c", "other2");

      // Acquire a lock.
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

        t.is(await redisA.get("{redlock}c"), null);
        t.is(await redisB.get("{redlock}c"), "other1");
        t.is(await redisC.get("{redlock}c"), "other2");

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.assert(
                v instanceof ResourceLockedError,
                "The error was of the wrong type."
              );
              t.is(
                v.message,
                "The operation was applied to: 0 of the 1 requested resources."
              );
            }
          }
        }
      }

      await redisB.del("{redlock}c");
      await redisC.del("{redlock}c");
    } catch (error) {
      fail(t, error);
    }
  });
}

run(
  "instance",
  new Redis({ host: "redis-multi-instance-a" }),
  new Redis({ host: "redis-multi-instance-b" }),
  new Redis({ host: "redis-multi-instance-c" })
);

run(
  "cluster",
  new Cluster([{ host: "redis-multi-cluster-a-1" }]),
  new Cluster([{ host: "redis-multi-cluster-b-1" }]),
  new Cluster([{ host: "redis-multi-cluster-c-1" }])
);
