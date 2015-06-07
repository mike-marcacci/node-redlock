[![Build Status](https://travis-ci.org/mike-marcacci/node-redlock.svg)](https://travis-ci.org/mike-marcacci/node-redlock)
[![Coverage Status](https://coveralls.io/repos/mike-marcacci/node-redlock/badge.svg)](https://coveralls.io/r/mike-marcacci/node-redlock)

Redlock
=======
This is a node.js implementation of the [redlock](http://redis.io/topics/distlock) algorithm for distributed redis locks. It provides strong guarantees in both single-redis and clustered redis environments, and is fault tolerant in the latter.

Installation
------------
```bash
npm install --save redlock
```

Configuration
-------------
Redlock can use [node redis](https://github.com/mranney/node_redis) or any compatible redis library to keep its client connections.

A redlock object is instantiated with a required `options` parameter and at least one redis client parameter. Properties of the Redlock object should **NOT** be changed after it is first used, as doing so could have unintended consequences for currently-processing locks.

```js
var client1 = require('redis').createClient(6379, 'redis1.example.com');
var client2 = require('redis').createClient(6379, 'redis2.example.com');
var Redlock = require('redlock');

var redlock = new Redlock(
	{
		// the expected clock drift; for more details
		// see http://redis.io/topics/distlock
		driftFactor: 0.01,
		
		// the max number of times Redlock will attempt
		// to lock a resource before erroring
		retryCount:  3,
		
		// the time in ms between attempts
		retryDelay:  200
	},
	
	// you should have one client for each redis node
	// in your cluster
	client1,
	client2
);
```


Usage
-----


###Locking & Unocking

```js

// the string identifier for the resource you want to lock
var resource = 'locks:account:322456';

// the maximum amount of time you want the resource locked,
// keeping in mind that you can extend the lock up until
// the point when it expires
var ttl = 1000;

redlock.lock(resource, ttl, function(err, lock) {

	// we failed to lock the resource
	if(err) {
		// ...
	}
	
	// we have the lock
	else {


		// ...do something here...


		// unlock your resource when you are done
		lock.unlock();
	}
});

```


###Locking and Extending

```js
redlock.lock('locks:account:322456', 1000, function(err, lock) {

	// we failed to lock the resource
	if(err) {
		// ...
	}
	
	// we have the lock
	else {


		// ...do something here...


		// if you need more time, you can continue to extend
		// the lock until it expires
		lock.extend(1000, function(err, lock){

			// we failed to extend the lock on the resource
			if(err) {
				// ...
			}


			// ...do something here...


			// unlock your resource when you are done
			lock.unlock();
		}
	}
});

```

API Docs
--------

###`Redlock.lock(resource, ttl, callback)`
- `resource (string)` resource to be locked
- `ttl (number)` time in ms until the lock expires
- `callback (function)` callback returning:
	- `err (Error)`
	- `lock (Lock)`


###`Redlock.unlock(lock, callback)`
- `lock (Lock)` lock to be released
- `callback (function)` callback with no returning arguments


###`Redlock.extend(lock, ttl, callback)`
- `lock (Lock)` lock to be extended
- `ttl (number)` time in ms to extend the lock's expiration
- `callback (function)` callback returning:
	- `err (Error)`
	- `lock (Lock)`


###`Lock.unlock(callback)`
- `callback (function)` callback with no returning arguments


###`Lock.extend(ttl, callback)`
- `ttl (number)` time in ms to extend the lock's expiration
- `callback (function)` callback returning:
	- `err (Error)`
	- `lock (Lock)`

