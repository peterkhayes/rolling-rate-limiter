import assert from 'assert';
import type { Redis as IORedisClient } from 'ioredis';
import { now as getCurrentMicroseconds } from 'microtime-nodejs';
import type { RedisClient as StandardRedisClient } from 'redis';
import { v4 as uuid } from 'uuid';

export type Id = number | string;
export type Seconds = number;
export type Milliseconds = number;
export type Microseconds = number;

export interface RateLimiterOptions {
  interval: number;
  maxInInterval: number;
  minDifference?: number;
}

export interface RateLimitInfo {
  blocked: boolean;
  blockedDueToCount: boolean;
  blockedDueToMinDifference: boolean;
  millisecondsUntilAllowed: Milliseconds;
  actionsRemaining: number;
}

export class RateLimiter {
  interval: number;
  maxInInterval: number;
  minDifference: number;

  constructor({ interval, maxInInterval, minDifference }: RateLimiterOptions) {
    assert(interval > 0, 'Must pass a positive integer for `options.interval`');
    assert(maxInInterval > 0, 'Must pass a positive integer for `options.maxInInterval`');
    assert(!(minDifference < 0), '`options.minDifference` cannot be negative');

    this.interval = millisecondsToMicroseconds(interval);
    this.maxInInterval = maxInInterval;
    this.minDifference = millisecondsToMicroseconds(minDifference || 0);
  }

  async limitWithInfo(id: Id): Promise<RateLimitInfo> {
    const timestamps = await this.getTimestamps(id, true);
    return this.calculateInfo(timestamps);
  }

  async wouldLimitWithInfo(id: Id) {
    const currentTimestamp = getCurrentMicroseconds();
    const existingTimestamps = await this.getTimestamps(id, false);
    return this.calculateInfo([...existingTimestamps, currentTimestamp]);
  }

  async limit(id: Id): Promise<boolean> {
    return (await this.limitWithInfo(id)).blocked;
  }

  async wouldLimit(id: Id): Promise<boolean> {
    return (await this.wouldLimitWithInfo(id)).blocked;
  }

  async clear(_id: Id): Promise<void> {
    return Promise.reject(new Error('Not implemented'));
  }

  protected async getTimestamps(
    _id: Id,
    _addTimestamp: boolean,
  ): Promise<Array<Microseconds>> {
    return Promise.reject(new Error('Not implemented'));
  }

  protected calculateInfo(timestamps: Array<Microseconds>): RateLimitInfo {
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
    if (this.ttls[id]) {
      clearTimeout(this.ttls[id]);
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
    this.storage[id] = (this.storage[id] || []).filter((t) => t > clearBefore);

    if (addNewTimestamp) {
      this.storage[id].push(currentTimestamp);

      // Set a new TTL, and cancel the old one, if present.
      if (this.ttls[id]) clearTimeout(this.ttls[id]);
      this.ttls[id] = setTimeout(() => {
        delete this.storage[id];
        delete this.ttls[id];
      }, microsecondsToMilliseconds(this.interval));
    }

    // Return the new stored timestamps.
    return this.storage[id];
  }
}

type RedisClient = StandardRedisClient | IORedisClient;

interface RedisRateLimiterOptions extends RateLimiterOptions {
  client: RedisClient;
  namespace: string;
}

export class RedisRateLimiter extends RateLimiter {
  client: RedisClient;
  namespace: string;
  ttl: number;

  constructor({ client, namespace, ...baseOptions }: RedisRateLimiterOptions) {
    super(baseOptions);
    this.ttl = millisecondsToTTLSeconds(this.interval);
    this.client = client;
    this.namespace = namespace;
  }

  makeKey(id: Id): string {
    return `${this.namespace}${id}`;
  }

  async clear(id: Id) {
    const key = this.makeKey(id);
    // @ts-expect-error - unclear why redis/ioredis types don't line up here.
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
    // @ts-expect-error - unclear why redis/ioredis types don't line up here.
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

export function millisecondsToTTLSeconds(milliseconds: Milliseconds): Seconds {
  return Math.ceil(milliseconds / 1000);
}
