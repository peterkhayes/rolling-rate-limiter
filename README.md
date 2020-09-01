# Rolling Rate Limiter

This is an implementation of a rate limiter in node.js that allows for rate limiting with a rolling window. It can use either in-memory storage or Redis as a backend.  If Redis is used, multiple rate limiters can share one instance with different namespaces, and multiple processes can share rate limiter state safely.

This means that if a user is allowed 5 actions per 60 seconds, any action will be blocked if 5 actions have already occured in the preceeding 60 seconds, without any set points at which this interval resets.  This contrasts with some other rate limiter implementations, in which a user could make 5 requests at 0:59 and another 5 requests at 1:01.  

**Important Note**:
As a consequence of the way the Redis algorithm works, if an action is blocked, it is still "counted". This means that if a user is continually attempting actions more quickly than the allowed rate, __all__ of their actions will be blocked until they pause or slow their requests.

This behavior is somewhat counterintuitive, but it's the only way that I have found that uses an atomic `MULTI` set of commands for Redis. Without this, race conditions would be possible. [See more below.](#method-of-operation).

## Quick start
Basic use in an Express application.

```javascript
const { RedisRateLimiter } = require('rolling-rate-limiter');

const limiter = new RedisRateLimiter({
  client: redisClient, // client instance from `redis` or `ioredis`
  namespace: 'rate-limiter', // prefix for redis keys
  interval: 60000, // milliseconds
  maxInInterval: 10,
});

app.use(function(req, res, next) {
  limiter.limit(req.ipAddress).then((wasBlocked) => {
    if (wasBlocked) {
      return res.status(429).send("Too many requests");
    } else {
      return next();
    }
  })
});
```

## Available limiters
* `RedisRateLimiter` - Stores state in Redis. Can use `redis` or `ioredis` clients.
* `InMemoryRateLimiter` - Stores state in memory. Useful in testing or outside of web servers.

## Configuration options
* `interval: number` - The length of the rate limiter's interval, in milliseconds. For example, if you want a user to be able to perform 5 actions per minute, this should be `60000`.
* `maxInInterval: number` - The number of actions allowed in each interval. For example, in the scenario above, this would be `5`
* `minDifference?: number` - Optional. The minimum time allowed between consecutive actions, in milliseconds.
* `client: Client` (Redis only) - The Redis client to use.
* `namespace: string` (Redis only) - A string to prepend to all keys to prevent conflicts with other code using Redis.

## Instance Methods
All methods take an `Id`, which should be of type `number | string`. Commonly, this will be a user's id.

* `limit(id: Id): Promise<boolean>` - Attempt to perform an action. Returns `false` if the action should be allowed, and `true` if the action should be blocked.
* `wouldLimit(id: Id): Promise<boolean>` - Return what would happen if an action were attempted. Returns `false` if an action would not have been blocked, and `true` if an action would have been blocked. Does not "count" as an action.
* `limitWithInfo(id: Id): Promise<RateLimitInfo>` - Attempt to perform an action. Returns whether the action should be blocked, as well as additional information about why it was blocked and how long the user must wait.
* `wouldLimitWithInfo(id: Id): Promise<RateLimitInfo>` - Returns info about what would happened if an action were attempted and why. Does not "count" as an action.

`RateLimitInfo` contains the following properties:
* `blocked: boolean` - Whether the action was blocked (or would have been blocked).
* `blockedDueToCount: boolean` - Whether the action was blocked (or would have been blocked) because of the `interval` and `maxInInterval` properties.
* `blockedDueToMinDifference: boolean` - Whether the action was blocked (or would have been blocked) because of the `minDistance` property.
* `millisecondsUntilAllowed: number` - The number of milliseconds the user must wait until they can make another action. If another action would immediately be permitted, this is `0`.
* `actionsRemaining: number` - The number of actions a user has left within the interval. Does not account for `minDifference`.

## Method of operation
* Each identifier/user corresponds to a _sorted set_ data structure.  The keys and values are both equal to the (microsecond) times at which actions were attempted, allowing easy manipulation of this list.
* When a new action comes in for a user, all elements in the set that occurred earlier than (current time - interval) are dropped from the set. 
* If the number of elements in the set is still greater than the maximum, the current action is blocked.
* If a minimum difference has been set and the most recent previous element is too close to the current time, the current action is blocked.
* The current action is then added to the set.
* _Note_: if an action is blocked, it is still added to the set. This means that if a user is continually attempting actions more quickly than the allowed rate, _all_ of their actions will be blocked until they pause or slow their requests.
* If the limiter uses a redis instance, the keys are prefixed with namespace, allowing a single redis instance to support separate rate limiters.
* All redis operations for a single rate-limit check/update are performed as an atomic transaction, allowing rate limiters running on separate processes or machines to share state safely.
