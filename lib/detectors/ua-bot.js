'use strict';

var lo = require('lodash'),
    useragent = require('useragent'),
    isbot = require('isbot'),
    Q = require('q'),
    config = {},
    debug = function(){
        if (! config.debug) return;
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[ua-bot]');

        var func = typeof(config.fdebug) === 'function' ? config.fdebug : console.log;
        return func.apply(this, args);
    },
    useragentUpdated = false,
    /**
     * Determines if the latest request is a bot based it's user agent. 
     * 
     * @param {object} visitor 
     * @param {object} reqs         array of request objects, or single request object 
     * @param {object} [opt]        object of options
     * @param {array}  [opt.exclude] array of strings and/or regular expression objcets of bot user agents to ignore.
     *                              If a provided string (case insensitive) is contained in the user agent string,
     *                              or a regexp matches the latest request's 
     *                              user agent, then this function resolves with false
     * @param {bool} [opt.emptyIsBot] Determine to be a bot if the request does not have a user agent string,
     *                              default = true.
     * @param {bool} [opt.aggressive] Determine to be a bot if useragent module's parsed object family === 'Other' 
     *                              or device.family === 'Other'. default = false
     * @param {bool} [opt.useragentUpdate] flag to update the useragent module's user agent string data. If true,
     *                              makes a remote request that is only performed once per require. Default = false.  
     * @return {object}             promise object, resolves with:
     *                              true if user agent matches a known bot, otherwise false 
     *
     */
    isUaBot = function(visitor, reqs, opt){
        var req = reqs instanceof Array ? reqs[0] : reqs,
            requa = req.getUserAgent();

        opt = opt || {};
        lo.defaults(opt, {
            exclude: [], 
            emptyIsBot: true,
            aggressive: false, 
            useragentUpdate: false
        });

        if (opt.emptyIsBot && (typeof(requa) !== 'string' || requa.trim() === '')){
            return Q.resolve(true);
        }

        requa = String(requa);

        // array of regex and string
        if (typeof(opt.exclude) === 'object' && (opt.exclude instanceof Array)){
            var excluded = false;
            lo.forEach(opt.exclude, function(ex){
                // partial match of string
                if (typeof(ex) === 'string' && requa.toLowerCase().indexOf(ex.toLowerCase()) !== -1){
                    excluded = true;
                    return false;
                }

                // regex ex 
                if ((ex instanceof RegExp) && ex.test(requa)){
                    excluded = true; 
                    return false;
                }
            });
            if (excluded){
                debug('skipping, ua is excluded', requa, visitor.ip);
                return Q.resolve(false); 
            }
        }

        if (isbot(requa)){
            debug('determined ua to be a bot via isbot module', requa, visitor.ip);
            return Q.resolve(true);
        }

        // update useragent?
        if (! useragentUpdated && opt.useragentUpdate){
            var uaerr;
            try{
                useragent(true);
            }
            catch(e){
                uaerr = e;
            }
            if (! uaerr) useragentUpdated = true;
        }

        if (typeof(visitor._uap) !== 'object') visitor._uap = useragent.lookup(requa);
        if (visitor._uap.device && visitor._uap.device.family === 'Spider'){
            debug('determined ua to be a bot via useragent module', requa, visitor.ip);
            return Q.resolve(true);
        }
        if (opt.aggressive && (visitor._uap.family === 'Other')){ 
            debug('determined ua to be a bot via useragent module (aggresive mode and family = Other)', requa, visitor.ip);
            return Q.resolve(true);
        }

        debug('ua is not a bot', requa, visitor.ip);
        return Q.resolve(false);
    };

module.exports = {
    pass: function(opt){
        config.debug = opt.debug;
        if (opt.botbouncer) config.fdebug = opt.botbouncer.debug;
        return isUaBot(opt.visitor, opt.requests, opt).then(function(isbot){
            return Q.resolve(! isbot);
        });
    }
};
