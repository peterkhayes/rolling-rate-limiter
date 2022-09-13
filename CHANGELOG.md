
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