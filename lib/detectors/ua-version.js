'use strict';

var useragent = require('useragent');
require('useragent/features');

var lo = require('lodash'),
    Q = require('q'),
    config = {},
    debug = function(){
        if (! config.debug) return;
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[ua-version]');

        var func = typeof(config.fdebug) === 'function' ? config.fdebug : console.log;
        return func.apply(this, args);
    },
    // additional ua families that should match
    familyAlias = {
        firefox: ['firefox alpha', 'firefox beta']
    };
    require('useragent/features');
    var useragentUpdated = false,
    /**
     * Determines if the latest request satisfies the passed user agent versions requirements.
     * 
     * @param {object} visitor 
     * @param {object} reqs         array of request objects, or single request object 
     * @param {object} opt          object of options
     * @param {object} opt.version  object of key/vals where the key is a case-insensitive browser family ('firefox', 
     *                              'chrome') and the val is a version number string that when satisfied, 
     *                              will consider the browser/user agent to be valid. 
     *                              The version number string should be in the format
     *                              for the useragent module's satisfies (https://github.com/3rd-Eden/useragent#user-content-adding-more-features-to-the-useragent) function, examples:
     *
     *                              'IE': '>6',  // passes for internet explorer 7 and higher 
     *                              'opera': '=10', // pass for opera 10 only
     *                              'firefox': '42.2 - 50.3', // pass for firefox 42.2 thru 50.3 (inclusive)
     *                              'Chrome': '~1.2.3', // pass for chrome >=1.2.3 <1.3.0.
     *
     *                              The version matching will only be attempted if the user agent string's parsed
     *                              family matches a family in the specified opt.version object.
     * @param {bool} [opt.useragentUpdate] Flag to update the useragent module's user agent string data. If true,
     *                              makes a remote request that is only performed once per require. Default = false.  
     * @return {object}             promise object, resolves with:
     *                              true if user agent version is considered to be ok based on the passed opt.version 
     *                              false if user agent string does not satisfy the specified version range 
     *                              null if inconclusive (ie. the parsed ua family didn't match a passed family)
     *
     *
     */
    uaVersionMet = function(visitor, reqs, opt){
        var req = reqs instanceof Array ? reqs[0] : reqs,
            requa = req.getUserAgent();

        opt = opt || {};
        lo.defaults(opt, {
            version: {},
            useragentUpdate: false
        });

        if (! Object.keys(opt.version).length){
            debug('Error: no user agent family/versions were passed in the version parameter.', visitor.ip);
            return Q.resolve(null);
        }

        requa = String(requa);

        // lowercase all keys of version object, and make sure versions are formatted major.minor.patch
        var version = lo.transform(opt.version, function(result, val, key) {
            result[key.toLowerCase()] = val;
        }),
        family,
        result;

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

        // reuse previously parsed user agent string
        if (typeof(visitor._uap) !== 'object') visitor._uap = useragent.lookup(requa);

        if (! visitor._uap.family || typeof(visitor._uap.family) !== 'string'){
            debug("no parsed family returned from useragent module", requa, visitor.ip);
            return Q.resolve(null);
        }
        family = visitor._uap.family.toLowerCase();

        // does the parsed family matched a passed version family?
        if (! (family in version)){
            // check if parsed family matches an alias 
            var foundalias = false;
            lo.forOwn(version, function(vstr, v){
                if (! (v in familyAlias)) return;

                var idx;
                if ((idx = familyAlias[v].indexOf(family)) !== -1){ 
                    debug("ua family '" + family + '" matched family alias "' + v, requa, visitor.ip); 
                    foundalias = true;
                    family = v; 
                    return false;
                }
            });

            if (! foundalias) return Q.resolve(null);
        }

        try{
            result = visitor._uap.satisfies(version[family]);
        }
        catch(e){
            var err = new Error(
                'Error when checking if parsed user agent satisfies: ' + family + '/' + version[family] + ', ' +
                (e.stack || e)
            );
            return Q.reject(err);
        }
        debug('ua version ' + (result ? 'matched' : 'didnt match'), family, version[family], requa, visitor.ip); 
        return Q.resolve(result);
    };

module.exports = {
    pass: function(opt){
        config.debug = opt.debug;
        if (opt.botbouncer) config.fdebug = opt.botbouncer.debug;

        return uaVersionMet(opt.visitor, opt.requests, opt).then(function(r){
            // negate result if true/false
            return Q.resolve(typeof(r) === 'boolean' ? ! r : r);
        });
    }
};
