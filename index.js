var assert = require("assert");
var microtime = require("microtime-nodejs");

function RateLimiter (options) {
  var redis = options.redis;
  var namespace = options.namespace || (options.redis && ("rate-limiter-" + Math.random().toString(36).slice(2))) || null;
  var limits = [];
  
  if (Array.isArray(options.limits)) {
    assert(options.limits.length, "`options.limits` should not be an empty array");
    Array.prototype.push.apply(limits, options.limits.map(parseOpts));
  } else {
    limits.push(parseOpts(options));
  }

  if (!options.redis) {
    var storage = {};
    var timeouts = {};
  }

  if (redis) {
    // If redis is going to be potentially returning buffers OR an array from
    // ZRANGE, need a way to safely convert either of these types to an array
    // of numbers.  Otherwise, we can just assume that the result is an array
    // and safely map over it.
    var zrangeToUserSet;
    if (redis.options.return_buffers || redis.options.detect_buffers) {
      zrangeToUserSet = function(str) {
        return String(str).split(",").map(Number);
      };
    } else {
      zrangeToUserSet = function(arr) {
        return arr.map(Number);
      };
    }
    
    return function (id, cb) {
      if (!cb) {
        cb = id;
        id = "";
      }

      assert.equal(typeof cb, "function", "Callback must be a function.");
      
      var now = microtime.now();
      var key = namespace + id;
      
      var batch = redis.multi();
      
      var keys = limits.map(function (limit, i) {
        var interval = limit.interval;
        var key = namespace + id + (i ? "__" + i : ""); // remain compatible with former versions
        var clearBefore = now - interval;
        batch.zremrangebyscore(key, 0, clearBefore);
        batch.zrange(key, 0, -1);
        batch.zadd(key, now, now);
        batch.expire(key, Math.ceil(interval / 1000000)); // convert to seconds, as used by redis ttl.
        return key;
      });

      batch.exec(function (err, resultArr) {
        if (err) return cb(err);
        
        var worstMatch = limits.reduce(function (worst, limit, i) {
          var minDifference = limit.minDifference;
          var maxInInterval = limit.maxInInterval;
          var interval = limit.interval;
          var userSet = zrangeToUserSet(resultArr[i * 4 + 1]);
          var tooManyInInterval = userSet.length >= maxInInterval;
          var timeSinceLastRequest = minDifference && (now - userSet[userSet.length - 1]);
          
          var result, remaining;
          
          if (tooManyInInterval || timeSinceLastRequest < minDifference) {
            result = Math.min(userSet[0] - now + interval, minDifference ? minDifference - timeSinceLastRequest : Infinity);
            remaining = -1;
          } else {
            result = 0;
            remaining = maxInInterval - userSet.length - 1;
          }
          
          if (!worst || worst.remaining > remaining || worst.result < result ) {
            return {
              result: result, 
              remaining: remaining, 
              index: i
            }
          }
          return worst;
        }, undefined)

        return cb(null, worstMatch.result / 1000, worstMatch.remaining); // convert from microseconds for user readability.
      });
    };
  } else {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      var id;
      if (typeof cb === "function") {
        id = args[0] || "";
      } else {
        id = cb || "";
        cb = null;
      }
      
      var now = microtime.now();
      
      var worstMatch = limits.reduce(function (worst, limit, i) {
        var minDifference = limit.minDifference;
        var maxInInterval = limit.maxInInterval;
        var interval = limit.interval;
        var key = id + (i ? "__" + i : ""); // remain compatible with former versions
        clearTimeout(timeouts[key]);
        var clearBefore = now - interval;
        var userSet = storage[key] = (storage[key] || []).filter(function(timestamp) {
          return timestamp > clearBefore;
        })
        
        var tooManyInInterval = userSet.length >= maxInInterval;
        var timeSinceLastRequest = minDifference && (now - userSet[userSet.length - 1]);
        
        var result, remaining;
        if (tooManyInInterval || timeSinceLastRequest < minDifference) {
          result = Math.min(userSet[0] - now + interval, minDifference ? minDifference - timeSinceLastRequest : Infinity);
          remaining = -1;
        } else {
          remaining = maxInInterval - userSet.length - 1;
          result = 0;
        }
        
        userSet.push(now);
        timeouts[key] = setTimeout(function () {
          delete storage[key];
        }, interval / 1000); // convert to milliseconds for javascript timeout
        
        if (!worst || worst.remaining > remaining || worst.result < result ) {
          return {
            result: result, 
            remaining: remaining, 
            index: i
          }
        }
        return worst;
      }, undefined);
      
      worstMatch.result = worstMatch.result / 1000 // convert from microseconds for user readability.

      if (cb) {
        return process.nextTick(function() {
          cb(null, worstMatch.result, worstMatch.remaining); 
        });
      } else {
        return worstMatch.result;
      }
    };
  }
}

function parseOpts (options) {
  var config = {
    interval:       options.interval * 1000, // in microseconds
    maxInInterval:  options.maxInInterval,
    minDifference:  options.minDifference ? 1000 * options.minDifference : null, // also in microseconds
  };
  assert(config.interval > 0, "Must pass a positive integer for `options.interval`");
  assert(config.maxInInterval > 0, "Must pass a positive integer for `options.maxInInterval`");
  assert(!(config.minDifference < 0), "`options.minDifference` cannot be negative");
  return config;
}

module.exports = RateLimiter;
