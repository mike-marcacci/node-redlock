import test from "ava";
import Client from "ioredis";
import Redlock from "./redlock";

const redis = new Client({ host: "redis_single_instance" });

test("acquires a single lock", async (t) => {
	const redlock = new Redlock([redis]);
	const lock = await redlock.acquire(["a"], Number.MAX_SAFE_INTEGER);
	await lock.release();
});
