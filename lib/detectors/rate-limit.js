'use strict';

var lo = require('lodash'),
    Q = require('q'),
    moment = require('moment'),
    config = {},
    debug = function(){
        if (! config.debug) return;
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[rate-limit]');

        var func = typeof(config.fdebug) === 'function' ? config.fdebug : console.log;
        return func.apply(this, args);
    },
    /**
     * Determines if the ip address has exceeded the passed rate limit definition(s)
     * 
     * @param {object} visitor 
     * @param {object} reqs         array of request objects, or single request object 
     * @param {object} opt          object of options
     * @param {object} opt.limit    array of limit object(s)
     * @param {number} opt.limit[].total        limit for the # of requests that are allowed within the timeframe. 
     * @param {number} opt.limit[].timeframe    timeframe milliseconds from the latest request. 
     *                              NOTE: make sure this is larger 
     *                              than botbouncer's detectFrequency setting, otherwise rate limit violations
     *                              may not be detected.
     * @return {object}             promise object, resolves with:
     *                              true if rate limit has been exceeded 
     *                              false if rate limit has not been exceeded 
     *                              null if unknown 
     *
     *
     */
    rateLimitExceeded = function(visitor, reqs, opt){
        var req = reqs instanceof Array ? reqs[0] : reqs,
            exceeded = false;

        opt = opt || {};
        lo.defaults(opt, {
            limit: []
        });

        if (! (opt.limit instanceof Array)) opt.limit = [opt.limit];

        lo.forEach(opt.limit, function(limit){
            if (! limit.total || ! limit.timeframe){
                debug('Error: invalid total/timeframe args:' + JSON.stringify(limit));
                exceeded = null;
                return; 
            }

            var firstreq = reqs[limit.total];

            // total requests count exceeded? 
            if (! firstreq){
                debug("ip has made " + reqs.length + " requests, has not exceeded " + limit.total + " total requests", visitor.ip);
                return; 
            }

            // compare timeframe start (cutoff) to first req requested time
            var start = moment(reqs[0].requested).utc().subtract(limit.timeframe, 'milliseconds'),
                result = moment(firstreq.requested).utc().isSameOrAfter(start);

            if (result){
                debug(limit.total + ' requests / ' + limit.timeframe + 'ms rate limit has been exceeded', visitor.ip);
                exceeded = true;
                return false;
            }
            else{
                debug('has made > ' + limit.total + ' requests, but not within the last ' + 
                    limit.timeframe + 'ms', visitor.ip);
            }
        });

        return Q.resolve(exceeded);
    };

module.exports = {
    pass: function(opt){
        config.debug = opt.debug;
        if (opt.botbouncer) config.fdebug = opt.botbouncer.debug;

        return rateLimitExceeded(opt.visitor, opt.requests, opt)
        .then(function(r){
            return Q.resolve(typeof(r) === 'boolean' ? !r : r);
        });
    }
};
