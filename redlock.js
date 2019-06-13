'use strict';

var util         = require('util');
var crypto       = require('crypto');
var Promise      = require('bluebird');
var EventEmitter = require('events');

// support the event library provided by node < 0.11.0
if(typeof EventEmitter.EventEmitter === 'function')
	EventEmitter = EventEmitter.EventEmitter;


// constants
var lockScript = 'return redis.call("set", KEYS[1], ARGV[1], "NX", "PX", ARGV[2])';
var unlockScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
var extendScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

// simplified algorithm:
// - check does any key already exists - if it does return nil (keeping compatibility with "set nx" and string_numbers option)
// - set all keys
// - if any key set fails delete keys which were set successfully and return nil
// - if everything goes well return ok(1)
var multiValueLockScript = 'local keyExists = 0; for i, key in ipairs(KEYS) do if redis.pcall("EXISTS", key) == 1 then keyExists=1 break end end if keyExists == 1 then return nil end; local addedKeys={}; local addFailed=0; for i, key in ipairs(KEYS) do if not redis.pcall("SET", key, ARGV[1], "NX", "PX", ARGV[2]) then addFailed=1; break end; table.insert(addedKeys, key); end if addFailed == 1 then for i, addedKey in ipairs(addedKeys) do redis.pcall("DEL", addedKey) end return nil end return 1';
// simplified algorithm:
// - check do all keys exist - if any of them is missing return error(0)
// - delete all keys
// - return ok(1)
var multiValueUnlockScript = 'local keyMissing = 0; for i, key in ipairs(KEYS) do if redis.pcall("GET", key) ~= ARGV[1] then keyMissing=1 break end end if keyMissing == 1 then return 0 end; local deleteFailed=0; for i, key in ipairs(KEYS) do if not redis.pcall("DEL", key) then deleteFailed=1; end; end; if deleteFailed == 1 then return 0 end return 1';
// simplified algorithm:
// - check do all keys exist - if any of them is missing return error(0)
// - extend all keys
// - if extend fails for any key return error(0)
// - if extend succeeds for all keys return ok(1)
var multiValueExtendScript = 'local keyMissing = 0; for i, key in ipairs(KEYS) do if redis.pcall("EXISTS", key) == 0 then keyMissing = 1 break end end if keyMissing == 1 then return 0 end; local extendFailed = 0; for i, key in ipairs(KEYS) do if not redis.pcall("PEXPIRE", key, ARGV[2]) then extendFailed = 1; break end; end; if extendFailed == 1 then return 0 end return 1';

// defaults
var defaults = {
	driftFactor: 0.01,
	retryCount:  10,
	retryDelay:  200,
	retryJitter: 100
};





// LockError
// ---------
// This error is returned when there is an error locking a resource.
function LockError(message, attempts) {
	Error.call(this);
	Error.captureStackTrace(this, LockError);
	this.name = 'LockError';
	this.message = message || 'Failed to lock the resource.';
	this.attempts = attempts;
}

util.inherits(LockError, Error);






// Lock
// ----
// An object of this type is returned when a resource is successfully locked. It contains
// convenience methods `unlock` and `extend` which perform the associated Redlock method on
// itself.
function Lock(redlock, resource, value, expiration, attempts) {
	this.redlock    = redlock;
	this.resource   = resource;
	this.value      = value;
	this.expiration = expiration;
	this.attempts   = attempts;
}

Lock.prototype.unlock = function unlock(callback) {
	return this.redlock.unlock(this, callback);
};

Lock.prototype.extend = function extend(ttl, callback) {
	return this.redlock.extend(this, ttl, callback);
};

// Attach a reference to Lock, which allows the application to use instanceof
// to ensure type.
Redlock.Lock = Lock;





