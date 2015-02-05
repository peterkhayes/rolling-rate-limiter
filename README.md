# Rolling Rate Limiter
[![Build Status](https://travis-ci.org/classdojo/rolling-rate-limiter.svg?branch=master)](https://travis-ci.org/classdojo/rolling-rate-limiter)

## Description
This is an implementation of a rate limiter in node.js that allows for rate limiting with a rolling window.  This means that if a user is allowed 5 actions per 60 seconds, any action will be blocked if 5 actions have already occured in the preceeding 60 seconds, without any set points at which this interval resets.  This contrasts with many existing implementations, in which a user could make 5 requests at 0:59 and another 5 requests at 1:01.  The implementation uses what I believe to be a novel algorithm, using sorted sets.

## Method of operation
  * Users are namespaced by an identifier, which is combined with a rate limiter namespace to form unique keys in redis.
  * Each key corresponds to a sorted set.  The keys and values are both set to the (microsecond) times at which actions were attempted.
  * When a new action comes in, all elements in the set with keys less than (now - rate limit window) are dropped.
  * If there are still (limit) actions in the set, the current action is blocked.
  * If the most recent previous key is too close to the current time, and a minimum difference has been set, the current action is blocked.
  * The current action is added to the set.
  * __Note__: if an action is blocked, it is still added to the set.
  * All redis operations are performed as an atomic transaction.

## Examples

### In memory
```javascript
  
  var RateLimiter = require("rolling-rate-limiter");

  var limiter = RateLimiter({
    interval: 1000 // in miliseconds
    maxInInterval: 10
    minDifference: 100 // optional, in miliseconds
  });

  limiter("user1234", function(err, success) {
    // errors if redis connection failed, etc
    if (err) throw err;

    if (success) {
      // limit was not exceeded, action should be allowed
    } else {
      // limit was exceeded, action should not be allowed
    }
  });

```

### With a redis instance
This allows multiple processes (e.g. multiple instances of a server application) to use a single redis to share rate limiter state.
```javascript
  
  var RateLimiter = require("rolling-rate-limiter");
  var Redis = require("redis");
  var client = Redis.createClient(config);

  var limiter = RateLimiter({
    redis: client,
    namespace: "UserLoginLimiter" // optional, allows one redis instance to handle multiple rate limiters
    interval: 1000 // in miliseconds
    maxInInterval: 10
    minDifference: 100 // optional, in miliseconds
  });

  limiter("user1234", function(err, success) {
    // errors if redis connection failed, etc
    if (err) throw err;

    if (success) {
      // limit was not exceeded, action should be allowed
    } else {
      // limit was exceeded, action should not be allowed
    }
  });

```
