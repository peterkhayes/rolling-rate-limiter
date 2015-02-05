# Rolling Rate Limiter
[![Build Status](https://travis-ci.org/classdojo/rolling-rate-limiter.svg?branch=master)](https://travis-ci.org/classdojo/rolling-rate-limiter)

## Description
This is an implementation of a rate limiter in node.js that allows for rate limiting with a rolling window.  This means that if a user is allowed 5 actions per 60 seconds, any action will be blocked if 5 actions have already occured in the preceeding 60 seconds, without any set points at which this interval resets.  This contrasts with many existing implementations, in which a user could make 5 requests at 0:59 and another 5 requests at 1:01.  The implementation uses what I believe to be a novel algorithm, using sorted sets.  It can use either in-memory storage or Redis as a backend.

## Examples

### In memory
```javascript
  
  var RateLimiter = require("rolling-rate-limiter");

  var limiter = RateLimiter({
    interval: 1000 // in miliseconds
    maxInInterval: 10
    minDifference: 100 // optional: the minimum time (in miliseconds) between any two actions
  });

  // First argument should be a unique identifier for a user.
  // If the limiter does not differentiate between users, pass only a callback.
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

### With a redis backend
This allows multiple processes (e.g. multiple instances of a server application) to use a single redis to share rate limiter state.  Make sure that the limiters have identical configurations in each instance.
```javascript
  
  var RateLimiter = require("rolling-rate-limiter");
  var Redis = require("redis");
  var client = Redis.createClient(config);

  var limiter = RateLimiter({
    redis: client,
    namespace: "UserLoginLimiter" // optional: allows one redis instance to handle multiple groups of rate limiters. defaults to "rate-limiter-{string of random characters}"
    interval: 1000
    maxInInterval: 10
    minDifference: 100
  });

  // operation same as above.

```

## Method of operation
  * Each key corresponds to a sorted set.  The keys and values are both set to the (microsecond) times at which actions were attempted.
  * When a new action comes in, all elements in the set with keys less than (now - rate limit window) are dropped.
  * If there are still (limit) actions in the set, the current action is blocked.
  * If the most recent previous key is too close to the current time, and a minimum difference has been set, the current action is blocked.
  * The current action is added to the set.
  * __Note__: if an action is blocked, it is still added to the set.  This means that if a user is continually attempting actions more quickly than the allowed rate, __all__ of their actions will be blocked until.
  * If the limiter uses a redis instance, identifiers can be namespaced by an identifier, which is combined with a rate limiter namespace to form unique keys.
  * All redis operations for a single rate-limit check are performed as an atomic transaction.
