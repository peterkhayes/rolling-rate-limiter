import assert from 'assert';
import { now as getCurrentMicroseconds } from 'microtime-nodejs';
import { v4 as uuid } from 'uuid';

export type Id = number | string;
export type Seconds = number;
export type Milliseconds = number;
export type Microseconds = number;

/**
 * Generic options for constructing any rate limiter.
 * See `README.md` for more information.
 */
export interface RateLimiterOptions {
  interval: number;
  maxInInterval: number;
  minDifference?: number;
}

/**
 * Result shape returned by `limitWithInfo` and `wouldLimitWithInfo`.
 * See `README.md` for more information.
 */
export interface RateLimitInfo {
  blocked: boolean;
  blockedDueToCount: boolean;
  blockedDueToMinDifference: boolean;
  millisecondsUntilAllowed: Milliseconds;
  actionsRemaining: number;
}

/**
 * Abstract base class for rate limiters.
 */
export class RateLimiter {
  interval: number;
  maxInInterval: number;
  minDifference: number;

  constructor({ interval, maxInInterval, minDifference = 0 }: RateLimiterOptions) {
    assert(interval > 0, 'Must pass a positive integer for `options.interval`');
    assert(maxInInterval > 0, 'Must pass a positive integer for `options.maxInInterval`');
    assert(minDifference >= 0, '`options.minDifference` cannot be negative');

    this.interval = millisecondsToMicroseconds(interval);
    this.maxInInterval = maxInInterval;
    this.minDifference = millisecondsToMicroseconds(minDifference);
  }

  /**
   * Attempts an action for the provided ID. Return information about whether the action was
   * allowed and why, and whether upcoming actions will be allowed.
   */
  async limitWithInfo(id: Id): Promise<RateLimitInfo> {
    const timestamps = await this.getTimestamps(id, true);
    return this.calculateInfo(timestamps);
  }

  /**
   * Returns information about what would happen if an action were attempted for the provided ID.
   */
  async wouldLimitWithInfo(id: Id): Promise<RateLimitInfo> {
    const currentTimestamp = getCurrentMicroseconds();
    const existingTimestamps = await this.getTimestamps(id, false);
    return this.calculateInfo([...existingTimestamps, currentTimestamp]);
  }

  /**
   * Attempts an action for the provided ID. Returns whether it was blocked.
   */
  async limit(id: Id): Promise<boolean> {
    return (await this.limitWithInfo(id)).blocked;
  }

  /**
   * Returns whether an action for the provided ID would be blocked, if it were attempted.
   */
  async wouldLimit(id: Id): Promise<boolean> {
    return (await this.wouldLimitWithInfo(id)).blocked;
  }

  /**
   * Clears rate limiting state for the provided ID.
   */
  async clear(_id: Id): Promise<void> {
    return Promise.reject(new Error('Not implemented'));
  }

  /**
   * Returns the list of timestamps of actions attempted within `interval` for the provided ID. If
   * `addNewTimestamp` flag is set, adds a new action with the current microsecond timestamp.
   */
  protected async getTimestamps(
    _id: Id,
    _addNewTimestamp: boolean,
  ): Promise<Array<Microseconds>> {
    return Promise.reject(new Error('Not implemented'));
  }

  /**
   * Given a list of timestamps, computes the RateLimitingInfo. The last item in the list is the
   * timestamp of the current action.
   */
  private calculateInfo(timestamps: Array<Microseconds>): RateLimitInfo {
    const numTimestamps = timestamps.length;
    const currentTimestamp = timestamps[numTimestamps - 1];
    const previousTimestamp = timestamps[numTimestamps - 2];

    const blockedDueToCount = numTimestamps > this.maxInInterval;
    const blockedDueToMinDifference =
      previousTimestamp != null &&
      currentTimestamp - previousTimestamp < this.minDifference;

    const blocked = blockedDueToCount || blockedDueToMinDifference;

    // Always need to wait at least minDistance between consecutive actions.
    // If maxInInterval has been reached, also check how long will be required
    // until the interval is not full anymore.
    const microsecondsUntilAllowed = Math.max(
      this.minDifference,
      numTimestamps >= this.maxInInterval
        ? timestamps[Math.max(0, numTimestamps - this.maxInInterval)] -
            currentTimestamp +
            this.interval
        : 0,
    );

    return {
      blocked,
      blockedDueToCount,
      blockedDueToMinDifference,
      millisecondsUntilAllowed: microsecondsToMilliseconds(microsecondsUntilAllowed),
      actionsRemaining: Math.max(0, this.maxInInterval - numTimestamps),
    };
  }
}

/**
 * Rate limiter implementation that uses an object stored in memory for storage.
 */
export class InMemoryRateLimiter extends RateLimiter {
  storage: Record<Id, Array<number> | undefined>;
  ttls: Record<Id, NodeJS.Timeout | undefined>;

