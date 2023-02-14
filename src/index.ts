import assert from 'assert';
import microtime from 'microtime';
import { v4 as uuid } from 'uuid';

export type Id = number | string;
export type Seconds = number & { __brand: 'seconds' };
export type Milliseconds = number & { __brand: 'milliseconds' };
export type Microseconds = number & { __brand: 'microseconds' };

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
  interval: Microseconds;
  maxInInterval: number;
  minDifference: Microseconds;

  constructor({ interval, maxInInterval, minDifference = 0 }: RateLimiterOptions) {
    assert(interval > 0, 'Must pass a positive integer for `options.interval`');
    assert(maxInInterval > 0, 'Must pass a positive integer for `options.maxInInterval`');
    assert(minDifference >= 0, '`options.minDifference` cannot be negative');

    this.interval = millisecondsToMicroseconds(interval as Milliseconds);
    this.maxInInterval = maxInInterval;
    this.minDifference = millisecondsToMicroseconds(minDifference as Milliseconds);
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
    const existingTimestamps = await this.getTimestamps(id, false);
    const currentTimestamp = getCurrentMicroseconds();
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
      // Only performs the check for positive `minDifference` values. The `currentTimestamp`
      // created by `wouldLimit` may possibly be smaller than `previousTimestamp` in a distributed
      // environment.
      this.minDifference > 0 &&
      currentTimestamp - previousTimestamp < this.minDifference;

    const blocked = blockedDueToCount || blockedDueToMinDifference;

    // Always need to wait at least minDistance between consecutive actions.
    // If maxInInterval has been reached, also check how long will be required
    // until the interval is not full anymore.
    const microsecondsUntilUnblocked =
      numTimestamps >= this.maxInInterval
        ? (timestamps[Math.max(0, numTimestamps - this.maxInInterval)] as number) -
          (currentTimestamp as number) +
          (this.interval as number)
        : 0;

    const microsecondsUntilAllowed = Math.max(
      this.minDifference,
      microsecondsUntilUnblocked,
    ) as Microseconds;

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

  protected async getTimestamps(id: Id, addNewTimestamp: boolean) {
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
    return storedTimestamps as Array<Microseconds>;
  }
}

/**
 * Wrapper class around a Redis client.
 * Exposes only the methods we need for the algorithm.
 * This papers over differences between `node-redis` and `ioredis`.
 */
interface RedisClientWrapper {
  del(arg: string): unknown;
  multi(): RedisMultiWrapper;
  parseZRangeResult(result: unknown): Array<Microseconds>;
}

/**
 * Wrapper class around a Redis multi batch.
 * Exposes only the methods we need for the algorithm.
 * This papers over differences between `node-redis` and `ioredis`.
 */
interface RedisMultiWrapper {
  zRemRangeByScore(key: string, min: number, max: number): void;
  zAdd(key: string, score: number, value: string): void;
  zRangeWithScores(key: string, min: number, max: number): void;
  expire(key: string, time: number): void;
  exec(): Promise<Array<unknown>>;
}

/**
 * Generic options for constructing a Redis-backed rate limiter.
 * See `README.md` for more information.
 */
interface RedisRateLimiterOptions<Client> extends RateLimiterOptions {
  client: Client;
  namespace: string;
}

/**
 * Abstract base class for Redis-based implementations.
 */
abstract class BaseRedisRateLimiter extends RateLimiter {
  client: RedisClientWrapper;
  namespace: string;
  ttl: number;

  constructor({
    client,
    namespace,
    ...baseOptions
  }: RedisRateLimiterOptions<RedisClientWrapper>) {
    super(baseOptions);
    this.ttl = microsecondsToSeconds(this.interval);
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
    batch.zRemRangeByScore(key, 0, clearBefore);
    if (addNewTimestamp) {
      batch.zAdd(key, now, uuid());
    }
    batch.zRangeWithScores(key, 0, -1);
    batch.expire(key, this.ttl);

    const results = await batch.exec();
    const zRangeResult = addNewTimestamp ? results[2] : results[1];
    return this.client.parseZRangeResult(zRangeResult);
  }
}

/**
 * Duck-typed `node-redis` client. We don't want to use the actual typing because that would
 * force users to install `node-redis` as a peer dependency.
 */
interface NodeRedisClient {
  del(arg: string): unknown;
  multi(): NodeRedisMulti;
}

/**
 * Duck-typed `node-redis` multi object. We don't want to use the actual typing because that would
 * force users to install `node-redis` as a peer dependency.
 */
interface NodeRedisMulti {
  zRemRangeByScore(key: string, min: number, max: number): void;
  zAdd(key: string, item: { score: number; value: string }): void;
  zRangeWithScores(key: string, min: number, max: number): void;
  expire(key: string, time: number): void;
  exec(): Promise<Array<unknown>>;
}

/**
 * Wrapper for `node-redis` client, proxying method calls to the underlying client.
 */
class NodeRedisClientWrapper implements RedisClientWrapper {
  client: NodeRedisClient;

  constructor(client: NodeRedisClient) {
    this.client = client;
  }

  del(arg: string) {
    return this.client.del(arg);
  }

  multi() {
    return new NodeRedisMultiWrapper(this.client.multi());
  }

  parseZRangeResult(result: unknown) {
    return (
      result as Array<{
        value: string;
        score: number;
      }>
    ).map(({ score }) => score as Microseconds);
  }
}

