var assert = require("assert");
var microtime = require("microtime-nodejs");
var fakeredis = require("fakeredis");
fakeredis.fast = true; // Remove latency.

function RateLimiter (options) {
  var redis           = options.redis,
      interval        = options.interval,
      maxInInterval   = options.maxInInterval,
      minDifference   = options.minDifference,
      namespace       = options.namespace || (options.redis ? ("rate-limiter-" + Math.random().toString(36).slice(2)) : "");

  redis = redis || fakeredis.createClient();

  assert(interval > 0, "Must pass a positive integer for `options.interval`");
  assert(maxInInterval > 0, "Must pass a positive integer for `options.maxInInterval`");
  assert(!(minDifference < 0), "`options.minDifference` cannot be negative");

  // Since we're working in microtime.
  interval *= 1000;
  minDifference *= 1000;

  return function (id, cb) {
    if (!cb) {
      cb = id;
      id = "";
    }
    
    assert.equal(typeof cb, "function", "Callback must be a function.");
    
    var now = microtime.now();
    var key = namespace + id;
    var clearBefore = now - interval;

    var batch = redis.multi();
    batch.zremrangebyscore(key, 0, clearBefore);
    batch.zrange(key, 0, -1);
    batch.zadd(key, now, now);
    batch.exec(function (err, resultArr) {
      if (err) return cb(err);
  
      var oldMembers = resultArr[1].map(Number);
      var tooManyActionsInInterval = oldMembers.length >= maxInInterval;
      var previousActionTooRecent = minDifference && (now - oldMembers.pop() < minDifference);

      return cb(null, !tooManyActionsInInterval && !previousActionTooRecent);

    });

  }

};

module.exports = RateLimiter;