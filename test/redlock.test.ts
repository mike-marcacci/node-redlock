import { inspect } from "util";

import Client, { Redis } from "ioredis";

import Redlock, { ExecutionError, Lock } from "../src/redlock";
import { redises } from "./redis-configs";

jest.setTimeout(2000);
const io = (db: number) =>
  new Client({ db, ...redises["redis_single_instance"] });

for (const clientsFn of [
  () => [io(0)],
  () => [io(0), io(1)],
  () => [io(0), io(1), io(2), io(3)],
]) {
  for (const resources of [
    ["tests-redlock:resource:a"],
    ["tests-redlock:resource:b", "tests-redlock:resource:c"],
    [
      "tests-redlock:resource:d",
      "tests-redlock:resource:e",
      "tests-redlock:resource:f",
      "tests-redlock:resource:g",
    ],
  ]) {
    const clients = clientsFn();
    test(
      `ioredis, dbs: ${clients.length}, resources: ${resources.length}`,
      clients,
      resources
    );
  }
}

function test(name: string, clients: Redis[], resources: string[]) {
  describe(name, () => {
    let redlock: Redlock;

    let one: Lock;
    let two: Lock;
    let twoExpiration: number;
    let three: Lock;
    let four: Lock;

    beforeAll(async () => {
      for (const client of clients) {
        await checkRedisIsUp(client);
      }
    });

    beforeAll(async () => {
      redlock = new Redlock(clients, {
        retryCount: 2,
        retryDelay: 150,
        retryJitter: 50,
      } as const);
    });

    it("should lock a resource", async () => {
      one = await redlock.acquire(resources, 200);
      expect(one).toBeInstanceOf(Lock);
      expect(one.expiration).toBeGreaterThan(Date.now() - 1);
      expect(one.attempts).toHaveLength(1);
    });

    it("should wait until a lock expires before issuing another lock", async () => {
      dependsOnPreviousTest(one);

      two = await acquirePrinting(redlock, resources, 800);
      expect(two.expiration).toBeGreaterThan(Date.now() - 1);
      twoExpiration = two.expiration;
      expect(Date.now() + 1).toBeGreaterThan(one.expiration);
      expect(two.attempts.length).toBeGreaterThan(1);
    });

    it("should unlock a resource", async () => {
      dependsOnPreviousTest(two);
      await two.release();
      expect(two.expiration).toBe(0);
    });

    it("should *not* unlock an already-unlocked resource", async () => {
      dependsOnPreviousTest(two);
      await expect(two.release()).rejects.toThrow(ExecutionError);
    });

    it("should fail to extend a lock on an already-unlocked resource", async () => {
      dependsOnPreviousTest(two);
      try {
        await two.extend(200);
        fail("should have thrown");
      } catch (err) {
        if (!(err instanceof ExecutionError)) throw err;
        expect(err.attempts).toHaveLength(0);
      }
    });

    it("should issue another lock immediately after a resource is unlocked", async () => {
      dependsOnPreviousTest(two);
      three = await redlock.acquire(resources, 800);
      expect(three.expiration).toBeGreaterThan(Date.now() - 1);
      expect(Date.now() - 1).toBeLessThan(twoExpiration);
      expect(three.attempts).toHaveLength(1);
    });

    it("should extend an unexpired lock", async () => {
      dependsOnPreviousTest(three);
      const threeExpires = three.expiration;
      four = await three.extend(800);
      expect(four.expiration).toBeGreaterThan(Date.now() - 1);
      expect(four.attempts).toHaveLength(1);
      expect(four.expiration).toBeGreaterThan(threeExpires);
    });

    it("should fail after the maximum retry count is exceeded", async () => {
      dependsOnPreviousTest(four);
      try {
        await redlock.acquire(resources, 200);
        fail("should throw");
      } catch (err) {
        // TODO: ResourceLockedError?
        expect(err).toBeInstanceOf(ExecutionError);
        expect(err.attempts).toHaveLength(3);
      }
    });

    it("should fail to extend an expired lock", async () => {
      dependsOnPreviousTest(four);
      await sleep(four.expiration - Date.now() + 100);
      try {
        await three.extend(800);
        fail("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ExecutionError);
        expect(err.attempts).toHaveLength(0);
      }
    });

    it("should issue another lock immediately after a resource is expired", async () => {
      dependsOnPreviousTest(four);
      const lock = await redlock.acquire(resources, 800);
      try {
        expect(lock.expiration).toBeGreaterThanOrEqual(Date.now());
        expect(lock.attempts).toHaveLength(1);
      } finally {
        await lock.release();
      }
    });

    it("should lock a resource with additional options", async () => {
      const lock = await redlock.acquire(resources, 200, {
        retryCount: 10,
        retryDelay: 1,
      });
      try {
        expect(lock.expiration).toBeGreaterThanOrEqual(Date.now());
        expect(lock.attempts).toHaveLength(1);
        // TODO: we don't actually check it looked at the options
        // TODO: old tests did: assert.equal(lock.attemptsRemaining, 9);
      } finally {
        await lock.release();
      }
    });

    afterAll(async () => {
      for (const client of clients) {
        for (const resource of resources) {
          await client.del(resource);
        }
      }
    });

    afterAll(async () => {
      await redlock?.quit();
    });

    afterAll(async () => {
      for (const client of clients) {
        void client.quit().catch(() => {});
      }
    });
  });
}

function dependsOnPreviousTest<T>(token: T | undefined): asserts token is T {
  if (!token) throw new Error("this test depends on the previous test");
}

async function acquirePrinting(
  redlock: Redlock,
  resource: string[],
  duration: number
) {
  try {
    return await redlock.acquire(resource, duration);
  } catch (err) {
    if (err instanceof ExecutionError) {
      (err as any).message += inspect(
        (await Promise.all(err.attempts)).map((e) => e.votesAgainst)
      );
    }
    throw err;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkRedisIsUp(client: Redis) {
  const throwIt = (err: Error) => {
    throw err;
  };
  client.on("error", throwIt);
  const infoPromise = client.info();
  if (typeof (await Promise.race([infoPromise, sleep(1500)])) !== "string") {
    throw new Error(
      `client unable to connect to redis: ${client.options.port}`
    );
  }
  client.removeListener("error", throwIt);
}
