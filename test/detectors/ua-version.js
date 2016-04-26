'use strict';

var lo = require('lodash'),
    Q = require('q'),
    fs = require('fs'),
    moment = require('moment'),
    Chance = require('chance'),
    chance = new Chance(), 
    expect = require("chai").expect,
    validator = require('validator'),
    uaversion = require("../../lib/detectors/ua-version"),
    setup = require('../setup'),
    schemaArgs = setup.schemaArgs,
    schema,
    Schema,
    Visitor,
    Request,
    mockreq = require('../mockreq'); 

describe('ua-version detector', function(){
    // init db
    before(function (done) {
        setup.removeDb();
        schema = setup.getSchema();
        Schema = schema.Schema;
        Visitor = schema.Visitor;
        Request = schema.Request;
        return Schema.onConnected().then(done);
    });

    // remove db file
    after(function (done) {
        setup.removeDb();
        done();
    });

    var families = ['chrome', 'opera', 'firefox', 'ie', 'konqueror'];
    lo.forEach(families, function(family){
        var browsers = mockreq.getRandomBrowserRequest({count: 10, family: family}); 

        lo.forEach(browsers, function(browser){
            var browserid = browser.uaid,
                majver = browser.version && browser.version.major ? parseInt(browser.version.major) : null; 

            if (typeof(majver) !== 'number') return;
            var matchver = {
                '=': false,
                '>=': false,
                '<=': false,
                '~': false,
                '<': true,
                '>': true 
            };

            lo.forOwn(matchver, function(result, sign){
                it('should ' + (result ? 'pass' : 'fail') + ' browser user agent ' + browser.family + 
                    ' (' + browserid + ') when version ' + sign + ' ' + majver, function(done){
                    return Q().then(function(){
                        var v = new Visitor({
                                ip: chance.ip()
                            }),
                            r = new Request();

                        r.fromExpressRequest(browser);
                        r.visitor_id = 999;
                        var opt = {visitor: v, requests: r, version: {}};

                        opt.version[family] = sign + majver;

                        // try to throw in some bogus options for other families that would negate the expected result
                        lo.forEach(families, function(f){
                            if (f === family) return;
                            opt.version[f] = result ? '=666666' : '0.0.0 - 666666.0.0';
                        });
                        return uaversion.pass(opt); 
                    })
                    .then(function(passed){
                        expect(passed).to.equal(result);
                    })
                    .then(done)
                    .fail(done);
                });
            });
        });
    });
});
