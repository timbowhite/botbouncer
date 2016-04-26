'use strict';

var lo = require('lodash'),
    Q = require('q'),
    fs = require('fs'),
    moment = require('moment'),
    expect = require("chai").expect,
    validator = require('validator'),
    chance = require('chance'),
    uaimpostor = require("../../lib/detectors/ua-impostor"),
    mockreq = require('../mockreq'),
    setup = require('../setup'),
    schemaArgs = setup.schemaArgs,
    schema,
    Schema,
    Visitor,
    Request, 
    // list of ips that don't belong to valid bots in mockreq
    ips = mockreq.ip.private.concat(mockreq.ip.bogus).concat([
        '118.168.71.136',
        '162.243.169.130',
        '5.142.117.237',
        '23.254.209.242',
        'FE80:0000:0000:0000:903A:1C1A:E802:11E4',
        '2001:db8:a0b:12f0::1',
        '24a6:57:c:36cf:0000:5efe:109.205.140.116',
        'fea3:c65:43ee:54:e2a:2357:4ac4:732'
    ]);

describe("ua-impostor detector", function() {
    // init db
    before(function (done) {
        setup.removeDb();
        schema = setup.getSchema();
        Schema = schema.Schema;
        Visitor = schema.Visitor;
        Request = schema.Request; 
        return Schema.onConnected().then(done);
    });

    // remove db file (if any)
    after(function (done) {
        setup.removeDb();
        done();
    });

    lo.forOwn(mockreq.agent.bot, function(bot, botid){
        // valid crawler bots
        it('should validate real ' + botid + ' with ip = ' + bot.ip + ' via DNS', function(done){
            var v, r;

            return Q().then(function(){
                var p = Q.resolve();
                v = new Visitor({
                    ip: bot.ip 
                });
                r = new Request(); 
                r.fromExpressRequest(bot);
                r.visitor_id = 999;

                return uaimpostor.pass({visitor: v, requests: r}); 
            })
            .then(function(valid){
                expect(valid).to.equal(true);
                expect(validator.isFQDN(v.hostname)).to.equal(true);
            })
            .then(done)
            .fail(function(err){
                done(err);
            }); 
        });

        // fake crawler bots 
        lo.forEach(ips, function(ip){
            it('should detect fake ' + botid + ' with ip = ' + ip + ' via DNS', function(done){
                var v, r;

                return Q().then(function(){
                    var p = Q.resolve();
                    v = new Visitor({
                        ip: ip 
                    });
                    r = new Request(); 
                    r.fromExpressRequest(bot);
                    r.visitor_id = 999;

                    return uaimpostor.pass({visitor: v, requests: r}); 
                })
                .then(function(valid){
                    expect(valid).to.equal(false);
                    if (v.hostname){
                        expect(validator.isFQDN(v.hostname, {require_tld: false})).to.equal(true);
                    }
                    else{
                        expect(v.hostname).to.equal(null);
                    }
                })
                .then(done)
                .fail(function(err){
                    done(err);
                });
            });
        });
    });

    // regular browsers 
    var browsers = mockreq.getRandomBrowserRequest({count: 5});
    lo.forOwn(browsers, function(browser){
        var browserid = browser.uaid,
            ips2 = lo.cloneDeep(ips);

        // add valid crawler bot ips 
        lo.forOwn(mockreq.agent.bot, function(bot, botid){
            ips2.push(bot.ip);
        });

        // loop ips 
        lo.forEach(ips2, function(ip){
            it('should ignore regular browser ' + browserid + ' with ip = ' + ip, function(done){
                var v, r;

                return Q().then(function(){
                    var p = Q.resolve();
                    v = new Visitor({
                        ip: ip
                    });
                    r = new Request(); 
                    r.fromExpressRequest(browser);
                    r.visitor_id = 999;

                    return uaimpostor.pass({visitor: v, requests: r}); 
                })
                .then(function(valid){
                    expect(valid).to.equal(null);
                    expect(v.hostname).to.equal(null);
                })
                .then(done)
                .fail(function(err){
                    done(err);
                });
            });
        });
    });
});
