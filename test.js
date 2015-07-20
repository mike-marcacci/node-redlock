'use strict';

var assert = require('chai').assert;
var Redlock = require('./redlock');

test('node-redis', [require('redis').createClient('6379', '192.168.59.103')]);
test('ioredis', [new (require('ioredis'))('6379', '192.168.59.103')]);

function test(name, clients){
	var redlock = new Redlock(clients, {
		retryCount: 2,
		retryDelay: 150
	});

	var resource = 'Redlock:test:resource';

	describe('Redlock: ' + name, function(){

		before(function(done){
			var err;
			var l = clients.length; function cb(e){ if(e) err = e; l--; if(l === 0) done(err); }
			for (var i = clients.length - 1; i >= 0; i--) {
				clients[i].del(resource, cb);
			}
		});

		it('should throw an error if not passed any clients', function(){
			assert.throws(function(){
				new Redlock([], {
					retryCount: 2,
					retryDelay: 150
				});
			});
		});

		var one;
		it('should lock a resource', function(done){
			redlock.lock(resource, 200, function(err, lock){
				if(err) throw err;
				assert.isObject(lock);
				assert.isAbove(lock.expiration, Date.now()-1);
				one = lock;
				done();
			});
		});

		var two;
		var two_expiration;
		it('should wait until a lock expires before issuing another lock', function(done){
			assert(one, 'Could not run because a required previous test failed.');
			redlock.lock(resource, 800, function(err, lock){
				if(err) throw err;
				assert.isObject(lock);
				assert.isAbove(lock.expiration, Date.now()-1);
				assert.isAbove(Date.now()+1, one.expiration);
				two = lock;
				two_expiration = lock.expiration;
				done();
			});
		});

		it('should unlock a resource', function(done){
			assert(two, 'Could not run because a required previous test failed.');
			two.unlock(done);
		});

		it('should silently fail to unlock an already-unlocked resource', function(done){
			assert(two, 'Could not run because a required previous test failed.');
			two.unlock(done);
		});

		it('should fail to extend a lock on an already-unlocked resource', function(done){
			assert(two, 'Could not run because a required previous test failed.');
			two.extend(200, function(err, lock){
				assert.isNotNull(err);
				assert.equal(err.name, 'LockError');
				done();
			});
		});

		var three;
		it('should issue another lock immediately after a resource is unlocked', function(done){
			assert(two_expiration, 'Could not run because a required previous test failed.');
			redlock.lock(resource, 800, function(err, lock){
				if(err) throw err;
				assert.isObject(lock);
				assert.isAbove(lock.expiration, Date.now()-1);
				assert.isBelow(Date.now()-1, two_expiration);
				three = lock;
				done();
			});
		});

		var four;
		it('should extend an unexpired lock', function(done){
			assert(three, 'Could not run because a required previous test failed.');
			three.extend(800, function(err, lock){
				if(err) throw err;
				assert.isObject(lock);
				assert.isAbove(lock.expiration, Date.now()-1);
				assert.isAbove(lock.expiration, three.expiration-1);
				four = lock;
				done();
			});
		});

		it('should fail after the maximum retry count is exceeded', function(done){
			assert(four, 'Could not run because a required previous test failed.');
			redlock.lock(resource, 200, function(err, lock){
				assert.isNotNull(err);
				assert.equal(err.name, 'LockError');
				done();
			});
		});

		it('should fail to extend an expired lock', function(done){
			assert(four, 'Could not run because a required previous test failed.');
			setTimeout(function(){
				three.extend(800, function(err, lock){
					assert.isNotNull(err);
					assert.equal(err.name, 'LockError');
					done();
				});
			}, four.expiration - Date.now() + 100);
		});

		it('should issue another lock immediately after a resource is expired', function(done){
			assert(four, 'Could not run because a required previous test failed.');
			redlock.lock(resource, 800, function(err, lock){
				if(err) throw err;
				assert.isObject(lock);
				assert.isAbove(lock.expiration, Date.now()-1);
				done();
			});
		});

		after(function(done){
			var err;
			var l = clients.length; function cb(e){ if(e) err = e; l--; if(l === 0) done(err); }
			for (var i = clients.length - 1; i >= 0; i--) {
				clients[i].del(resource, cb);
			}
		});
	});
}