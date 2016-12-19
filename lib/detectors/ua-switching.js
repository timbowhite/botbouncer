'use strict';

var lo = require('lodash'),
    Q = require('q'),
    moment = require('moment'),
    config = {},
    debug = function(){
        if (! config.debug) return;
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[ua-switching]');

        var func = typeof(config.fdebug) === 'function' ? config.fdebug : console.log;
        return func.apply(this, args);
    },
    /**
     * Checks if the visitor is using a different ua for every request. 
     * 
     * @param {object} visitor 
     * @param {object} reqs         array of request objects, or single request object 
     * @param {object} opt          object of options
     * @param {number} opt.minRequests visitor must have at least this many requests to be considered, 0 to disable 
     * @param {number} opt.maxRequests max # of latest requests to inspect, 0 to disable
     * @param {number} opt.timeframe  only consider requests made this many milliseconds prior 
     *                              to the last request, 0 to disable
     * @return {boolean}            true if visitor is switching their user agent
     *                              false if not
     */
    uaSwitching = function(visitor, reqs, opt){
        var uas = [], 
            cutoff;

        opt = opt || {};
        lo.defaults(opt, {
            minRequests: undefined, 
            maxRequests: undefined, 
            timeframe: undefined 
        });

        reqs = reqs instanceof Array ? reqs : [reqs];

        // meets min request requirement?
        if (opt.minRequests && reqs.length < opt.minRequests){
            debug('skipping, request count < minRequests option', visitor.ip); 
            return false;
        }

        if (opt.timeframe){
            cutoff = moment(reqs[0].requested).utc().subtract(opt.timeframe, 'milliseconds');
        }

        lo.forEach(reqs, function(req, i){
            if (opt.maxRequests && ((i + 1) > opt.maxRequests)) return false;
            if (cutoff && (moment(req.requested).utc().isBefore(cutoff))) return false;
            uas.push(req.getUserAgent());
        });

        var uacnt = uas.length;

        // meets min requirement against timeframe?
        if (uacnt <= 1 || (opt.minRequests && uacnt < opt.minRequests)) return false;

        var uniquas = lo.uniq(uas).length,
            result = uniquas >= uacnt;
        debug(
            (result ? 'is' : 'is not') + ' switching, ' + 
            uniquas + " unique ua's of " + uacnt + " inspected requests",
            visitor.ip
        );
        return result;
    };

module.exports = {
    pass: function(opt){
        config.debug = opt.debug;
        if (opt.botbouncer) config.fdebug = opt.botbouncer.debug;

        return Q().then(function(){
            return uaSwitching(opt.visitor, opt.requests, opt);
        })
        .then(function(r){
            return Q.resolve(typeof(r) === 'boolean' ? !r : r); 
        });
    }
};
