var expect = require("chai").expect;
var async = require("async");
var redis = require("fakeredis");

var RateLimiter = require("../");

var RateLimitedCounter = function(options) {
  var rateLimiter = RateLimiter(options);
  var counts = {};

  return {
    increment () {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      var userId;
      if (typeof cb === "function") {
        userId = args[0] || "";
      } else {
        userId = cb || "";
        cb = null;
      }
      counts[userId] = counts[userId] || 0;
      var limit = userId ? rateLimiter.bind(null, userId) : rateLimiter;
      if (cb) {
        limit(function(err, timeLeft) {
          if (!timeLeft) {
            counts[userId]++;
          }
          cb(err, timeLeft);
        });
      } else {
        var timeLeft = limit();
        if (!timeLeft) {
          counts[userId]++;
        }
        return timeLeft;
      }
    },

    getCount (userId) {
      return counts[userId || ""];
    },
  };

};

describe("rateLimiter", function() {

  describe("options validation", function() {

    var options;

    beforeEach(function() {
      options = {
        interval: 10000,
        maxInInterval: 5,
        minDifference: 500,
        namespace: "MyNamespace",
      };
    });

    it("throws if interval is missing", function() {
      delete options.interval;
      expect(RateLimiter.bind(null, options)).to.throw();
    });

    it("throws if maxInInterval is missing", function() {
      delete options.maxInInterval;
      expect(RateLimiter.bind(null, options)).to.throw();
    });

    it("throws if interval is non-positive", function() {
      options.interval = -1;
      expect(RateLimiter.bind(null, options)).to.throw();
    });

    it("throws if maxInInterval is non-positive", function() {
      options.maxInInterval = -1;
      expect(RateLimiter.bind(null, options)).to.throw();
    });

    it("throws if minDifference is non-positive", function() {
      options.minDifference = -1;
      expect(RateLimiter.bind(null, options)).to.throw();
    });

    it("passes with good options", function() {
      expect(RateLimiter.bind(null, options)).to.not.throw();
    });

  });

  describe("synchronous operation with in-memory store", function() {

    it("allows requests that don't exceed the maximum over the interval", function() {
      var counter = RateLimitedCounter({
        interval: 100,
        maxInInterval: 30,
      });
      for (var n = 0; n < 100; n++) {
        counter.increment();
      }
      expect(counter.getCount()).to.equal(30);
    });

    it("prevents requests that exceed the maximum over the interval", function() {
      var counter = RateLimitedCounter({
        interval: 100,
        maxInInterval: 30,
      });
      for (var n = 0; n < 100; n++) {
        counter.increment();
      }
      expect(counter.getCount()).to.equal(30);
    });

    it("keeps seperate counts for multiple users", function() {
      var counter = RateLimitedCounter({
        interval: 100,
        maxInInterval: 30,
      });
      for (var n = 0; n < 300; n++) {
        counter.increment(n % 3);
      }
      expect(counter.getCount(0)).to.equal(30);
      expect(counter.getCount(1)).to.equal(30);
      expect(counter.getCount(2)).to.equal(30);
    });


    it("allows requests after the interval has passed", function(done) {
      var counter = RateLimitedCounter({
        interval: 100,
        maxInInterval: 30,
      });

      for (var n = 0; n < 300; n++) {
        counter.increment(n % 3);
      }
      setTimeout(function() {
        for (var n = 0; n < 300; n++) {
          counter.increment(n % 3);
        }
        expect(counter.getCount(0)).to.equal(60);
        expect(counter.getCount(1)).to.equal(60);
        expect(counter.getCount(2)).to.equal(60);
        done();
      }, 100);
    });

    it("doesn't allow consecutive requests less than the minDifferent apart", function() {
      var counter = RateLimitedCounter({
        interval: 1000000,
        maxInInterval: 1000,
        minDifference: 100,
      });

      for (var n = 0; n < 300; n++) {
        counter.increment(n % 3);
      }
      expect(counter.getCount(0)).to.equal(1);
      expect(counter.getCount(1)).to.equal(1);
      expect(counter.getCount(2)).to.equal(1);
    });

    it("returns the time after which actions will be allowed", function() {
      var limiter1 = RateLimiter({
        interval: 10000,
        maxInInterval: 2,
      });
      var first = limiter1();
      var second = limiter1();
      var third = limiter1();

      expect(first).to.equal(0);
      expect(second).to.equal(0);
      expect(third).to.be.above(9900);
      expect(third).to.be.below(10001);

      var limiter2 = RateLimiter({
        interval: 10000,
        maxInInterval: 100,
        minDifference: 100,
      });

      first = limiter2();
      second = limiter2();
      expect(first).to.equal(0);
      expect(second).to.be.above(90);
      expect(second).to.be.below(101);
    });

  });

  describe("asynchronous operation with in-memory store", function() {

    it("prevents requests that exceed the maximum over the interval", function(done) {
      var counter = RateLimitedCounter({
        interval: 300,
        maxInInterval: 30,
      });

      async.times(100, function(n, next) {
        counter.increment(next);
      }, function(err) {
        if (err) throw err;
        expect(counter.getCount()).to.equal(30);
        done();
      });
    });

    it("keeps seperate counts for multiple users", function(done) {
      var counter = RateLimitedCounter({
        interval: 300,
        maxInInterval: 30,
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        expect(counter.getCount(0)).to.equal(30);
        expect(counter.getCount(1)).to.equal(30);
        expect(counter.getCount(2)).to.equal(30);
        done();
      });
    });


    it("allows requests after the interval has passed", function(done) {
      var counter = RateLimitedCounter({
        interval: 150,
        maxInInterval: 30,
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        setTimeout(function() {
          async.times(100, function(n, next) {
            counter.increment(n % 3, next);
          }, function(err) {
            if (err) throw err;
            expect(counter.getCount(0)).to.equal(60);
            expect(counter.getCount(1)).to.equal(60);
            expect(counter.getCount(2)).to.equal(60);
            done();
          });
        }, 150);
      });
    });

    it("doesn't allow consecutive requests less than the minDifferent apart", function(done) {
      var counter = RateLimitedCounter({
        interval: 1000000,
        maxInInterval: 1000,
        minDifference: 100,
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        expect(counter.getCount(0)).to.equal(1);
        expect(counter.getCount(1)).to.equal(1);
        expect(counter.getCount(2)).to.equal(1);
        done();
      });
    });

  });

  describe("operation with (mocked) redis", function() {

    beforeEach(function() {
      redis.fast = false; // mock redis network latency.
    });

    it("prevents requests that exceed the maximum over the interval", function(done) {
      var client = redis.createClient();
      var counter = RateLimitedCounter({
        redis: client,
        interval: 300,
        maxInInterval: 30,
      });

      async.times(100, function(n, next) {
        counter.increment(next);
      }, function(err) {
        if (err) throw err;
        expect(counter.getCount()).to.equal(30);
        done();
      });
    });

    it("works when redis is in buffer mode", function(done) {
      var client = redis.createClient({return_buffers: true});
      // fakeredis seems to hide this option.
      client.options = {};
      client.options.return_buffers = true;
      var counter = RateLimitedCounter({
        redis: client,
        interval: 300,
        maxInInterval: 30,
      });

      async.times(100, function(n, next) {
        counter.increment(next);
      }, function(err) {
        if (err) throw err;
        expect(counter.getCount()).to.equal(30);
        done();
      });
    });

    it("keeps seperate counts for multiple users", function(done) {
      var counter = RateLimitedCounter({
        redis: redis.createClient(),
        interval: 300,
        maxInInterval: 30,
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        expect(counter.getCount(0)).to.equal(30);
        expect(counter.getCount(1)).to.equal(30);
        expect(counter.getCount(2)).to.equal(30);
        done();
      });
    });


    it("allows requests after the interval has passed", function(done) {
      var counter = RateLimitedCounter({
        redis: redis.createClient(),
        interval: 150,
        maxInInterval: 30,
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        setTimeout(function() {
          async.times(100, function(n, next) {
            counter.increment(n % 3, next);
          }, function(err) {
            if (err) throw err;
            expect(counter.getCount(0)).to.equal(60);
            expect(counter.getCount(1)).to.equal(60);
            expect(counter.getCount(2)).to.equal(60);
            done();
          });
        }, 150);
      });
    });

    it("doesn't allow consecutive requests less than the minDifferent apart", function(done) {
      var counter = RateLimitedCounter({
        redis: redis.createClient(),
        interval: 1000000,
        maxInInterval: 1000,
        minDifference: 100,
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        expect(counter.getCount(0)).to.equal(1);
        expect(counter.getCount(1)).to.equal(1);
        expect(counter.getCount(2)).to.equal(1);
        done();
      });
    });

    it("can share a redis between multiple rate limiters in different namespaces", function(done) {
      var client = redis.createClient();
      var counters = [
        RateLimitedCounter({
          redis: client,
          interval: 300,
          maxInInterval: 15,
        }),
        RateLimitedCounter({
          redis: client,
          interval: 300,
          maxInInterval: 15,
        }),
      ];
      async.times(200, function(n, next) {
        var counter = counters[n % 2];
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        expect(counters[0].getCount(0)).to.equal(15);
        expect(counters[0].getCount(1)).to.equal(15);
        expect(counters[0].getCount(2)).to.equal(15);
        expect(counters[1].getCount(0)).to.equal(15);
        expect(counters[1].getCount(1)).to.equal(15);
        expect(counters[1].getCount(2)).to.equal(15);
        done();
      });
    });

    it("can share a redis between multiple rate limiters in the same namespace", function(done) {
      var client = redis.createClient();
      var namespace = Math.random().toString(36).slice(2);
      var counters = [
        RateLimitedCounter({
          redis: client,
          namespace,
          interval: 300,
          maxInInterval: 30,
        }),
        RateLimitedCounter({
          redis: client,
          namespace,
          interval: 300,
          maxInInterval: 30,
        }),
      ];
      async.times(200, function(n, next) {
        var counter = counters[(n + 1) % 2];
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;

        // CountXY is the count for counter x and user y.
        var count00 = counters[0].getCount(0);
        var count01 = counters[0].getCount(1);
        var count02 = counters[0].getCount(2);
        var count10 = counters[1].getCount(0);
        var count11 = counters[1].getCount(1);
        var count12 = counters[1].getCount(2);

        expect(count00 + count10).to.equal(30);
        expect(count01 + count11).to.equal(30);
        expect(count02 + count12).to.equal(30);
        expect(count00).to.be.above(10);
        expect(count01).to.be.above(10);
        expect(count02).to.be.above(10);
        expect(count10).to.be.above(10);
        expect(count11).to.be.above(10);
        expect(count12).to.be.above(10);
        done();
      });
    });

    it("returns the time after which actions will be allowed", function(done) {
      var limiter1 = RateLimiter({
        redis: redis.createClient(),
        interval: 10000,
        maxInInterval: 2,
      });
      async.times(3, function(n, next) {
        limiter1(next);
      }, function(err, results) {
        expect(results[0]).to.equal(0);
        expect(results[1]).to.equal(0);
        expect(results[2]).to.be.above(9900);
        expect(results[2]).to.be.below(10001);

        // ---

        var limiter2 = RateLimiter({
          interval: 10000,
          maxInInterval: 100,
          minDifference: 100,
        });
        async.times(3, function(n, next) {
          limiter2(next);
        }, function(err, results) {
          expect(results[0]).to.equal(0);
          expect(results[1]).to.be.above(90);
          expect(results[1]).to.be.below(101);
          done();
        });
      });
    });

    it("ttl functions properly", function(done) {
      var client = redis.createClient();
      var namespace = Math.random().toString(36).slice(2);
      var limiter = RateLimiter({
        redis: client,
        interval: 10000,
        maxInInterval: 5,
        namespace,
      });
      limiter("1", function() {
        var key = `${namespace }1`;
        client.ttl(key, function(err, result) {
          expect(result).to.equal(10);
          done();
        })
      });
    });
  });
});