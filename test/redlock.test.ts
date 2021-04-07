import { inspect } from "util";

import Client from "ioredis";

import Redlock, { ExecutionError, Lock } from "../src/redlock";
import { redises } from "./redis-configs";

jest.setTimeout(1900909);
const redis = new Client(redises["redis_single_instance"]);

const settings = {
  retryCount: 2,
  retryDelay: 150,
  retryJitter: 50,
} as const;

test("acquires a single lock", async () => {
  const redlock = new Redlock([redis]);
  const lock = await redlock.acquire(["a"], Number.MAX_SAFE_INTEGER);
  await lock.release();
});

describe("awaiting expiration", () => {
  const resource = "tests-redlock:resource:expiration";

  let redlock: Redlock;

  let one: Lock;
  let two: Lock;
  let twoExpiration: number;
  let three: Lock;
  let four: Lock;

  beforeAll(() => {
    redlock = new Redlock([redis], settings);
  });

  it("should lock a resource", async () => {
    one = await redlock.acquire([resource], 200);
    expect(one).toBeInstanceOf(Lock);
    expect(one.expiration).toBeGreaterThan(Date.now() - 1);
    expect(one.attempts).toHaveLength(1);
  });

  it("should wait until a lock expires before issuing another lock", async () => {
    dependsOnPreviousTest(one);

    two = await acquirePrinting(redlock, [resource], 800);
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
    three = await redlock.acquire([resource], 800);
    expect(three.expiration).toBeGreaterThan(Date.now() - 1);
    expect(Date.now() - 1).toBeLessThan(twoExpiration);
    expect(three.attempts).toHaveLength(1);
  });

  it("should extend an unexpired lock", async () => {
    dependsOnPreviousTest(three);
    four = await three.extend(800);
    expect(four.expiration).toBeGreaterThan(Date.now() - 1);
    expect(four.attempts).toHaveLength(1);

    // TODO: three's expiration has been cleared
    expect(four.expiration).toBeGreaterThan(three.expiration - 1);
    expect(four).toBe(three);
  });

  afterAll(async () => {
    await redlock.quit();
  });
});

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

afterAll(() => {
  redis.disconnect();
});
