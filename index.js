var _ = require("lodash");
var assert = require("assert");
var microtime = require("microtime-nodejs");

function RateLimiter (options) {
  var redis           = options.redis,
      interval        = options.interval * 1000, // in microseconds
      maxInInterval   = options.maxInInterval,
      minDifference   = options.minDifference ? 1000*options.minDifference : null, // also in microseconds
      namespace       = options.namespace || (options.redis && ("rate-limiter-" + Math.random().toString(36).slice(2))) || null;

  assert(interval > 0, "Must pass a positive integer for `options.interval`");
  assert(maxInInterval > 0, "Must pass a positive integer for `options.maxInInterval`");
  assert(!(minDifference < 0), "`options.minDifference` cannot be negative");

  if (!options.redis) {
    var storage = {};
    var timeouts = {};
  }

  var getTimeLeft = function(userSet, now) {
    var tooManyInInterval = userSet.length >= maxInInterval;
    var timeUntilNextIntervalOpportunity = userSet[0] - now + interval;
    var timeSinceLastRequest = minDifference && (now - userSet[userSet.length - 1]);

    var timeLeft;
    if (tooManyInInterval) {
      timeLeft = timeUntilNextIntervalOpportunity / 1000;
    } else if (minDifference && timeSinceLastRequest < minDifference) {
      var timeUntilNextMinDifferenceOpportunity = minDifference - timeSinceLastRequest;
      timeLeft = Math.min(timeUntilNextIntervalOpportunity, timeUntilNextMinDifferenceOpportunity);
      timeLeft = Math.floor(timeLeft / 1000); // convert from microseconds for user readability.
    }

    return timeLeft;
  };

  if (redis) {
    // If redis is going to be potentially returning buffers OR an array from
    // ZRANGE, need a way to safely convert either of these types to an array
    // of numbers.  Otherwise, we can just assume that the result is an array
    // and safely map over it.
    var zrangeToUserSet;
    if (redis.options.return_buffers || redis.options.detect_buffers) {
      zrangeToUserSet = function(str) {
        return String(str).split(",").map(Number);
      }
    } else {
      zrangeToUserSet = function(arr) {
        return arr.map(Number);
      }
    }
    
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
      //  Add the now timestamp to the set in the batch then revert this operation later if needed.
      //  This prevents the race condition between set indicating rate limit not reached
      //  and too many (> maxInInterval) clients querying the state.
      batch.zadd(key, now, now);
      batch.expire(key, Math.ceil(interval/1000000)); // convert to seconds, as used by redis ttl.
      batch.exec(function (err, resultArr) {
        if (err) return cb(err);
    
        var userSet = zrangeToUserSet(resultArr[1]);

        var timeLeft = getTimeLeft(userSet, now);

        if (_.isUndefined(timeLeft)) {
          cb(err, 0);
        } else {
          //  Remove the now element from the set as it should only
          //  hold the timestamps for passed operations.
          redis.zrem(key, now, now, function(err) {
            cb(err, timeLeft);
          });
        }
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

      var timeLeft = getTimeLeft(userSet, now);

      if (_.isUndefined(timeLeft)) {
        userSet.push(now);
        timeouts[id] = setTimeout(function() {
          delete storage[id];
        }, interval / 1000); // convert to miliseconds for javascript timeout
        timeLeft = 0;
      }

      if (cb) {
        return process.nextTick(function() {
          cb(null, timeLeft);
        });
      } else {
        return timeLeft;
      }
    }
  }
};

module.exports = RateLimiter;