  constructor(options: RateLimiterOptions) {
    super(options);
    this.storage = {};
    this.ttls = {};
  }

  async clear(id: Id) {
    delete this.storage[id];
    const ttl = this.ttls[id];
    if (ttl) {
      clearTimeout(ttl);
      delete this.ttls[id];
    }
  }

  protected async getTimestamps(
    id: Id,
    addNewTimestamp: boolean,
  ): Promise<Array<Microseconds>> {
    const currentTimestamp = getCurrentMicroseconds();
    // Update the stored timestamps, including filtering out old ones, and adding the new one.
    const clearBefore = currentTimestamp - this.interval;
    const storedTimestamps = (this.storage[id] || []).filter((t) => t > clearBefore);

    if (addNewTimestamp) {
      storedTimestamps.push(currentTimestamp);

      // Set a new TTL, and cancel the old one, if present.
      const ttl = this.ttls[id];
      if (ttl) clearTimeout(ttl);
      this.ttls[id] = setTimeout(() => {
        delete this.storage[id];
        delete this.ttls[id];
      }, microsecondsToMilliseconds(this.interval));
    }

    // Return the new stored timestamps.
    this.storage[id] = storedTimestamps;
    return storedTimestamps;
  }
}

/**
 * Minimal interface of a Redis client needed for algorithm.
 * Ideally, this would be `RedisClient | IORedisClient`, but that would force consumers of this
 * library to have `@types/redis` and `@types/ioredis` to be installed.
 */
interface RedisClient {
  del(...args: Array<string>): unknown;
  multi(): RedisBatch;
}

/** Minimal interface of a Redis batch command needed for algorithm. */
interface RedisBatch {
  zremrangebyscore(key: string, min: number, max: number): void;
  zadd(key: string, score: string, value: string): void;
  zrange(key: string, min: number, max: number, withScores: unknown): void;
  expire(key: string, time: number): void;
  exec(cb: (err: Error | null, result: Array<unknown>) => void): void;
}

interface RedisRateLimiterOptions extends RateLimiterOptions {
  client: RedisClient;
  namespace: string;
}

/**
 * Rate limiter implementation that uses Redis for storage.
 */
export class RedisRateLimiter extends RateLimiter {
  client: RedisClient;
  namespace: string;
  ttl: number;

  constructor({ client, namespace, ...baseOptions }: RedisRateLimiterOptions) {
    super(baseOptions);
    this.ttl = microsecondsToTTLSeconds(this.interval);
    this.client = client;
    this.namespace = namespace;
  }

  makeKey(id: Id): string {
    return `${this.namespace}${id}`;
  }

  async clear(id: Id) {
    const key = this.makeKey(id);
    await this.client.del(key);
  }

  protected async getTimestamps(
    id: Id,
    addNewTimestamp: boolean,
  ): Promise<Array<Microseconds>> {
    const now = getCurrentMicroseconds();
    const key = this.makeKey(id);
    const clearBefore = now - this.interval;

    const batch = this.client.multi();
    batch.zremrangebyscore(key, 0, clearBefore);
    if (addNewTimestamp) {
      batch.zadd(key, String(now), uuid());
    }
    batch.zrange(key, 0, -1, 'WITHSCORES');
    batch.expire(key, this.ttl);

    return new Promise((resolve, reject) => {
      batch.exec((err, result) => {
        if (err) return reject(err);

        const zRangeOutput = (addNewTimestamp ? result[2] : result[1]) as Array<unknown>;
        const zRangeResult = this.getZRangeResult(zRangeOutput);
        const timestamps = this.extractTimestampsFromZRangeResult(zRangeResult);
        return resolve(timestamps);
      });
    });
  }

  private getZRangeResult(zRangeOutput: Array<unknown>) {
    if (!Array.isArray(zRangeOutput[1])) {
      // Standard redis client, regular mode.
      return zRangeOutput as Array<string>;
    } else {
      // ioredis client.
      return zRangeOutput[1] as Array<string>;
    }
  }

  private extractTimestampsFromZRangeResult(zRangeResult: Array<string>): Array<number> {
    // We only want the stored timestamps, which are the values, or the odd indexes.
    // Map to numbers because by default all returned values are strings.
    return zRangeResult.filter((e, i) => i % 2).map(Number);
  }
}

export function millisecondsToMicroseconds(milliseconds: Milliseconds): Microseconds {
  return 1000 * milliseconds;
}

export function microsecondsToMilliseconds(microseconds: Microseconds): Milliseconds {
  return Math.ceil(microseconds / 1000);
}

export function microsecondsToTTLSeconds(microseconds: Microseconds): Seconds {
  return Math.ceil(microseconds / 1000 / 1000);
}
