# 0.4.1

No code changes.

- Fix "engine" field in package.json to match what our TypeScript outputs.

# 0.4 (2022/02/13)

Some significant changes were required to support [V4 of the standard node redis library](https://github.com/redis/node-redis/blob/master/CHANGELOG.md#v400---24-nov-2021). This new version has an API that now differs significantly from IORedis.

- Updated all dependencies to latest versions.
- Changed underlying implementation to support both clients by wrapping them in private classes.
- `RedisRateLimiter` now detects which client type it is passed.
- For added safety, use new `NodeRedisRateLimiter` or `IORedisRateLimiter` classes, which do not attempt to detect client type.
- Tests now don't mock time. It turns out this wasn't needed.

# 0.3 (2022/09/13)

No significant major changes.

- Bug fix for `wouldLimit` method [PR](https://github.com/peterkhayes/rolling-rate-limiter/pull/68)
- Updated dependencies
- Changed CI-tested Node and Redis versions
- Created changelog

# 0.2 (2020/08/31)

The method of operation remains the same, but the API has changed. A short summary of the changes:

- Library was rewritten in Typescript.
- Rate limiters are now instances of a `RateLimiter` class.
- Methods now use promises instead of callbacks.
- A `wouldLimit` method is now available to see if an action would be blocked, without actually "counting" it as an action.
- `limitWithInfo` and `wouldLimitWithInfo` methods are available to return more information about how and why an action was blocked or not blocked.
- Tests were rewritten in Jest, and run on both `redis` and `ioredis` clients.
