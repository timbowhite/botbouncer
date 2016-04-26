'use strict';

var lo = require('lodash'),
    Q = require('q'),
    fs = require('fs'),
    moment = require('moment'),
    Chance = require('chance'),
    chance = new Chance(), 
    expect = require("chai").expect,
    validator = require('validator'),
    uaswitching = require("../../lib/detectors/ua-switching"),
    setup = require('../setup'),
    schemaArgs = setup.schemaArgs,
    schema,
    Schema,
    Visitor,
    Request,
    mockreq = require('../mockreq'); 

describe('ua-switching detector', function(){
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

    it('should fail visitor switching user agents on every request', function(done){
        var reqcount = 100,
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }), 
            uas = [];
        
        for(var i = 0; i < reqcount; i++){
            var r = new Request(), req; 
                
            do{
                req = mockreq.getRandomBrowserRequest(); 
                r.fromExpressRequest(req);
            } while(lo.includes(uas, r.getUserAgent())); 

            uas.push(r.getUserAgent());
            r.visitor_id = 999;
            requests.unshift(r);
        }

        return Q().then(function(){
            return uaswitching.pass({
                visitor: v, 
                requests: requests, 
                minRequests: 0, 
                maxRequests: 0,  
                timeframe: 0
            });
        })
        .then(function(passed){
            expect(passed).to.equal(false);
        })
        .then(done)
        .fail(done);
    });

    it('should fail visitor switching user agents on every request when request count >= minRequests', function(done){
        var reqcount = 100,
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }), 
            uas = [];
        
        for(var i = 0; i < reqcount; i++){
            var r = new Request(), req; 
                
            do{
                req = mockreq.getRandomBrowserRequest(); 
                r.fromExpressRequest(req);
            } while(lo.includes(uas, r.getUserAgent())); 

            uas.push(r.getUserAgent());
            r.visitor_id = 999;
            requests.unshift(r);
        }

        return Q().then(function(){
            return uaswitching.pass({
                visitor: v, 
                requests: requests, 
                minRequests: reqcount - 1,
                maxRequests: 0,  
                timeframe: 0
            });
        })
        .then(function(passed){
            expect(passed).to.equal(false);
        })
        .then(function(){
            return uaswitching.pass({
                visitor: v, 
                requests: requests, 
                minRequests: reqcount,
                maxRequests: 0,  
                timeframe: 0
            });
        })
        .then(function(passed){
            expect(passed).to.equal(false);
        })
        .then(done)
        .fail(done);
    });

    it('should fail visitor switching user agents on every request made in specified timeframe', function(done){
        // non-switching requests made over 5 minutes ago
        var timeframe = 5 * 60 * 1000,
            now = moment.utc(),
            requests = [],
            reqcount = 100, 
            v = new Visitor({
                ip: chance.ip()
            }),
            req,
            requa,
            uas = [];

        for(var i = 0; i < reqcount; i++){
            var r = new Request();

            if (! req){
                req = mockreq.getRandomBrowserRequest();
                r.fromExpressRequest(req);
                requa = r.getUserAgent();
            }

            r.fromExpressRequest(lo.cloneDeep(req));
            r.headers['user-agent'] = requa;

            r.requested = now.clone().subtract(timeframe + 1, 'milliseconds').toDate();
            r.visitor_id = 999;
            requests.unshift(r);
        }

        // switching requests made within 5 minutes ago
        for(var i = 0; i < reqcount; i++){
            var r = new Request(), req; 
                
            do{
                req = mockreq.getRandomBrowserRequest(); 
                r.fromExpressRequest(req);
            } while(lo.includes(uas, r.getUserAgent()));

            uas.push(r.getUserAgent());
            r.visitor_id = 999;
            r.requested = now.toDate();
            requests.unshift(r);
        }

        return Q().then(function(){
            return uaswitching.pass({
                visitor: v, 
                requests: requests, 
                minRequests: 0, 
                maxRequests: 0,
                timeframe: timeframe
            });
        })
        .then(function(passed){
            expect(passed).to.equal(false);
        })
        .then(done)
        .fail(done);
    });

    it('should pass visitor with < minRequests even if every request has a different ua', function(done){
        var reqcount = 100,
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }), 
            uas = [];
        
        for(var i = 0; i < reqcount; i++){
            var r = new Request(), req; 
                
            do{
                req = mockreq.getRandomBrowserRequest(); 
                r.fromExpressRequest(req);
            } while(lo.includes(uas, r.getUserAgent())); 

            uas.push(r.getUserAgent());
            r.visitor_id = 999;
            requests.unshift(r);
        }

        return Q().then(function(){
            return uaswitching.pass({
                visitor: v, 
                requests: requests, 
                minRequests: reqcount + 1, 
                maxRequests: 0,  
                timeframe: 0
            });
        })
        .then(function(passed){
            expect(passed).to.equal(true);
        })
        .then(done)
        .fail(done);
    });

    it('should pass visitor with < minRequests even if every request has a different ua and ' +
       'all requests were made within the specified timeframe', function(done){
        var reqcount = 100,
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }), 
            uas = [];
        
        for(var i = 0; i < reqcount; i++){
            var r = new Request(), req; 
                
            do{
                req = mockreq.getRandomBrowserRequest(); 
                r.fromExpressRequest(req);
            } while(lo.includes(uas, r.getUserAgent())); 

            uas.push(r.getUserAgent());
            r.visitor_id = 999;
            if (! r.requested) r.requested = moment.utc().toDate();
            requests.unshift(r);
        }

        return Q().then(function(){
            return uaswitching.pass({
                visitor: v, 
                requests: requests, 
                minRequests: reqcount + 1, 
                maxRequests: 0,  
                timeframe: 5 * 60 * 1000 
            });
        })
        .then(function(passed){
            expect(passed).to.equal(true);
        })
        .then(done)
        .fail(done);
    });

    it('should pass visitor who has not ua switched in the last maxRequests requests', function(done){
        var switchReqCount = 50,
            requests = [],
            v = new Visitor({
                ip: chance.ip()
            }), 
            uas = [];
        
        for(var i = 0; i < (switchReqCount - 1); i++){
            var r = new Request(), req; 
                
            do{
                req = mockreq.getRandomBrowserRequest(); 
                r.fromExpressRequest(req);
            } while(lo.includes(uas, r.getUserAgent())); 

            uas.push(r.getUserAgent());
            r.visitor_id = 999;
            requests.unshift(r);
        }

        // now add maxRequests non-switching requests
        var maxReqCount = 20,
            v = new Visitor({
                ip: chance.ip()
            }),
            requa,
            req,
            uas = [];

        for(var i = 0; i < maxReqCount; i++){
            var r = new Request();

            if (requa){
                r.fromExpressRequest(lo.cloneDeep(req));
                r.headers['user-agent'] = requa;
            }
            else{
                do{
                    req = mockreq.getRandomBrowserRequest();
                    r.fromExpressRequest(req);
                    requa = r.getUserAgent();
                } while(lo.includes(uas, requa));
            }

            r.visitor_id = 999;
            requests.unshift(r);
        }

        return Q().then(function(){
            return uaswitching.pass({
                visitor: v, 
                requests: requests, 
                minRequests: 0, 
                maxRequests: maxReqCount, 
                timeframe: 0
            });
        })
        .then(function(passed){
            expect(passed).to.equal(true);
        })
        .then(done)
        .fail(done);
    });
});
