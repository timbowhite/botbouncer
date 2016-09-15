'use strict';

var lo = require('lodash'),
    dns = require('dns'),
    dnscache = require('dnscache')({enable: true}),
    Q = require('q'),
    constant = {
        searchEngine: {
            googlebot: {
                // https://support.google.com/webmasters/answer/1061943?hl=en
                ua: ['Googlebot', 'Mediapartners-Google', 'AdsBot-Google'],
                host: ['googlebot.com', 'google.com', 'googleusercontent.com'],
                dnslookup:{
                    forward: true 
                }
            },
            yahoo: {
                ua: ['Yahoo! Slurp'],
                host: ['yahoo.com', 'yahoo.net'],
                dnslookup:{
                    forward: true 
                }
            },
            bingbot: {
                ua: ['bingbot'],
                host: ['search.msn.com'],
                dnslookup:{
                    forward: true 
                }
            },
            yandex: {
                ua: 'http://yandex.com/bots',
                host: ['yandex.ru','yandex.net','yandex.com'],
                dnslookup:{
                    forward: true 
                }
            },
            baidu:{
                ua: 'http://www.baidu.com/search/spider.html',
                host: ['crawl.baidu.com'],
                dnslookup:{
                    // these guys don't have forward dns setup for bot hostnames
                    forward: false 
                }
            },
            uptimerobot:{
                ua: 'UptimeRobot', 
                host: ['uptimerobot.com'],
                dnslookup:{
                    forward: true 
                }

            }
        }
    },
    config = {},
    debug = function(){
        if (! config.debug) return;
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[ua-impostor]');

        var func = typeof(config.fdebug) === 'function' ? config.fdebug : console.log;
        return func.apply(this, args);
    },
    /**
     * Determines if the ip address resolves to the provided bot's hostname via reverse dns lookup 
     * 
     * @param {string} ip 
     * @param {object} botdef       definition object from constant.searchEngine 
     * @return {object}             promise object, resolves with
     *                              hostname string if the ip maps to the botdef's host, otherwise false
     */
    validateByReverseDnsLookup = function(ip, botdef){
        var p = Q.resolve(),
            hostnames, 
            ret = false;

        debug('performing reverse dns lookup', ip);

        // throws on invalid ip
        try{
            var def = Q.defer();
            dns.reverse(ip, function(err, res){
                hostnames = res;
                return def.resolve(err);
            });
            p = p.then(function(){ return def.promise });
        }
        catch(e){
            p = p.then(function(){ return e; });
        }

        return p.then(function(err){
            if (err){ 
                switch(err.code){
                    case 'ENOTFOUND': // Domain name not found.
                    case 'ENOTIMP': // DNS server does not implement requested operation. (invalid ip)
                    case 'EFORMERR': // no data returned 
                    case 'EBADQUERY': // bad query 
                    case 'EBADNAME': // Misformatted hostname 
                    case 'EBADSTR': // Misformatted string.
                    case 'ENONAME': // Given hostname is not numeric.
                    case 'ENODATA': // no data
                    case 'ESERVFAIL': // general server failure
                    case 'EINVAL': // invalid ip
                        if (! hostnames) hostnames = [];
                        break;

                    default:
                        return Q.reject(err);
                } 
            }

            var valid = false, limit = 10;
            debug('hostnames from dns lookup', hostnames, ip);

            // validate: 1 predefined hostname substring must be at the end of at least 1 hostname
            lo.forEach(hostnames, function(hostname){
                limit--;
                lo.forEach(botdef.host, function(botdefhost){
                    var io = hostname.indexOf(botdefhost);
                    if (io !== -1 && (io + botdefhost.length === hostname.length)){
                        valid = true;
                        ret = hostname;
                        debug('reverse dns lookup is valid', hostname, ip);
                        return false;
                    }
                });
                if (valid || limit <= 0) return false;
            });
            return Q.resolve(ret);
        });

    },
    /**
     * Determines if a hostname maps to an ip. 
     *
     * @param {string} ip 
     * @param {string} hostname 
     * @return {object}             promise object, resolves with true if hostname maps to ip, otherwise false 
     */
    validateByForwardDnsLookup = function(ip, hostname){
        var p = Q.resolve(), address;
        debug('performing forward dns lookup', hostname);

        try{
            var def = Q.defer();
            dns.lookup(hostname, function(err, res){
                address = res; 
                return def.resolve(err);
            });
            p = p.then(function(){ return def.promise });
        }
        catch(e){
            p = p.then(function(){ return e; });
        }

        return p.then(function(err){
            if (err){
                switch(err.code){
                    case 'ENOTFOUND': // Domain name not found.
                    case 'ENOTIMP': // DNS server does not implement requested operation. (invalid ip)
                    case 'EFORMERR': // no data returned 
                    case 'EBADQUERY': // bad query 
                    case 'EBADNAME': // Misformatted hostname 
                    case 'EBADSTR': // Misformatted string.
                    case 'ENONAME': // Given hostname is not numeric.
                    case 'ENODATA': // no data
                    case 'ESERVFAIL': // general server failure
                    case 'EINVAL': // invalid domain 
                        return false; 

                    default:
                        return Q.reject(err);
                }
            } 
            var ret = address === ip;
            if (ret) debug('forward dns lookup is valid', hostname, ip);
            return ret; 
        });
    },
    /**
     * Determines if a user-agent bot is who they claim to be by performing a reverse dns lookup on the ip, 
     * comparing to the expected host string, and then performing a forward dns lookup to ensure it maps back
     * to the ip.
     * 
     * @param visitor {object}  Visitor object
     * @param reqs {object}     Request object (or array of Request objects, first one will be used)
     * @param opt {object}      object of options
     * @return {object}         promise object, resolves with:
     *                          null if user agent does not match a known crawler bot
     *                          true if user agent matches a known crawler bot and the ip is valid or
     *                               the user agent does not match a known crawler bot
     *                          false if the user agent matches a known crawler bot and the ip is not valid
     */
    isValidByDns = function(visitor, reqs, opt){
        var abort = false,
            p = Q.resolve(null),        // case where user agent does not match a known crawler or bot
            ip = visitor.ip,
            req = reqs instanceof Array ? reqs[0] : reqs, 
            requa = req.getUserAgent(); 

        if (! requa) return p;

        opt = opt || {}; 
        lo.defaults(opt, {
        });

        lo.forOwn(constant.searchEngine, function(bot, se){
            if (! (bot.ua instanceof Array)) bot.ua = [bot.ua]; 

            lo.forEach(bot.ua, function(ua){
                if (requa.indexOf(ua) === -1) return;

                // matches, no need to check other bots
                debug('request claims to be ' + ua + ', validating', requa, ip);
                visitor.hostname = null;

                // reverse dns lookup
                p = p.then(function(){
                    visitor._lookedupHostname = true; // flag that reverse dns has been performed on this visitor
                    return validateByReverseDnsLookup(ip, bot) 
                    .then(function(hostname){
                        // invalid
                        if (! hostname) return false;

                        visitor.hostname = hostname;

                        // don't do forward lookup
                        if (! bot.dnslookup.forward) return true;

                        // forward dns lookup
                        return validateByForwardDnsLookup(ip, hostname);
                    });
                });
                abort = true;
                return false;
            }); 
            if (abort) return false;
        });
        return p; 
    };

module.exports = {
    pass: function(opt){
        config.debug = opt.debug;
        if (opt.botbouncer) config.fdebug = opt.botbouncer.debug;
        return isValidByDns(opt.visitor, opt.requests, opt);
    }
};
