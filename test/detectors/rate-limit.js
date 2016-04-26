'use strict';

var lo = require('lodash'),
    Q = require('q'),
    fs = require('fs'),
    moment = require('moment'),
    Chance = require('chance'),
    chance = new Chance(), 
    expect = require("chai").expect,
    validator = require('validator'),
    ratelimit = require("../../lib/detectors/rate-limit"),
    setup = require('../setup'),
    schemaArgs = setup.schemaArgs,
    schema,
    Schema,
    Visitor,
    Request,
    mockreq = require('../mockreq'); 

describe('rate-limit detector', function(){
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

    it('should pass visitor that has made exactly total requests in allowed timeframe', function(done){
        var reqcount = 1000,
            timeframe = reqcount, 
            start = moment.utc().subtract(timeframe, 'milliseconds'),
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }); 

        for(var i = 0; i < reqcount; i++){
            var r = new Request();
            r.visitor_id = 999;
            r.requested = start.add(1, 'milliseconds').toDate();
            requests.unshift(r);
        }

        return Q().then(function(){
            return ratelimit.pass({
                visitor: v, 
                requests: requests,
                limit: {
                    total: reqcount,
                    timeframe: timeframe
                }
            });
        })
        .then(function(passed){
            expect(passed).to.equal(true);
        })
        .then(done)
        .fail(done);
    });

    it('should pass visitor that has made exactly total requests in allowed timeframe with multiple limits', function(done){
        var reqcount = 1000,
            timeframe = reqcount, 
            start = moment.utc().subtract(timeframe, 'milliseconds'),
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }); 

        for(var i = 0; i < reqcount; i++){
            var r = new Request();
            r.visitor_id = 999;
            r.requested = start.add(1, 'milliseconds').toDate();
            requests.unshift(r);
        }

        return Q().then(function(){
            return ratelimit.pass({
                visitor: v, 
                requests: requests,
                limit: [{
                    total: reqcount,
                    timeframe: timeframe
                }, {
                    total: reqcount + 1, 
                    timeframe: timeframe - 500
                }]
            });
        })
        .then(function(passed){
            expect(passed).to.equal(true);
        })
        .then(done)
        .fail(done);
    });

    it('should fail visitor that exceeds total option requests by 1 in timeframe', function(done){
        var reqcount = 1000,
            timeframe = reqcount,
            start = moment.utc().subtract(timeframe, 'milliseconds'),
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }); 

        for(var i = 0; i < reqcount; i++){
            var r = new Request();
            r.visitor_id = 999;
            r.requested = start.add(1, 'milliseconds').toDate();
            requests.unshift(r);
        }

        return Q().then(function(){
            return ratelimit.pass({
                visitor: v, 
                requests: requests,
                limit: {
                    total: reqcount - 1,
                    timeframe: timeframe 
                }
            });
        })
        .then(function(passed){
            expect(passed).to.equal(false);
        })
        .then(done)
        .fail(done);
    });

    it('should fail visitor that exceeds total requests by 1 in timeframe with multiple limits', function(done){
        var reqcount = 1000,
            timeframe = reqcount,
            start = moment.utc().subtract(timeframe, 'milliseconds'),
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }); 

        for(var i = 0; i < reqcount; i++){
            var r = new Request();
            r.visitor_id = 999;
            r.requested = start.add(1, 'milliseconds').toDate();
            requests.unshift(r);
        }

        return Q().then(function(){
            return ratelimit.pass({
                visitor: v, 
                requests: requests,
                limit: [{
                    total: reqcount * 100,
                    timeframe: parseInt(timeframe / 2)
                },{
                    total: reqcount - 1,
                    timeframe: timeframe
                }]
            });
        })
        .then(function(passed){
            expect(passed).to.equal(false);
        })
        .then(done)
        .fail(done);
    });
});
