var assert = require("assert");
var microtime = require("microtime-nodejs");

function RateLimiter (options) {
  var redis           = options.redis,
      interval        = options.interval,
      maxInInterval   = options.maxInInterval,
      minDifference   = options.minDifference,
      namespace       = options.namespace || (options.redis && ("rate-limiter-" + Math.random().toString(36).slice(2))) || null;

  assert(interval > 0, "Must pass a positive integer for `options.interval`");
  assert(maxInInterval > 0, "Must pass a positive integer for `options.maxInInterval`");
  assert(!(minDifference < 0), "`options.minDifference` cannot be negative");

  // Since we're working in microtime.
  interval *= 1000;
  minDifference = minDifference ? 1000*minDifference : null;

  if (!options.redis) {
    var storage = {};
    var timeouts = {};
  }

  if (redis) {
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
      batch.expire(key, interval);
      batch.zremrangebyscore(key, 0, clearBefore);
      batch.zrange(key, 0, -1);
      batch.zadd(key, now, now);
      batch.exec(function (err, resultArr) {
        if (err) return cb(err);
    
        var userSet = resultArr[2].map(Number);

        var tooManyInInterval = userSet.length >= maxInInterval;
        var timeSinceLastRequest = minDifference && (now - userSet[userSet.length - 1]);

        var result;
        if (tooManyInInterval || timeSinceLastRequest < minDifference) {
          result = Math.min(userSet[0] - now + interval, minDifference ? minDifference - timeSinceLastRequest : Infinity);
          result = Math.floor(result/1000); // convert from microseconds.
        } else {
          result = 0;
        }

        return cb(null, result)
      });
    }
  } else {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      var id;
      if (typeof cb === "function") {
        id = args[0] || ""
      } else {
        id = cb || "";
        cb = null;
      }
      
      var now = microtime.now();
      var key = namespace + id;
      var clearBefore = now - interval;

      clearTimeout(timeouts[id]);
      var userSet = storage[id] = (storage[id] || []).filter(function(timestamp) {
        return timestamp > clearBefore;
      });

      var tooManyInInterval = userSet.length >= maxInInterval;
      var timeSinceLastRequest = minDifference && (now - userSet[userSet.length - 1]);

      var result;
      if (tooManyInInterval || timeSinceLastRequest < minDifference) {
        result = Math.min(userSet[0] - now + interval, minDifference ? minDifference - timeSinceLastRequest : Infinity);
        result = Math.floor(result/1000); // convert from microseconds.
      } else {
        result = 0;
      }
      userSet.push(now);
      timeouts[id] = setTimeout(function() {
        delete storage[id];
      }, interval);

      if (cb) {
        return process.nextTick(function() {
          cb(null, result);
        });
      } else {
        return result;
      }
    }
  }
};

module.exports = RateLimiter;