// Redlock
// -------
// A redlock object is instantiated with an array of at least one redis client and an optional
// `options` object. Properties of the Redlock object should NOT be changed after it is first
// used, as doing so could have unintended consequences for live locks.
function Redlock(clients, options) {
	// set default options
	options = options || {};
	this.driftFactor  = typeof options.driftFactor  === 'number' ? options.driftFactor : defaults.driftFactor;
	this.retryCount   = typeof options.retryCount   === 'number' ? options.retryCount  : defaults.retryCount;
	this.retryDelay   = typeof options.retryDelay   === 'number' ? options.retryDelay  : defaults.retryDelay;
	this.retryJitter  = typeof options.retryJitter  === 'number' ? options.retryJitter : defaults.retryJitter;
	this.lockScript   = typeof options.lockScript   === 'function' ? options.lockScript(lockScript) : lockScript;
	this.unlockScript = typeof options.unlockScript === 'function' ? options.unlockScript(unlockScript) : unlockScript;
	this.extendScript = typeof options.extendScript === 'function' ? options.extendScript(extendScript) : extendScript;
	this.multiValueLockScript   = typeof options.multiValueLockScript   === 'function' ? options.multiValueLockScript(multiValueLockScript)     : multiValueLockScript;
	this.multiValueUnlockScript = typeof options.multiValueUnlockScript === 'function' ? options.multiValueUnlockScript(multiValueUnlockScript) : multiValueUnlockScript;
	this.multiValueExtendScript = typeof options.multiValueExtendScript === 'function' ? options.multiValueExtendScript(multiValueExtendScript) : multiValueExtendScript;
	// set the redis servers from additional arguments
	this.servers = clients;
	if(this.servers.length === 0)
		throw new Error('Redlock must be instantiated with at least one redis server.');
}

// Inherit all the EventEmitter methods, like `on`, and `off`
util.inherits(Redlock, EventEmitter);


// Attach a reference to LockError per issue #7, which allows the application to use instanceof
// to destinguish between error types.
Redlock.LockError = LockError;


// quit
// ----
// This method runs `.quit()` on all client connections.

Redlock.prototype.quit = function quit(callback) {

	// quit all clients
	return Promise.map(this.servers, function(client) {
		return client.quit();
	})

	// optionally run callback
	.nodeify(callback);
};


// lock
// ----
// This method locks a resource using the redlock algorithm.
//
// ```js
// redlock.lock(
//   'some-resource',       // the resource to lock
//   2000,                  // ttl in ms
//   function(err, lock) {  // callback function (optional)
//     ...
//   }
// )
// ```
Redlock.prototype.acquire =
Redlock.prototype.lock = function lock(resource, ttl, callback) {
	return this._lock(resource, null, ttl, callback);
};

// lock
// ----
// This method locks a resource using the redlock algorithm,
// and returns a bluebird disposer.
//
// ```js
// using(
//   redlock.disposer(
//     'some-resource',       // the resource to lock
//     2000                   // ttl in ms
//   ),
//   function(lock) {
//     ...
//   }
// );
// ```
Redlock.prototype.disposer = function disposer(resource, ttl, errorHandler) {
	errorHandler = errorHandler || function(err) {};
	return this._lock(resource, null, ttl).disposer(function(lock){
		return lock.unlock().catch(errorHandler);
	});
};


// unlock
// ------
// This method unlocks the provided lock from all servers still persisting it. It will fail
// with an error if it is unable to release the lock on a quorum of nodes, but will make no
// attempt to restore the lock on nodes that failed to release. It is safe to re-attempt an
// unlock or to ignore the error, as the lock will automatically expire after its timeout.
Redlock.prototype.release =
Redlock.prototype.unlock = function unlock(lock, callback) {
    var self = this;
    
	// immediately invalidate the lock
	lock.expiration = 0;

	return new Promise(function(resolve, reject) {

		// the number of servers which have agreed to release this lock
		var votes = 0;

		// the number of votes needed for consensus
		var quorum = Math.floor(self.servers.length / 2) + 1;

		// the number of async redis calls still waiting to finish
		var waiting = self.servers.length;

		// release the lock on each server
		self.servers.forEach(function(server){
            return self.isMultiResource(lock.resource) ? server.eval([multiValueUnlockScript, lock.resource.length].concat(lock.resource).concat([lock.value]), loop) : server.eval(self.unlockScript, 1, lock.resource, lock.value, loop);
		});

		function loop(err, response) {
			if(err) self.emit('clientError', err);

			// - if the lock was released by this call, it will return 1
			// - if the lock has already been released, it will return 0
			//    - it may have been re-acquired by another process
			//    - it may hava already been manually released
            //    - it may have expired
            
			if(typeof response === 'string')
				response = parseInt(response);

			if(response === 0 || response === 1)
				votes++;

			if(waiting-- > 1) return;

			// SUCCESS: there is concensus and the lock is released
			if(votes >= quorum)
				return resolve();

			// FAILURE: the lock could not be released
			return reject(new LockError('Unable to fully release the lock on resource "' + lock.resource + '".'));
		}
	})

	// optionally run callback
	.nodeify(callback);
};


