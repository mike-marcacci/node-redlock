[![Continuous Integration](https://github.com/mike-marcacci/node-redlock/workflows/Continuous%20Integration/badge.svg)](https://github.com/mike-marcacci/node-redlock/actions/workflows/ci.yml?query=branch%3Amain++)
[![Current Version](https://badgen.net/npm/v/redlock)](https://npm.im/redlock)
[![Supported Node.js Versions](https://badgen.net/npm/node/redlock)](https://npm.im/redlock)

# Redlock

This is a node.js implementation of the [redlock](http://redis.io/topics/distlock) algorithm for distributed redis locks. It provides strong guarantees in both single-redis and multi-redis environments, and provides fault tolerance through use of multiple independent redis instances or clusters.

- [Installation](#installation)
- [Usage](#usage)
- [Error Handling](#error-handling)
- [API](#api)
- [Guidance](#guidance)

## Installation

```bash
npm install --save redlock
```

## Configuration

Redlock is designed to use [ioredis](https://github.com/luin/ioredis) to keep its client connections and handle the cluster protocols.

A redlock object is instantiated with an array of at least one redis client and an optional `options` object. Properties of the Redlock object should NOT be changed after it is first used, as doing so could have unintended consequences for live locks.

```ts
import Client from "ioredis";
import Redlock from "./redlock";

const redisA = new Client({ host: "a.redis.example.com" });
const redisB = new Client({ host: "b.redis.example.com" });
const redisC = new Client({ host: "c.redis.example.com" });

const redlock = new Redlock(
  // You should have one client for each independent redis node
  // or cluster.
  [redisA, redisB, redisC],
  {
    // The expected clock drift; for more details see:
    // http://redis.io/topics/distlock
    driftFactor: 0.01, // multiplied by lock ttl to determine drift time

    // The max number of times Redlock will attempt to lock a resource
    // before erroring.
    retryCount: 10,

    // the time in ms between attempts
    retryDelay: 200, // time in ms

    // the max time in ms randomly added to retries
    // to improve performance under high contention
    // see https://www.awsarchitectureblog.com/2015/03/backoff.html
    retryJitter: 200, // time in ms

    // The minimum remaining time on a lock before an extension is automatically
    // attempted with the `using` API.
    automaticExtensionThreshold: 500, // time in ms
  }
);
```

## Usage

The `using` method wraps and executes a routine in the context of an auto-extending lock, returning a promise of the routine's value. In the case that auto-extension fails, an AbortSignal will be updated to indicate that abortion of the routine is in order, and to pass along the encountered error.

The first parameter is an array of resources to lock; the second is the requested lock duration in milliseconds, which MUST NOT contain values after the decimal.

```ts
await redlock.using([senderId, recipientId], 5000, async (signal) => {
  // Do something...
  await something();

  // Make sure any attempted lock extension has not failed.
  if (signal.aborted) {
    throw signal.error;
  }

  // Do something else...
  await somethingElse();
});
```

Alternatively, locks can be acquired and released directly:

```ts
// Acquire a lock.
let lock = await redlock.acquire(["a"], 5000);
try {
  // Do something...
  await something();

  // Extend the lock.
  lock = await lock.extend(5000);

  // Do something else...
  await somethingElse();
} finally {
  // Release the lock.
  await lock.release();
}
```

### Use in CommonJS Projects

Beginning in version 5, this package is published primarily as an ECMAScript module. While this is universally accepted as the format of the future, there remain some interoperability quirks when used in CommonJS node applications. For major version 5, this package **also** distributes a copy transpiled to CommonJS. Please ensure that your project either uses either the ECMAScript or CommonJS version **but NOT both**.

The `Redlock` class is published as the "default" export, and can be imported with:

```ts
const { default: Redlock } = require("redlock");
```

In version 6, this package will stop distributing the CommonJS version.

## Error Handling

Because redlock is designed for high availability, it does not care if a minority of redis instances/clusters fail at an operation.

However, it can be helpful to monitor and log such cases. Redlock emits an "error" event whenever it encounters an error, even if the error is ignored in its normal operation.

```ts
redlock.on("error", (error) => {
  // Ignore cases where a resource is explicitly marked as locked on a client.
  if (error instanceof ResourceLockedError) {
    return;
  }

  // Log all other errors.
  console.error(error);
});
```

Additionally, a per-attempt and per-client stats (including errors) are made available on the `attempt` propert of both `Lock` and `ExecutionError` classes.

## API

Please view the (very concise) source code or TypeScript definitions for a detailed breakdown of the API.

## Guidance

### Contributing

Please see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for information on developing, running, and testing this library.

### High-Availability Recommendations

- Use at least 3 independent servers or clusters
- Use an odd number of independent redis **_servers_** for most installations
- Use an odd number of independent redis **_clusters_** for massive installations
- When possible, distribute redis nodes across different physical machines

### Using Cluster/Sentinel

**_Please make sure to use a client with built-in cluster support, such as [ioredis](https://github.com/luin/ioredis)._**

It is completely possible to use a _single_ redis cluster or sentinal configuration by passing one preconfigured client to redlock. While you do gain high availability and vastly increased throughput under this scheme, the failure modes are a bit different, and it becomes theoretically possible that a lock is acquired twice:

Assume you are using eventually-consistent redis replication, and you acquire a lock for a resource. Immediately after acquiring your lock, the redis master for that shard crashes. Redis does its thing and fails over to the slave which hasn't yet synced your lock. If another process attempts to acquire a lock for the same resource, it will succeed!

This is why redlock allows you to specify multiple independent nodes/clusters: by requiring consensus between them, we can safely take out or fail-over a minority of nodes without invalidating active locks.

To learn more about the the algorithm, check out the [redis distlock page](http://redis.io/topics/distlock).

Also note that when acquiring a lock on multiple resources, commands are executed in a single call to redis. Redis clusters require that all keys exist in a command belong to the same node. **If you are using a redis cluster or clusters and need to lock multiple resources together you MUST use [redis hash tags](https://redis.io/topics/cluster-spec#keys-hash-tags) (ie. use `ignored{considered}ignored{ignored}` notation in resource strings) to ensure that all keys resolve to the same node.** Chosing what data to include must be done thoughtfully, because representing the same conceptual resource in more than one way defeats the purpose of acquiring a lock. Accordingly, it's generally wise to use a single very generic prefix to ensure that ALL lock keys resolve to the same node, such as `{redlock}my_resource`. This is the most straightforward strategy and may be appropriate when the cluster has additional purposes. However, when locks will always naturally share a common attribute (for example, an organization/tenant ID), this may be used for better key distribution and cluster utilization. You can also acheive ideal utilization by completely omiting a hash tag if you do _not_ need to lock multiple resources at the same time.

### How do I check if something is locked?

The purpose of redlock is to provide exclusivity guarantees on a resource over a duration of time, and is not designed to report the ownership status of a resource. For example, if you are on the smaller side of a network partition you will fail to acquire a lock, but you don't know if the lock exists on the other side; all you know is that you can't guarantee exclusivity on yours. This is further complicated by retry behavior, and even moreso when acquiring a lock on more than one resource.

That said, for many tasks it's sufficient to attempt a lock with `retryCount=0`, and treat a failure as the resource being "locked" or (more correctly) "unavailable".

Note that with `retryCount=-1` there will be unlimited retries until the lock is aquired.