/**
 * Wrapper for `node-redis` multi batch, proxying method calls to the underlying client.
 */
class NodeRedisMultiWrapper implements RedisMultiWrapper {
  multi: NodeRedisMulti;

  constructor(multi: NodeRedisMulti) {
    this.multi = multi;
  }

  zRemRangeByScore(key: string, min: number, max: number) {
    this.multi.zRemRangeByScore(key, min, max);
  }

  zAdd(key: string, score: number, value: string) {
    this.multi.zAdd(key, { score: Number(score), value });
  }

  zRangeWithScores(key: string, min: number, max: number) {
    this.multi.zRangeWithScores(key, min, max);
  }

  expire(key: string, time: number) {
    this.multi.expire(key, time);
  }

  async exec() {
    // TODO: ensure everything is a string?
    return this.multi.exec();
  }
}

/**
 * Rate limiter backed by `node-redis`.
 */
export class NodeRedisRateLimiter extends BaseRedisRateLimiter {
  constructor({ client, ...baseOptions }: RedisRateLimiterOptions<NodeRedisClient>) {
    super({ client: new NodeRedisClientWrapper(client), ...baseOptions });
  }
}

/**
 * Duck-typed `ioredis` client. We don't want to use the actual typing because that would
 * force users to install `ioredis` as a peer dependency.
 */
interface IORedisClient {
  del(arg: string): unknown;
  multi(): IORedisMulti;
}

/**
 * Duck-typed `ioredis` multi object. We don't want to use the actual typing because that would
 * force users to install `ioredis` as a peer dependency.
 */
interface IORedisMulti {
  zremrangebyscore(key: string, min: number, max: number): void;
  zadd(key: string, score: number, value: string): void;
  zrange(key: string, min: number, max: number, withScores: 'WITHSCORES'): void;
  expire(key: string, time: number): void;
  exec(): Promise<Array<[error: Error | null, result: unknown]> | null>;
}

/**
 * Wrapper for `ioredis` client, proxying method calls to the underlying client.
 */
class IORedisClientWrapper implements RedisClientWrapper {
  client: IORedisClient;

  constructor(client: IORedisClient) {
    this.client = client;
  }

  del(arg: string) {
    return this.client.del(arg);
  }

  multi() {
    return new IORedisMultiWrapper(this.client.multi());
  }

  parseZRangeResult(result: unknown) {
    const valuesAndScores = (result as [null, Array<string>])[1];
    return valuesAndScores.filter((e, i) => i % 2).map(Number) as Array<Microseconds>;
  }
}

/**
 * Wrapper for `ioredis` multi batch, proxying method calls to the underlying client.
 */
class IORedisMultiWrapper implements RedisMultiWrapper {
  multi: IORedisMulti;

  constructor(multi: IORedisMulti) {
    this.multi = multi;
  }

  zRemRangeByScore(key: string, min: number, max: number) {
    this.multi.zremrangebyscore(key, min, max);
  }

  zAdd(key: string, score: number, value: string) {
    this.multi.zadd(key, score, value);
  }

  zRangeWithScores(key: string, min: number, max: number) {
    this.multi.zrange(key, min, max, 'WITHSCORES');
  }

  expire(key: string, time: number) {
    this.multi.expire(key, time);
  }

  async exec() {
    return (await this.multi.exec()) ?? [];
  }
}

/**
 * Rate limiter backed by `ioredis`.
 */
export class IORedisRateLimiter extends BaseRedisRateLimiter {
  constructor({ client, ...baseOptions }: RedisRateLimiterOptions<IORedisClient>) {
    super({ client: new IORedisClientWrapper(client), ...baseOptions });
  }
}

type RedisClientType = 'node-redis' | 'ioredis';

/**
 * Rate limiter backed by either `node-redis` or `ioredis`.
 * Uses duck-typing to determine which client is being used.
 */
export class RedisRateLimiter extends BaseRedisRateLimiter {
  /**
   * Given an unknown object, determine what type of redis client it is.
   * Used by the constructor of this class.
   */
  public static determineRedisClientType(client: any): RedisClientType | null {
    if ('zRemRangeByScore' in client && 'ZREMRANGEBYSCORE' in client) return 'node-redis';
    if ('zremrangebyscore' in client) return 'ioredis';
    return null;
  }

  public readonly detectedClientType: RedisClientType;

  constructor({ client, ...baseOptions }: RedisRateLimiterOptions<any>) {
    const clientType = RedisRateLimiter.determineRedisClientType(client);
    if (clientType == null) {
      throw new Error('Could not detect redis client type');
    } else if (clientType === 'node-redis') {
      super({
        client: new NodeRedisClientWrapper(client as NodeRedisClient),
        ...baseOptions,
      });
    } else {
      super({
        client: new IORedisClientWrapper(client as IORedisClient),
        ...baseOptions,
      });
    }
    this.detectedClientType = clientType;
  }
}

export function getCurrentMicroseconds() {
  return microtime.now() as Microseconds;
}

export function millisecondsToMicroseconds(milliseconds: Milliseconds) {
  return (1000 * milliseconds) as Microseconds;
}

export function microsecondsToMilliseconds(microseconds: Microseconds) {
  return Math.ceil(microseconds / 1000) as Milliseconds;
}

export function microsecondsToSeconds(microseconds: Microseconds) {
  return Math.ceil(microseconds / 1000 / 1000) as Seconds;
}
