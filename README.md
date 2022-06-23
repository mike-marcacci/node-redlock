# Deno-Redlock

## Description
This is an implementation of the Redlock algorithm in Deno. It is a secure, lightweight solution to control resource access in distributed systems architecture.

> Distributed locks are a very useful primitive in many environments where different processes require to operate  with shared resources in a mutually exclusive way.
>
> There are a number of libraries and blog posts describing how to implement a DLM (Distributed Lock Manager) with Redis, but every library uses a different approach, and many use a simple approach with lower guarantees compared to what can be achieved with slightly more complex designs.
> 
> https://redis.io/docs/reference/patterns/distributed-locks/

## Installation
import Redlock from "https://deno.land/x/redlock/mod.ts"

## Documentation
[Deno DLM](https://denodlm.com/)

## Configuration

Instantiate a Redlock object by passing an array of at least one Redis client (for storing lock data) and an optional `options` object.
Do NOT change properties of the Redlock object after instantiation. Doing so could have unintended consequences on live locks.

```ts
import { connect } from "https://deno.land/x/redis/mod.ts"
import Redlock from "https://deno.land/x/redlock/mod.ts"

const redisA = await connect({hostname: "HostIpAddress", port: portNumber})
const redisB = await connect({hostname: "HostIpAddress", port: portNumber})
const redisC = await connect({hostname: "HostIpAddress", port: portNumber})

const redlock = new Redlock(
  // One client per each independent Redis node/cluster
  [redisA, redisB, redisC],
  {
    // The expected clock drift; for more details see:
    // http://redis.io/topics/distlock
    driftFactor: 0.01, // multiplied by lock time to live to determine drift time

    // The max number of times Redlock will attempt to lock a resource before erroring
    // setting retryCount: -1 allows for unlimited retries until the lock is acquired
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
Additionally, the Lua scripts used to acquire, extend, and release the locks may be customized on Redlock instantiation. Please view the source code if required.

## Lock Usage

The `using` method allows a routine to be executed within the context of an auto-extending lock. This method returns a promise that resolves to the routine's value. If the auto-extension fails, then the routine is aborted through the use of an AbortSignal. 

The first parameter represents an array of resources that one wishes to lock. The second parameter is the desired lock duration in milliseconds (given as an integer).

```ts
await redlock.using(["{redlock}resourceId", "{redlock}resourceId2"], 10000, async (signal) => {
  // perform some action using the locked resources...
  const resource = await getResource(resourceId);
  const resource2 = await getResource(resourceId2);

  // The abort signal will be true if:
  // 1. the above took long enough that the lock needed to be extended
  // 2. redlock was unable to extend the lock
  //
  // In such a case, exclusivity can no longer be guaranteed for further operations
  // and should be handled as an exceptional case.
  if (signal.aborted) {
    throw signal.error;
  }

  // perform other actions with the resources...
  await updateResources([
    {id: resourceId, resource: updatedResource},
    {id: resourceId2, resource: updatedResource2},
  ]);
});
```

Locks can also be acquired, extended, and released manually

```ts
// acquisition
let lock = await redlock.acquire(["exampleResourceId"], 10000);
try {
  // perform some action with locked resource...
  await action();

  // extension, which instantiates a new Lock
  lock = await lock.extend(10000);

  // perform another action...
  await anotherAction();
} finally {
  // release
  await lock.release();
}
```

Note: commands are executed in a single call to Redis. Redis clusters require that all keys in a command must hash to the same node. When acquiring a lock on multiple resources while using Redis clusters, [redis hash tags](https://redis.io/docs/reference/cluster-spec/) must be used to ensure that all keys are allocated in the same hash slot. The most straightforward strategy is to use a single generic prefix inside hash tags before listing the resource, such as `{redlock}resourceId`. This ensures that all lock keys resolve to the same node and may be appropriate when the cluster storing the lock data has additional purposes. When all resources share a common attribute (such as organizationId), this attribute can be used inside the hash tags for better key distribution and cluster utilization. If you do not need to lock multiple resources at the same time or are not using clusters, omit the hash tags to achieve ideal utilization.

## Error Handling
Redlock is designed for high availability and doesn't care if a minority of Redis instances/clusters fail at an operation. However, it may be helpful to monitor or log normal usage errors. A per-attempt and per-client stats object (including errors) is made available on the `attempts` property of both the `Lock` and `ExecutionError` classes. Additionally, Redlock emits an "error" event whenever an error is encountered, even if the error is ignored and normal operation continues.

```ts
redlock.on("error", (error) => {
  // Ignore cases where a resource is explicitly marked as locked on a client
  if (error instanceof ResourceLockedError) {
    return;
  }
  
  // Log all other errors
  console.error(error);
});
```

## Disclaimer

This code implements an algorithm which is currently a proposal and was not formally analyzed. Make sure to understand how it works before using it in your production environments.

See Martin Kleppmann's [analysis](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) and Salvatore Sanfilippo's [counterpoint](http://antirez.com/news/101) to this analysis.


#### A note about time:
Redis and Deno-Redlock utilize a monotonic time API to prevent errors due to random time jumps that are possible with a poorly maintained GPS time API.

## The Development Team
- Cody Schexnider [LinkedIn](https://www.linkedin.com/in/cody-schexnider-2402701a3/) [GitHub](https://github.com/cdschexnide)
- Michael Watson [LinkedIn](https://www.linkedin.com/in/mdwatson988/) [GitHub](https://github.com/mdwatson988)
- Jiayi Zhang [LinkedIn](https://www.linkedin.com/in/jiayi-zhang-87819173/) [GitHub](https://github.com/onlinezyc)
- Anna Shen [LinkedIn](https://www.linkedin.com/in/ashen0426/) [GitHub](https://github.com/ashen0426)

## Contributing

1. [Fork it](https://github.com/oslabs-beta/Deno-Redlock)
2. Create your feature branch (`git checkout -b your-new-feature`)
3. Commit your changes (`git commit -am 'feature-added'`)
4. Push to the branch (`git push origin your-new-feature`)
5. Create a new Pull Request


## Credit
Big thanks to [Mike Marcacci](https://github.com/mike-marcacci) for the [Node.js implementation](https://github.com/mike-marcacci/node-redlock) of the Redlock algorithm.
