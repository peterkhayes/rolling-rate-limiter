var sinon = require("sinon");
var expect = require("chai").expect;
var async = require("async");
var redis = require("fakeredis");

var RateLimiter = require("../");

var RateLimitedCounter = function(options) {
  var rateLimiter = RateLimiter(options);
  var counts = {};

  return {
    increment: function(userId, cb) {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      var userId;
      if (typeof cb === "function") {
        userId = args[0] || ""
      } else {
        userId = cb || "";
        cb = null;
      }
      counts[userId] = counts[userId] || 0;
      var limit = userId ? rateLimiter.bind(null, userId) : rateLimiter
      if (cb) {
        limit(function(err, success) {
          if (success) {
            counts[userId]++;
          }
          cb(err);
        });
      } else {
        var success = limit();
        if (success) {
          counts[userId]++;
        }
      }
    },

    getCount: function(userId) {
      return counts[userId || ""];
    }
  };

};

describe("rateLimiter", function () {

  describe("options validation", function() {
    
    var options;
    
    beforeEach(function() {
      options = {
        interval: 10000,
        maxInInterval: 5,
        minDifference: 500,
        namespace: "MyNamespace"
      }
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

    it("prevents requests that exceed the maximum over the interval", function() {
      var counter = RateLimitedCounter({
        interval: 300,
        maxInInterval: 30
      });

      for (var n = 0; n < 100; n++) {
        counter.increment();
      }
      expect(counter.getCount()).to.equal(30);
    });

    it("keeps seperate counts for multiple users", function() {
      var counter = RateLimitedCounter({
        interval: 300,
        maxInInterval: 30
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
        maxInInterval: 30
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
      }, 100)
    });

    it("doesn't allow consecutive requests less than the minDifferent apart", function() {
      var counter = RateLimitedCounter({
        interval: 1000000,
        maxInInterval: 1000,
        minDifference: 20
      });

      for (var n = 0; n < 300; n++) {
        counter.increment(n % 3);
      }
      expect(counter.getCount(0)).to.equal(1);
      expect(counter.getCount(1)).to.equal(1);
      expect(counter.getCount(2)).to.equal(1);
    });

  });

  describe("asynchronous operation with in-memory store", function() {

    it("prevents requests that exceed the maximum over the interval", function(done) {
      var counter = RateLimitedCounter({
        interval: 300,
        maxInInterval: 30
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
        maxInInterval: 30
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
        maxInInterval: 30
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        setTimeout(function() {
          async.times(100, function(n, next) {
            counter.increment(n % 3, next);
          }, function(err, results) {
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
        minDifference: 100
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
      redis.fast = false;
    });

    it("prevents requests that exceed the maximum over the interval", function(done) {
      var counter = RateLimitedCounter({
        redis: redis.createClient(),
        interval: 300,
        maxInInterval: 30
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
        maxInInterval: 30
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
        maxInInterval: 30
      });

      async.times(100, function(n, next) {
        counter.increment(n % 3, next);
      }, function(err) {
        if (err) throw err;
        setTimeout(function() {
          async.times(100, function(n, next) {
            counter.increment(n % 3, next);
          }, function(err, results) {
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
        minDifference: 100
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
        })
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
          namespace: namespace,
          interval: 300,
          maxInInterval: 30,
        }),
        RateLimitedCounter({
          redis: client,
          namespace: namespace,
          interval: 300,
          maxInInterval: 30,
        })
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

  });
});