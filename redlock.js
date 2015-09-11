'use strict';

var util         = require('util');
var Promise      = require('bluebird');
var EventEmitter = require('events');

// support the event library provided by node < 0.11.0
if(typeof EventEmitter.EventEmitter === 'function')
	EventEmitter = EventEmitter.EventEmitter;


// constants
var unlockScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
var extendScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

// defaults
var defaults = {
	driftFactor: 0.01,
	retryCount:  3,
	retryDelay:  200
};





// LockError
// ---------
// This error is returned when there is an error locking a resource.
function LockError(message) {
	Error.call(this);
	Error.captureStackTrace(this, LockError);
	this.name = 'LockError';
	this.message = message || 'Failed to lock the resource.';
}

util.inherits(LockError, Error);






// Lock
// ----
// An object of this type is returned when a resource is successfully locked. It contains
// convenience methods `unlock` and `extend` which perform the associated Redlock method on
// itself.
function Lock(redlock, resource, value, expiration) {
	this.redlock    = redlock;
	this.resource   = resource;
	this.value      = value;
	this.expiration = expiration;
}

Lock.prototype.unlock = function unlock(callback) {
	return this.redlock.unlock(this, callback);
};

Lock.prototype.extend = function extend(ttl, callback) {
	return this.redlock.extend(this, ttl, callback);
};






// Redlock
// -------
// A redlock object is instantiated with an array of at least one redis client and an optional
// `options` object. Properties of the Redlock object should NOT be changed after it is first
// used, as doing so could have unintended consequences for live locks.
function Redlock(clients, options) {
	// set default options
	options = options || {};
	this.driftFactor = typeof options.driftFactor === 'number' ? options.driftFactor : defaults.driftFactor;
	this.retryCount  = typeof options.retryCount  === 'number' ? options.retryCount  : defaults.retryCount;
	this.retryDelay  = typeof options.retryDelay  === 'number' ? options.retryDelay  : defaults.retryDelay;

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
Redlock.prototype.disposer = function disposer(resource, ttl) {
	return this._lock(resource, null, ttl).disposer(function(lock){ return lock.unlock(); });
};


// unlock
// ------
// This method unlocks the provided lock from all servers still persisting it. This is a
// best-effort attempt and as such fails silently.
Redlock.prototype.release =
Redlock.prototype.unlock = function unlock(lock, callback) {
	var self = this;
	return new Promise(function(resolve, reject) {

		// the lock has expired
		if(lock.expiration < Date.now()) {
			return resolve();
		}

		// invalidate the lock
		lock.expiration = 0;

		// the number of async redis calls still waiting to finish
		var waiting = self.servers.length;

		// release the lock on each server
		self.servers.forEach(function(server){
			server.eval(unlockScript, 1, lock.resource, lock.value, loop);
		});

		function loop(err, response) {
			if(err) self.emit('clientError', err);
			if(waiting-- > 1) return;
			return resolve();
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
		return Promise.reject(new LockError('Cannot extend lock on resource "' + lock.resource + '" because the lock has already expired.')).nodeify(callback);

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
				return server.set(resource, value, 'NX', 'PX', ttl, loop);
			};
		}

		// extend an existing lock
		else {
			request = function(server, loop){
				return server.eval(extendScript, 1, resource, value, ttl, loop);
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
				var lock = new Lock(self, resource, value, start + ttl - drift);

				// SUCCESS: there is concensus and the lock is not expired
				if(votes >= quorum && lock.expiration > Date.now())
					return resolve(lock);


				// remove this lock from servers that voted for it
				return lock.unlock(function(){

					// RETRY
					if(attempts <= self.retryCount)
						return setTimeout(attempt, self.retryDelay);

					// FAILED
					return reject(new LockError('Exceeded ' + self.retryCount + ' attempts to lock the resource "' + resource + '".'));
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
	return Math.random().toString(36).slice(2);
};


module.exports = Redlock;
