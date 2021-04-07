import Client from "ioredis";
import Redlock from "../src/redlock";

import { redises } from "./redis-configs";

const redis = new Client(redises["redis_single_instance"]);

test("acquires a single lock", async () => {
  const redlock = new Redlock([redis]);
  const lock = await redlock.acquire(["a"], Number.MAX_SAFE_INTEGER);
  await lock.release();
});

afterAll(() => {
  redis.disconnect();
});