// extend
// ------
// This method extends a valid lock by the provided `ttl`.
Redlock.prototype.extend = function extend(lock, ttl, callback) {
	var self = this;

	// the lock has expired
	if(lock.expiration < Date.now())
		return Promise.reject(new LockError('Cannot extend lock on resource "' + lock.resource + '" because the lock has already expired.', 0)).nodeify(callback);

	// extend the lock
	return self._lock(lock.resource, lock.value, ttl)

	// modify and return the original lock object
	.then(function(extension){
		lock.value      = extension.value;
		lock.expiration = extension.expiration;
		return lock;
	})

	// optionally run callback
	.nodeify(callback);
};


// _lock
// -----
// This method locks a resource using the redlock algorithm.
//
// ###Creating New Locks:
//
// ```js
// redlock._lock(
//   'some-resource',       // the resource to lock
//   null,                  // no original lock value
//   2000,                  // ttl in ms
//   function(err, lock) {  // callback function (optional)
//     ...
//   }
// )
// ```
//
// ###Extending Existing Locks:
//
// ```js
// redlock._lock(
//   'some-resource',       // the resource to lock
//   'dkkk18g4gy39dx6r',    // the value of the original lock
//   2000,                  // ttl in ms
//   function(err, lock) {  // callback function (optional)
//     ...
//   }
// )
// ```
Redlock.prototype._lock = function _lock(resource, value, ttl, callback) {
	var self = this;
	return new Promise(function(resolve, reject) {
		var request;

		// the number of times we have attempted this lock
		var attempts = 0;


		// create a new lock
		if(value === null) {
			value = self._random();
			request = function(server, loop){
				// alternative using spread operator [multiValueLockScript, resource.length, ...resource, value, ttl] but not supported in old js versions
                return self.isMultiResource(resource) ? server.eval([multiValueLockScript, resource.length].concat(resource).concat([value, ttl]), loop) : server.eval(self.lockScript, 1, resource, value, ttl, loop);
			};
		}

		// extend an existing lock
		else {
			request = function(server, loop){
				return self.isMultiResource(resource) ? server.eval([multiValueExtendScript, resource.length].concat(resource).concat([value, ttl]), loop) : server.eval(self.extendScript, 1, resource, value, ttl, loop);
			};
		}

		function attempt(){
			attempts++;

			// the time when this attempt started
			var start = Date.now();

			// the number of servers which have agreed to this lock
			var votes = 0;

			// the number of votes needed for consensus
			var quorum = Math.floor(self.servers.length / 2) + 1;

			// the number of async redis calls still waiting to finish
			var waiting = self.servers.length;

			function loop(err, response) {
				if(err) self.emit('clientError', err);
				if(response) votes++;
                if(waiting-- > 1) return;
                
				// Add 2 milliseconds to the drift to account for Redis expires precision, which is 1 ms,
				// plus the configured allowable drift factor
				var drift = Math.round(self.driftFactor * ttl) + 2;
                var lock = new Lock(self, resource, value, start + ttl - drift, attempts);
                
				// SUCCESS: there is concensus and the lock is not expired
				if(votes >= quorum && lock.expiration > Date.now())
					return resolve(lock);


				// remove this lock from servers that voted for it
				return lock.unlock(function(){

					// RETRY
					if(self.retryCount === -1 || attempts <= self.retryCount)
						return setTimeout(attempt, Math.max(0, self.retryDelay + Math.floor((Math.random() * 2 - 1) * self.retryJitter)));

					// FAILED
					return reject(new LockError('Exceeded ' + self.retryCount + ' attempts to lock the resource "' + resource + '".', attempts));
				});
			}

			return self.servers.forEach(function(server){
				return request(server, loop);
			});
		}

		return attempt();
	})

	// optionally run callback
	.nodeify(callback);
};


Redlock.prototype._random = function _random(){
	return crypto.randomBytes(16).toString('hex');
};

Redlock.prototype.isMultiResource = function isMultiResource(resource) {
	return Array.isArray(resource);
};

module.exports = Redlock;
