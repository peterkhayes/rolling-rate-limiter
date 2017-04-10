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
        return String(str).split(",");
      };
    } else {
      zrangeToUserSet = function(arr) {
        return arr;
      };
    }
    
    return function (id, increment, cb) {
      if (!increment && !cb) {
        cb = id;
        increment = 1;
        id = "";
      } else if (!cb) {
        cb = increment;
        increment = 1;
      }
      assert(increment > 0, "`increment` must be a positive integer");
      assert.equal(typeof cb, "function", "Callback must be a function.");
      
      var now = microtime.now();
      var key = namespace + id;
      
      var batch = redis.multi();
      
      var keys = limits.map(function (limit, i) {
        var interval = limit.interval;
        var key = namespace + id + (i ? "__" + i : ""); // remain compatible with former versions
        var clearBefore = now - interval;
        batch.zremrangebyscore(key, 0, clearBefore);
        batch.zrange(key, 0, -1, 'WITHSCORES');
        batch.zadd(key, now, now + "/" + increment);
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
          
          var count = userSet.reduce(function (acc, n, i) {
            if (i % 2 === 0) {
              var c = (n.split("/")[1] || 1); // get optional count suffix, backward compatible
              return acc + (1 - (i % 2)) * c; // sum even
            }
            return acc;
          }, 0);
        
          var result, remaining;
          var timeSinceLastRequest = userSet.length ? now - userSet[userSet.length - 1] : 0;
          var tooManyInInterval = count + increment > maxInInterval;
          var cooldownSinceLastRequest = Math.max(minDifference && timeSinceLastRequest ? minDifference - timeSinceLastRequest : 0, 0)
          if (!tooManyInInterval && cooldownSinceLastRequest === 0) {
            remaining = maxInInterval - (userSet.length / 2) - increment;
            result = 0;
          } else if (!tooManyInInterval) {
            remaining = -1;
            result = cooldownSinceLastRequest;
          } else {
            remaining = -1;
            result = Math.max(userSet[1] - now + interval, cooldownSinceLastRequest)  
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
      var increment = args.pop();
      var id = args.pop();
      var increment, id;

      if (typeof cb === "function" && cb === arguments[0]) {
        id = "";
        increment = 1;
      } else if (typeof cb === "function" && cb === arguments[1]) {
        id = increment;
        increment = 1;
      } else if (typeof cb !== "function" && id != null) {
        id = increment;
        increment = cb;
        cb = null;
      } else if (typeof cb !== "function") {
        id = cb || "";
        cb = null;
        increment = 1;
      }
      
      assert(increment > 0, "`increment` must be a positive integer");
      
      var now = microtime.now();
      
      var worstMatch = limits.reduce(function (worst, limit, i) {
        var minDifference = limit.minDifference;
        var maxInInterval = limit.maxInInterval;
        var interval = limit.interval;
        var key = id + (i ? "__" + i : ""); // remain compatible with former versions
        clearTimeout(timeouts[key]);
        var clearBefore = now - interval;
        var userSet = storage[key] = (storage[key] || []).filter(function(item) {
          return item[0] > clearBefore;
        })
        
        var count = userSet.reduce(function (sum, item) {
          return sum + item[1];
        }, 0);
        
        var result, remaining;
        var timeSinceLastRequest = userSet.length ? now - userSet[userSet.length - 1][0] : 0;
        var tooManyInInterval = count + increment > maxInInterval;
        var cooldownSinceLastRequest = Math.max(minDifference && timeSinceLastRequest ? minDifference - timeSinceLastRequest : 0, 0)
        if (!tooManyInInterval && cooldownSinceLastRequest === 0) {
          remaining = maxInInterval - count - increment;
          result = 0;
        } else if (!tooManyInInterval) {
          remaining = -1;
          result = cooldownSinceLastRequest;
        } else {
          remaining = -1;
          result = Math.max(userSet[0][0] - now + interval, cooldownSinceLastRequest)  
        }
        
        userSet.push([now, increment]);
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
        return worst
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
