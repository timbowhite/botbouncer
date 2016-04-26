'use strict';

var lo = require('lodash'),
    Q = require('q'),
    fs = require('fs'),
    moment = require('moment'),
    escapeStringRegexp = require('escape-string-regexp'),
    Chance = require('chance'),
    chance = new Chance(), 
    expect = require("chai").expect,
    validator = require('validator'),
    uabot = require("../../lib/detectors/ua-bot"),
    setup = require('../setup'),
    schemaArgs = setup.schemaArgs,
    schema,
    Schema,
    Visitor,
    Request,
    mockreq = require('../mockreq'); 

describe('ua-bot detector', function(){
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

    // pass browser user agents 
    lo.forEach(mockreq.getBrowserUserAgentStrings(), function(ua, i){
        it('should pass browser user agent: ' + ua, function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: chance.ip()
                });

                var r = new Request();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = 999;
                r.headers['user-agent'] = ua;
                return uabot.pass({visitor: v, requests: r});

            })
            .then(function(passed){
                expect(passed).to.equal(true);
            })
            .then(done)
            .fail(done);
        });
    });

    // fail bot user agents 
    lo.forEach(mockreq.getBotUserAgentStrings(), function(ua){
        it('should fail bot user agent: ' + ua, function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: chance.ip()
                });

                var r = new Request();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = 999;
                r.headers['user-agent'] = ua;
                return uabot.pass({visitor: v, requests: r});

            })
            .then(function(passed){
                expect(passed).to.equal(false);
            })
            .then(done)
            .fail(done);
        });
    });

    lo.forOwn(lo.cloneDeep(mockreq.agent.bot), function(bot, botid){
        it('should pass ' + botid + ' when provided a case-insensitive matching exclude string', function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: bot.ip 
                }),
                exclude = []; 

                var r = new Request(); 
                r.fromExpressRequest(bot);
                r.visitor_id = 999;
                exclude.push(r.getUserAgent().substr(r.getUserAgent().length - 7).toUpperCase());
                exclude.push('no-match-here------');

                return uabot.pass({visitor: v, requests: r, exclude: exclude}); 
            })
            .then(function(passed){
                expect(passed).to.equal(true);
            })
            .then(done)
            .fail(done);
        });

        it('should pass ' + botid + ' when provided a matching exclude regular expression', function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: bot.ip 
                }),
                exclude = []; 

                var r = new Request();
                r.fromExpressRequest(bot);
                r.visitor_id = 999;
                var str = r.getUserAgent().substr(r.getUserAgent().length - 7); 
                exclude.push(new RegExp(escapeStringRegexp(str)));
                exclude.push('no-match-here------');

                return uabot.pass({visitor: v, requests: r, exclude: exclude}); 
            })
            .then(function(passed){
                expect(passed).to.equal(true);
            })
            .then(done)
            .fail(done);
        });

        it('should fail ' + botid + ' when provided a a non-matching exclude string', function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: bot.ip 
                }),
                exclude = []; 

                var r = new Request(); 
                r.fromExpressRequest(bot);
                r.visitor_id = 999;
                exclude.push('no-match-here------');
                exclude.push('໒( • ͜ʖ • )७');

                return uabot.pass({visitor: v, requests: r, exclude: exclude}); 
            })
            .then(function(passed){
                expect(passed).to.equal(false);
            })
            .then(done)
            .fail(done);
        });

        it('should fail ' + botid + ' when provided a non-matching exclude regular expression', function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: bot.ip 
                }),
                exclude = []; 

                var r = new Request();
                r.fromExpressRequest(bot);
                r.visitor_id = 999;
                var str = r.getUserAgent().substr(r.getUserAgent().length - 7); 
                exclude.push(new RegExp(escapeStringRegexp(str.toUpperCase())));
                exclude.push('no-match-here------');

                return uabot.pass({visitor: v, requests: r, exclude: exclude}); 
            })
            .then(function(passed){
                expect(passed).to.equal(false);
            })
            .then(done)
            .fail(done);
        });

        it('should fail ' + botid + ' by default', function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: bot.ip 
                }),
                exclude = []; 

                var r = new Request();
                r.fromExpressRequest(bot);
                r.visitor_id = 999;

                return uabot.pass({visitor: v, requests: r, exclude: exclude}); 
            })
            .then(function(passed){
                expect(passed).to.equal(false);
            })
            .then(done)
            .fail(done);
        });
    });

    var bogus = [
        '',
        '                         ',
        null,
        false,
        true,
        undefined,
        {},
        []
    ];
    lo.forOwn(bogus, function(ua){
        it('should fail on empty and non-string ua: ' + ua , function(done){
            return Q().then(function(){
                var v = new Visitor({
                    ip: chance.ip() 
                });

                var r = new Request();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = 999;
                r.headers['user-agent'] = ua;
                return uabot.pass({visitor: v, requests: r});

            })
            .then(function(passed){
                expect(passed).to.equal(false);
            })
            .then(done)
            .fail(done);
        });
    });
});
