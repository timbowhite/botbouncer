'use strict';

var lo = require('lodash'),
    Q = require('q'),
    fs = require('fs'),
    moment = require('moment'),
    expect = require("chai").expect,
    mockreq = require('./mockreq'),
    Url = require('url'),
    ipaddr = require('ipaddr.js'),
    escapeStringRegexp = require('escape-string-regexp'),
    validator = require('validator'),
    BotBouncer = require('index'),
    botbouncer = new BotBouncer(),
    events = require('events'),
    httpMocks = require('node-mocks-http'),
    Chance = require('chance'),
    path = require('path'),
    chance = new Chance(), 
    bitcorelib = require('bitcore-lib'),

    setup = require('./setup'),
    util = require('./../lib/utility'),
    initOpt = {
        debug: false, 
        dbConfig: setup.schemaArgs.dbConfig,
        payment: {
            bitcoin: {
                masterPublicKey: mockreq.getRandomHdPubKey()
            }
        }
    };

describe("botbouncer", function() {
    before(function(done){
        setup.removeDb();
        done();
    });
    after(function(done){
        setup.removeDb();
        done();
    });

    describe("init", function() {
        beforeEach(function(done){
            botbouncer.emitter.removeAllListeners();
            done();
        });

        it('should return promise rejection on bad init', function(done){
            var opt = lo.cloneDeep(initOpt),
                emitted = false;

            lo.merge(opt, {
                dbConfig:{
                    driver: 'baddriver',
                    database: 'something.db'
                }
            }); 

            botbouncer.emitter.on('error', function(err){
                emitted = err;
            }); 

            return botbouncer.init(opt)
            // should not get here
            .then(function(){
                return done(new Error('failed to reject get promse reject on init'));
            })
            .fail(function(err){
                expect(typeof(err)).to.equal('object');
                expect(err).to.be.an.instanceOf(Error);
                expect(emitted).to.deep.equal(err);
                done();
            })
        });

        it('should callback with error on bad init', function(done){
            var opt = lo.cloneDeep(initOpt),
                emitted = false;

            lo.merge(opt, {
                dbConfig:{
                    driver: 'baddriver',
                    database: 'something.db'
                }
            }); 

            botbouncer.emitter.on('error', function(err){
                emitted = err; 
            });

            botbouncer.init(opt, function(err){
                expect(typeof(err)).to.equal('object');
                expect(err).to.be.an.instanceOf(Error);
                expect(emitted).to.deep.equal(err);
                done();
            });
        });

        it('should create a ' + path.basename(initOpt.dbConfig.database) + ' file', function(done){
            return botbouncer.init(lo.cloneDeep(initOpt))
            .then(function(){
                try{
                    expect(fs.statSync(initOpt.dbConfig.database).isFile()).to.equal(true);
                }
                catch (err){
                    return done(err); 
                }
                done();
            })
            .fail(function(err){
                done(err);
            });
        });

        it('should create a single db_version row in the meta table', function(done){
            return botbouncer.init(lo.cloneDeep(initOpt))
            .then(function(){
                var def = Q.defer();
                var Meta = botbouncer.getModelMeta();
                Meta.find({where: {key: 'db_version'}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    var version = res[0];
                    expect(util.isPositiveInteger(version.val)).to.equal(true);
                    def.resolve();
                });
                return def.promise;
            })
            .then(done)
            .fail(done);
        });

        it('should deep merge passed options and detector options with default options', function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                banDuration: 10000,
                bounce: { 
                    contentType: 'foo/bar',
                    statusCode: 666
                },
                detectors: {
                    'ua-impostor': {
                        allowOnPass: false,
                        order: 0
                    },
                    'ua-bot': {
                        allowOnPass: true,
                        order: 1
                    },
                    'ua-version': {
                        enabled: false
                    }, 
                    'ua-switching': {
                        enabled: false
                    },
                    'rate-limit': {
                        enabled: false
                    }
                }
            });
            return botbouncer.init(opt)
            .then(function(){
                var opt = botbouncer.getOpt();
                expect(opt.banDuration).to.equal(10000);
                expect(opt.bounce.contentType).to.equal('foo/bar');
                expect(opt.bounce.statusCode).to.equal(666);

                expect(opt.allowDuration).to.equal(botbouncer.optDefault.allowDuration);
                expect(opt.bounce.enabled).to.equal(botbouncer.optDefault.bounce.enabled);
                expect(opt.bounce.body.banned).to.equal(botbouncer.optDefault.bounce.body.banned);

                // detector opts 
                expect(typeof(opt.detectors)).to.equal('object');

                var uaimpdef = botbouncer.optDefault.detectors['ua-impostor']; 
                expect(opt.detectors['ua-impostor'].allowOnPass).to.equal(false);
                expect(opt.detectors['ua-impostor'].banOnFail).to.equal(uaimpdef.banOnFail);
                expect(opt.detectors['ua-impostor'].order).to.equal(0);

                var uabotdef = botbouncer.optDefault.detectors['ua-bot'];
                expect(opt.detectors['ua-bot'].allowOnPass).to.equal(true);
                expect(opt.detectors['ua-bot'].banOnFail).to.equal(uabotdef.banOnFail);
                expect(opt.detectors['ua-bot'].exclude).to.deep.equal(uabotdef.exclude);
                expect(opt.detectors['ua-bot'].order).to.equal(1);

                // ensure disable detectors aren't set to be run
                expect(opt.detectorsOrder).to.deep.equal(['ua-impostor', 'ua-bot']);
            })
            .then(done)
            .fail(done);
        });
    });

    describe("saveVisitorRequest", function() {
        beforeEach(function(done) {
            botbouncer.emitter.removeAllListeners();

            return botbouncer.init(lo.cloneDeep(initOpt))
            .then(done)
            .fail(done);
        });
 
        it('should return a visitor object when called with an express request', function(done){
            var req = mockreq.getRandomBrowserRequest();
            req.ip = '93.18.220.156'; 

            return botbouncer.saveVisitorRequest(req)
            .then(function(visitor){
                expect(typeof(visitor)).to.equal('object');
                expect(typeof(visitor.id)).to.equal('number');
                expect(visitor.id > 0).to.equal(true);
                expect(visitor.ip).to.equal(req.ip);
                expect(visitor.status_id).to.equal(null);

                // check request created
                visitor.requests({}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(typeof(res[0].id)).to.equal('number');
                    expect(res[0].id > 0).to.equal(true);
                    expect(res[0].visitor_id).to.equal(visitor.id);
                    expect(typeof(res[0].headers)).to.equal('object');
                    expect(res[0].headers['user-agent']).to.equal(req.headers['user-agent']);
                    done(); 
                });
            })
            .fail(done);
        });

        var reqcount = 100;
        it('should only create 1 visitor when called ' + reqcount + 'x with a req with the same ip', function(done){
            var req = mockreq.getRandomBrowserRequest(),
                i = 0,
                p = [];

            req.ip = chance.ip(); 

            while(i < reqcount){
                p.push(botbouncer.saveVisitorRequest(req));
                i++;
            }
            return Q.all(p)
            .then(function(){
                var Visitor = botbouncer.getModelVisitor();
                Visitor.find({where: {ip: req.ip}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    var visitor = res[0];

                    // check request created
                    visitor.requests({}, function(err, res){
                        expect(err).to.equal(null);
                        expect(res.length).to.equal(reqcount);
                        done();
                    });
                });
            })
            .fail(done);
        });

        it("should create " + reqcount + " visitors + request when called " + reqcount + "x with reqs with random ip's", function(done){
            var i = 0,
                ip,
                ips = [],
                p = [],
                now = moment.utc();

            while(i < reqcount){
                while(lo.includes(ips, (ip = chance.ip()))){}; 
                ips.push(ip);
                var req = mockreq.getRandomBrowserRequest();
                req.ip = ip;
                p.push(botbouncer.saveVisitorRequest(req));
                i++;
            }

            return Q.all(p)
            .then(function(){
                var Visitor = botbouncer.getModelVisitor(),
                    Request = botbouncer.getModelRequest();

                Visitor.find({where: {created: {gte: now.toDate()}}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(reqcount);

                    Request.find({where: {requested: {gte: now.toDate()}}}, function(err, res){
                        expect(err).to.equal(null);
                        expect(res.length).to.equal(reqcount); 
                        done();
                    });
                });
            })
            .fail(done);
        });
    });
    describe("shouldIgnorePath", function(){
        // custom function
        it('should include when passed empty includePath and excludePath', function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                includePath: [], 
                excludePath: []
            });
            return botbouncer.init(opt)
            .then(function(){
                var req = mockreq.getRandomBrowserRequest();
                return botbouncer.shouldIgnorePath(req)
                .then(function(excluded){
                    expect(excluded).to.equal(false);
                });
            })
            .then(done)
            .fail(done);
        });

        context('includePath', function(){
            // custom function
            it('should include when custom function calls callback with true', function(done){
                var opt = lo.cloneDeep(initOpt);
                lo.merge(opt, {
                    includePath: function(req, done){
                        done(true);
                    }
                });
                return botbouncer.init(opt)
                .then(function(){
                    var req = mockreq.getRandomBrowserRequest();
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should exclude when custom function calls callback with false', function(done){
                var opt = lo.cloneDeep(initOpt);
                lo.merge(opt, {
                    includePath: function(req, done){
                        done(false);
                    }
                }); 
                return botbouncer.init(opt)
                .then(function(){
                    var req = mockreq.getRandomBrowserRequest();
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
            // string
            it('should include when passed a req that exact matches an include path string', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, false),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    includePath: [ 
                       '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                       purl.path
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should include when passed a req that partial matches an include path string', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, true),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    includePath: [ 
                        '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        purl.pathname
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should exclude when passed a req that does not match any includePath string', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    includePath: [ 
                        '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        '/?zzzzzz=yyyyyy'
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
            // regexp
            it('should include when passed a req that exact matches an includePath regex', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, false),
                    path = purl.pathname,
                    regex = new RegExp(escapeStringRegexp(path)),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    includePath: [ 
                       '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                       regex
                    ]
                });
        
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should include when passed a req that partial matches an includePath regex', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, true),
                    pieces = purl.pathname.split('/'),
                    regex = new RegExp(escapeStringRegexp(pieces[0] + '/' + pieces[1])),
                    opt = lo.cloneDeep(initOpt); 

                lo.merge(opt, {
                    includePath: [ 
                        '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        regex
                    ]
                });

                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should exclude when passed a req that does match any includePath regex', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, true),
                    regex = new RegExp(escapeStringRegexp(purl.pathname.toUpperCase())),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    includePath: [ 
                        '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        regex
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
        });
        context('excludePath', function(){
            // custom function
            it('should exclude when custom function calls callback with true', function(done){
                var opt = lo.cloneDeep(initOpt);
                lo.merge(opt, {
                    excludePath: function(req, done){
                        done(true);
                    }
                });
                return botbouncer.init(opt)
                .then(function(){
                    var req = mockreq.getRandomBrowserRequest();
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should not exclude when custom function calls callback with false', function(done){
                var opt = lo.cloneDeep(initOpt);
                lo.merge(opt, {
                    excludePath: function(req, done){
                        done(false);
                    }
                }); 
                return botbouncer.init(opt)
                .then(function(){
                    var req = mockreq.getRandomBrowserRequest();
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
            // string
            it('should exclude when passed a req that exact matches an exclude path string', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, false),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    excludePath: [ 
                       '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                       purl.path
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should exclude when passed a req that partial matches an exclude path string', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, true),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    excludePath: [ 
                        '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        purl.pathname
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should not exclude when passed a req that does not match an exclude path string', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    excludePath: [ 
                        '໒( • ͜ʖ • )७', 
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        '/?zzzzzz=yyyyyy'
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
            // regexp
            it('should exclude when passed a req that exact matches an exclude path regex', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, false),
                    path = purl.pathname,
                    regex = new RegExp(escapeStringRegexp(path)),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    excludePath: [ 
                       '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                       regex
                    ]
                });
        
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should exclude when passed a req that partial matches an exclude path regex', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, true),
                    pieces = purl.pathname.split('/'),
                    regex = new RegExp(escapeStringRegexp(pieces[0] + '/' + pieces[1])),
                    opt = lo.cloneDeep(initOpt); 

                lo.merge(opt, {
                    excludePath: [ 
                        '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        regex
                    ]
                });

                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(true);
                    });
                })
                .then(done)
                .fail(done);
            });
            it('should not exclude when passed a req that does match an exclude path regex', function(done){
                var req = mockreq.getRandomBrowserRequest(),
                    purl = Url.parse(mockreq.basereq.url, true),
                    regex = new RegExp(escapeStringRegexp(purl.pathname.toUpperCase())),
                    opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    excludePath: [ 
                        '໒( • ͜ʖ • )७',
                        '/aaaaaaaa/aaaaaaaaaaa/aaaaaaaaaa',
                        regex
                    ]
                });
                return botbouncer.init(opt)
                .then(function(){
                    return botbouncer.shouldIgnorePath(req)
                    .then(function(excluded){
                        expect(excluded).to.equal(false);
                    });
                })
                .then(done)
                .fail(done);
            });
        });
    });
    describe("isIpWhitelisted", function(){
        it('should exclude when passed a req with a private network ip', function(done){
            return botbouncer.init(lo.cloneDeep(initOpt))
            .then(function(){
                var p = Q.resolve();
                lo.forEach(mockreq.ip.private, function(ip){ 
                    var req = mockreq.getRandomBrowserRequest();
                    req.ip = ip;
                    p = p.then(function(){
                        return botbouncer.isIpWhitelisted(req)
                        .then(function(excluded){
                            expect(excluded).to.equal(true, 'ip = ' + ip);
                        });
                    });
                });
                return p;
            })
            .then(done)
            .fail(done);
        });
        it('should never exclude when init\'d with empty whitelistIp opt', function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                whitelistIp: []
            });

            return botbouncer.init(opt)
            .then(function(){
                var p = Q.resolve(),
                    ips = lo.cloneDeep(mockreq.ip.private); 

                // ipv4
                for(var i = 0; i < 500; i++){ ips.push(chance.ip()); }

                // ipv6
                for(var i = 0; i < 500; i++){ ips.push(chance.ipv6()); }

                lo.forEach(ips, function(ip){ 
                    var req = mockreq.getRandomBrowserRequest();
                    req.ip = ip;
                    p = p.then(function(){
                        return botbouncer.isIpWhitelisted(req)
                        .then(function(excluded){
                            expect(excluded).to.equal(false, 'ip = ' + ip);
                        });
                    });
                });
                return p;
            })
            .then(done)
            .fail(done);
        });
        it('should exclude when init\'d with a list of ips and passed a req with matching ip', function(done){
            var ips = [],
                opt = lo.cloneDeep(initOpt);

            // ipv4 
            for(var i = 0; i < 500; i++){ ips.push(chance.ip()); }
            
            // ipv6 
            for(var i = 0; i < 500; i++){ ips.push(chance.ipv6()); }

            lo.merge(opt, {
                whitelistIp: ips
            });

            return botbouncer.init(opt)
            .then(function(){
                var p = Q.resolve();

                lo.forEach(ips, function(ip){
                    var req = mockreq.getRandomBrowserRequest();
                    req.ip = ip;
                    p = p.then(function(){
                        return botbouncer.isIpWhitelisted(req)
                        .then(function(excluded){
                            expect(excluded).to.equal(true, 'ip = ' + ip);
                        }); 
                    }); 
                }); 
                return p;
            })  
            .then(done)
            .fail(done);
        });
        it('should not exclude when init\'d with a list of ips and passed a req with non-matching ip', function(done){
            var ips = [],
                opt = lo.cloneDeep(initOpt);

            // ipv4 
            for(var i = 0; i < 500; i++){ ips.push(chance.ip()); }
            
            // ipv6 
            for(var i = 0; i < 500; i++){ ips.push(chance.ipv6()); }

            lo.merge(opt, {
                whitelistIp: ips
            });

            return botbouncer.init(opt)
            .then(function(){
                var p = Q.resolve(),
                    ips2 = [],
                    ip2,
                    i = 0;

                // ipv4 
                while(i <= 500){ 
                    ip2 = chance.ip();
                    if (lo.includes(ips, ip2)) continue;
                    ips2.push(ip2);
                    i++;
                }
                
                // ipv6 
                while(i <= 500){ 
                    ip2 = chance.ipv6();
                    if (lo.includes(ips, ip2)) continue;
                    ips2.push(ip2);
                    i++;
                }

                lo.forEach(ips2, function(ip){
                    var req = mockreq.getRandomBrowserRequest();
                    req.ip = ip;
                    p = p.then(function(){
                        return botbouncer.isIpWhitelisted(req)
                        .then(function(excluded){
                            expect(excluded).to.equal(false, 'ip = ' + ip);
                        }); 
                    }); 
                }); 
                return p;
            })  
            .then(done)
            .fail(done);
        });
        it('should exclude when init\'d with a list of CIDRs and passed a req with matching ip', function(done){
            var cidrs = {},
                opt = lo.cloneDeep(initOpt);

            // ipv4 
            for(var i = 0; i < 500; i++){ 
                var ip = chance.ip(),
                    ipp = ipaddr.parse(ip),
                    subnets = [12, 24, 32],
                    subnetidx = Math.round(Math.random()*2), 
                    subnet = subnets[subnetidx],
                    cdir;

                if (! lo.includes(subnets, subnet)) return done(new Error('failed to get a random subnet'));

                if (subnet === 12){
                    ipp.octets[2] = 0; 
                    ipp.octets[3] = 0;
                }
                else if (subnet === 24){
                    ipp.octets[3] = 0;
                }

                var cidr = ipp.toString() + '/' + subnet;
                if (! (cidr in cidrs)) cidrs[cidr] = []; 
                cidrs[cidr].push(ip);
            }
            
            // ipv6 TODO 

            lo.merge(opt, {
                whitelistIp: Object.keys(cidrs)
            });

            return botbouncer.init(opt)
            .then(function(){
                var p = Q.resolve();

                lo.forOwn(cidrs, function(ips, cidr){
                    lo.forEach(ips, function(ip){ 
                        var req = mockreq.getRandomBrowserRequest();
                        req.ip = ip;
                        p = p.then(function(){
                            return botbouncer.isIpWhitelisted(req)
                            .then(function(excluded){
                                expect(excluded).to.equal(true, 'ip = ' + ip);
                            }); 
                        }); 
                    });
                }); 
                return p;
            })  
            .then(done)
            .fail(done);
        });
    });

    describe("detectVisitor", function(){
        lo.forOwn(lo.cloneDeep(mockreq.agent.bot), function(botreq, botid){
            it('should ban impostor ' + botid + ' visitor', function(done){
                return botbouncer.init(lo.cloneDeep(initOpt))
                .then(function(){
                    var Visitor = botbouncer.getModelVisitor(),
                        statuses = Visitor.getStatuses(), 
                        now = moment.utc();

                    return Q().then(function(){
                        var ip = chance.ip(),
                            req = lo.cloneDeep(botreq),
                            res =  httpMocks.createResponse();
                        
                        // just in case the ip matches the valid bot's ip
                        while(ip === req.ip) ip = chance.ip();
                        req.ip = ip;

                        return botbouncer.detectVisitor(req, res)
                        .then(function(r){
                            expect(typeof(r)).to.equal('object');
                            expect(r.aborted).to.equal(false);
                            expect(r.passed).to.equal(false);
                            expect(typeof(r.visitor)).to.equal('object');
                            expect(r.visitor instanceof Visitor).to.equal(true);
                            expect(r.visitor.status_id).to.equal(statuses.BANNED);
                            expect(moment.isDate(r.visitor.status_set)).to.equal(true);
                            expect(now.isBefore(r.visitor.status_set)).to.equal(true);
                            
                            // ensure visitor status is set in db
                            var def = Q.defer();
                            Visitor.find({where: {ip: req.ip}}, function(err, res){
                                if (err) return def.reject(err); 
                                expect(res.length).to.equal(1);
                                expect(res[0].status_id).to.equal(statuses.BANNED);
                                expect(res[0].status_reason).to.equal('ua-impostor');
                                expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                expect(moment.isDate(res[0].status_set)).to.equal(true);
                                expect(now.isBefore(res[0].status_set)).to.equal(true);
                                def.resolve();
                            })
                            return def.promise; 
                        });
                    }); 
                })
                .then(done)
                .fail(done);
            });
        });
        lo.forOwn(lo.cloneDeep(mockreq.agent.bot), function(botreq, botid){
            it('should allow valid ' + botid + ' visitor', function(done){
                return botbouncer.init(lo.cloneDeep(initOpt))
                .then(function(){
                    var Visitor = botbouncer.getModelVisitor(),
                        statuses = Visitor.getStatuses(), 
                        now = moment.utc();

                    var req = lo.cloneDeep(botreq),
                        res = httpMocks.createResponse();

                    return botbouncer.detectVisitor(req, res)
                    .then(function(r){
                        expect(typeof(r)).to.equal('object');
                        expect(r.aborted).to.equal(false);
                        expect(r.passed).to.equal(true);
                        expect(typeof(r.visitor)).to.equal('object');
                        expect(r.visitor instanceof Visitor).to.equal(true);
                        expect(r.visitor.status_id).to.equal(statuses.ALLOWED);
                        expect(moment.isDate(r.visitor.status_set)).to.equal(true);
                        expect(now.isBefore(r.visitor.status_set)).to.equal(true);
                        
                        // ensure visitor status is set in db
                        var def = Q.defer();
                        Visitor.find({where: {ip: botreq.ip}}, function(err, res){
                            if (err) return def.reject(err); 
                            expect(res.length).to.equal(1);
                            expect(res[0].status_id).to.equal(statuses.ALLOWED);
                            expect(res[0].status_reason).to.equal('ua-impostor');
                            expect(moment.isDate(res[0].status_expires)).to.equal(true);
                            expect(now.isBefore(res[0].status_expires)).to.equal(true);
                            expect(moment.isDate(res[0].status_set)).to.equal(true);
                            expect(now.isBefore(res[0].status_set)).to.equal(true);
                            def.resolve();
                        })
                        return def.promise; 
                    });
                })
                .then(done)
                .fail(done);
            });
        });

        lo.forOwn(mockreq.agent.misc.oldua, function(uas, uaname){
            lo.forEach(uas, function(ua, i){
                it('should ban ' + uaname + ' variation #' + (i + 1) + ' by default', function(done){
                    return botbouncer.init(lo.cloneDeep(initOpt))
                    .then(function(){
                        var Visitor = botbouncer.getModelVisitor(),
                            statuses = Visitor.getStatuses(), 
                            now = moment.utc();

                        return Q().then(function(){
                            var ip = chance.ip(),
                                req = mockreq.getRandomBrowserRequest(), 
                                res = httpMocks.createResponse();
                            
                            req.ip = chance.ip();
                            req.headers['user-agent'] = ua; 

                            return botbouncer.detectVisitor(req, res)
                            .then(function(r){
                                expect(typeof(r)).to.equal('object');
                                expect(r.aborted).to.equal(false);
                                expect(r.passed).to.equal(false);
                                expect(typeof(r.visitor)).to.equal('object');
                                expect(r.visitor instanceof Visitor).to.equal(true);
                                expect(r.visitor.status_id).to.equal(statuses.BANNED);
                                expect(moment.isDate(r.visitor.status_set)).to.equal(true);
                                expect(now.isBefore(r.visitor.status_set)).to.equal(true);
                                
                                // ensure visitor status is set in db
                                var def = Q.defer();
                                Visitor.find({where: {ip: req.ip}}, function(err, res){
                                    if (err) return def.reject(err); 
                                    expect(res.length).to.equal(1);
                                    expect(res[0].status_id).to.equal(statuses.BANNED);
                                    expect(res[0].status_reason).to.equal('ua-version');
                                    expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                    expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                    expect(moment.isDate(res[0].status_set)).to.equal(true);
                                    expect(now.isBefore(res[0].status_set)).to.equal(true);
                                    def.resolve();
                                })
                                return def.promise; 
                            });
                        }); 
                    })
                    .then(done)
                    .fail(done);
                });
            });
        });

        it('should ban visitor switching user agents', function(done){
            return botbouncer.init(lo.cloneDeep(initOpt))
            .then(function(){
                var Visitor = botbouncer.getModelVisitor(),
                    statuses = Visitor.getStatuses(), 
                    now = moment.utc(),
                    ts = now.clone().subtract(botbouncer.getOpt().detectFrequency * 2, 'milliseconds'),
                    reqcount = botbouncer.getOpt().detectors['ua-switching'].minRequests,
                    p = Q.resolve(),
                    ip = chance.ip(),
                    uas = [];

                for(var i = 0; i < reqcount; i ++)(function(i){
                    var req, ua; 

                    do{
                        req = mockreq.getRandomBrowserRequest();
                        ua = req.headers['user-agent'];
                    } while(lo.includes(uas, ua));
                    
                    req.ip = ip;
                    // this is typically done botbouncer.handleRequest 
                    req._botbouncer = {
                        requested: ts.add('1', 'milliseconds').toDate()
                    };
                    uas.push(ua);

                    // last iteration, call detectVisitor
                    if (i + 1 === reqcount){
                        var res = httpMocks.createResponse(); 
                        // need to satisfy detectFrequency option or detection won't be run 
                        req._botbouncer.requested = now.toDate();
                        p = p.then(function(){ return botbouncer.detectVisitor(req, res); });
                    }
                    // save prior requests
                    else{
                        p = p.then(function(){ return botbouncer.saveVisitorRequest(req); });
                    }
                })(i);

                return p.then(function(r){
                    expect(typeof(r)).to.equal('object');
                    expect(r.aborted).to.equal(false);
                    expect(r.passed).to.equal(false);
                    expect(typeof(r.visitor)).to.equal('object');
                    expect(r.visitor instanceof Visitor).to.equal(true);
                    expect(r.visitor.status_id).to.equal(statuses.BANNED);
                    expect(moment.isDate(r.visitor.status_set)).to.equal(true);
                    expect(now.isBefore(r.visitor.status_set)).to.equal(true);
                    
                    // ensure visitor status is set in db
                    var def = Q.defer();
                    Visitor.find({where: {ip: ip}}, function(err, res){
                        if (err) return def.reject(err); 
                        expect(res.length).to.equal(1);
                        expect(res[0].status_id).to.equal(statuses.BANNED);
                        expect(res[0].status_reason).to.equal('ua-switching');
                        expect(moment.isDate(res[0].status_expires)).to.equal(true);
                        expect(now.isBefore(res[0].status_expires)).to.equal(true);
                        expect(moment.isDate(res[0].status_set)).to.equal(true);
                        expect(now.isBefore(res[0].status_set)).to.equal(true);
                        def.resolve();
                    })
                    return def.promise; 
                });
            })
            .then(done)
            .fail(done);
        });

        it('should ban visitor exceeding rate limits', function(done){
            return botbouncer.init(lo.cloneDeep(initOpt))
            .then(function(){
                var Visitor = botbouncer.getModelVisitor(),
                    statuses = Visitor.getStatuses(), 
                    reqcount = botbouncer.getOpt().detectors['rate-limit'].limit[0].total + 1,
                    timeframe = botbouncer.getOpt().detectors['rate-limit'].limit[0].timeframe,
                    now = moment.utc(),
                    ts = now.clone().subtract(timeframe, 'milliseconds'),
                    p = Q.resolve(),
                    ip = chance.ip(),
                    req = mockreq.getRandomBrowserRequest(); 

                req.ip = ip;

                for(var i = 0; i < reqcount; i ++)(function(i){
                    var req2 = lo.cloneDeep(req);
                    
                    // this is typically done botbouncer.handleRequest 
                    req2._botbouncer = {
                        requested: ts.add('1', 'milliseconds').toDate()
                    };

                    // last iteration, call detectVisitor
                    if (i + 1 === reqcount){
                        var res = httpMocks.createResponse(); 
                        // need to satisfy detectFrequency option with or detection won't be run
                        req2._botbouncer.requested = now.toDate();
                        p = p.then(function(){ return botbouncer.detectVisitor(req2, res); });
                    }
                    // save prior requests
                    else{
                        p = p.then(function(){ return botbouncer.saveVisitorRequest(req2); });
                    }
                })(i);

                return p.then(function(r){
                    expect(typeof(r)).to.equal('object');
                    expect(r.aborted).to.equal(false);
                    expect(r.passed).to.equal(false);
                    expect(typeof(r.visitor)).to.equal('object');
                    expect(r.visitor instanceof Visitor).to.equal(true);
                    expect(r.visitor.status_id).to.equal(statuses.BANNED);
                    expect(moment.isDate(r.visitor.status_set)).to.equal(true);
                    expect(now.isBefore(r.visitor.status_set)).to.equal(true);
                    
                    // ensure visitor status is set in db
                    var def = Q.defer();
                    Visitor.find({where: {ip: ip}}, function(err, res){
                        if (err) return def.reject(err); 
                        expect(res.length).to.equal(1);
                        expect(res[0].status_id).to.equal(statuses.BANNED);
                        expect(res[0].status_reason).to.equal('rate-limit');
                        expect(moment.isDate(res[0].status_expires)).to.equal(true);
                        expect(now.isBefore(res[0].status_expires)).to.equal(true);
                        expect(moment.isDate(res[0].status_set)).to.equal(true);
                        expect(now.isBefore(res[0].status_set)).to.equal(true);
                        def.resolve();
                    })
                    return def.promise; 
                });
            })
            .then(done)
            .fail(done);
        });
        
        it('should run detection once per detectFrequency timeframe with multiple requests from same ip', function(done){
            var detectFrequency = 100,
                opt = lo.cloneDeep(initOpt);

            lo.merge(opt, {
                detectFrequency: detectFrequency
            });
            return botbouncer.init(opt)
            .then(function(){
                var p = Q.resolve(), 
                    req = mockreq.getRandomBrowserRequest(),
                    res =  httpMocks.createResponse(); 
                    var results = [],
                    x = detectFrequency,
                    now = moment.utc(),
                    visitor = null;
                    
                req.ip = '79.32.178.91'; 
                req._botbouncer = {
                    requested: now.toDate() 
                };

                // check detection only run once if multiple requests requested every 1ms 
                // within detectFrequency timeframe
                for(var i = 0; i < x; i++)(function(i){
                    p = p.then(function(){
                        req.i = i;
                        // inc by 1 millisecond
                        if (i > 0){
                            req._botbouncer.requested = 
                                moment(req._botbouncer.requested).add(1, 'milliseconds').toDate();
                        }
                        return botbouncer.detectVisitor(req, res)
                        .then(function(r){
                            expect(typeof(r)).to.equal('object');
                            expect(typeof(r.aborted)).to.equal('boolean');
                            expect(typeof(req.i)).to.equal('number');
                            if (req.i > 0){
                                expect(r.aborted).to.equal(true);
                            }
                            visitor = r.visitor;
                        })
                    });
                })(i);

                // check detection is run on each request that is requested every detectFrequency ms
                p = p.then(function(){
                    var p2 = Q.resolve();

                    x = (detectFrequency) * 50;

                    for(var i = 0; i < x; i = i + detectFrequency)(function(i){
                        p2 = p2.then(function(){
                            req.i = i;
                            var lastdetect = moment(visitor.status_set).utc().format('x');

                            // set requested timestamp to last detect timestamp + detectFequency milliseconds
                            req._botbouncer.requested = 
                                moment(visitor.status_set).add(detectFrequency, 'milliseconds').toDate();

                            var requested = moment(req._botbouncer.requested).utc().format('x');
                            return botbouncer.detectVisitor(req, res)
                            .then(function(r){
                                expect(typeof(r)).to.equal('object');
                                expect(typeof(r.aborted)).to.equal('boolean');
                                expect(r.aborted).to.equal(false, 'requested = ' + requested + 
                                    ', last detect = ' + lastdetect +
                                    ', detectFrequency = ' + detectFrequency + 
                                    ', diff = ' + (requested  - lastdetect));

                                // reset visitor object so we can get latest detect timestamp on next iteration
                                visitor = r.visitor;
                            })
                        });
                    })(i);
                    return p2;
                });
                return p;
            })
            .then(done)
            .fail(done);
        });
    });

    describe("bounce", function(){
        beforeEach(function(done){
            botbouncer.emitter.removeAllListeners();
            done();
        });

        it('should set response properties and render response body text', function(done){
            var opt = lo.cloneDeep(initOpt);

            lo.merge(opt, {
                wipe: true,
                bounce: {
                    adminEmail: 'foo@bar.com'
                }
            });

            return botbouncer.init(opt)
            .then(function(){
                var req = mockreq.getRandomBrowserRequest(), 
                    res = httpMocks.createResponse(),
                    Visitor = botbouncer.getModelVisitor(),
                    visitor = new Visitor(), 
                    statuses = Visitor.getStatuses(), 
                    bbopt = botbouncer.getOpt(),
                    addy,
                    def = Q.defer(),
                    body,
                    response;

                visitor.id = 666;
                visitor.ip = req.ip = chance.ip();
                visitor.setStatusId(statuses.BANNED);

                botbouncer.emitter.on('bouncePost', function(o){
                    def.resolve(o.data);
                });

                return botbouncer.bounce(req, res, visitor)
                .then(function(){
                    expect(res._getStatusCode()).to.equal(bbopt.bounce.statusCode);
                    expect(res._headers['Content-Type']).to.equal(bbopt.bounce.contentType);
                    body = res._getData();
                    response = res;
                    return def.promise;
                })
                // after bounce event gives us the data, check body text contains the data 
                .then(function(data){
                    expect(typeof(body)).to.equal('string');
                    expect(body.indexOf(visitor.ip)).to.not.equal(-1);
                    expect(body.indexOf(opt.bounce.adminEmail)).to.not.equal(-1);
                    expect(bitcorelib.Address.isValid(data.payments.bitcoin.address)).to.equal(true);
                    expect(validator.isURL(data.payments.bitcoin.qrCodeUrl)).to.equal(true);
                    expect(body.indexOf(data.payments.bitcoin.address)).to.not.equal(-1);
                    expect(body.indexOf(data.payments.bitcoin.amountOwed)).to.not.equal(-1);
                    expect(body.indexOf(data.payments.bitcoin.amountCurrencyCode)).to.not.equal(-1);
                    expect(body.indexOf(data.payments.bitcoin.payment.getQrCodeUrl())).to.not.equal(-1);

                    // check headers
                    expect(response.get('X-Payment-Types-Accepted')).to.equal('Bitcoin');
                    expect(response.get('X-Payment-Address-Bitcoin')).to.equal(data.payments.bitcoin.address);
                    expect(response.get('X-Payment-Amount-Bitcoin')).to.equal(data.payments.bitcoin.amountOwed);
                    expect(response.get('X-Payment-Amount-Unit-Bitcoin')).to.equal(data.payments.bitcoin.amountCurrencyUnit);
                })
                .then(done)
                .fail(done); 
            });
        });

        it('should call custom function to render banned body', function(done){
            var Visitor,
                body = 'baz bar foo i ban you',
                opt = lo.cloneDeep(initOpt);

            lo.merge(opt, {
                bounce: {
                    body: {
                        banned: function(data, done){
                            expect(typeof(data.req)).to.equal('object');
                            expect(typeof(data.res)).to.equal('object');
                            expect(data.visitor instanceof Visitor).to.equal(true);
                            expect(typeof(data.visitor.ip)).to.equal('string');
                            expect(typeof(done)).to.equal('function');
                            return done(body);
                        }
                    }
                }
            });

            return botbouncer.init(opt)
            .then(function(){
                var req = mockreq.getRandomBrowserRequest(), 
                    res = httpMocks.createResponse();
                Visitor = botbouncer.getModelVisitor();
                var visitor = new Visitor(), 
                    statuses = Visitor.getStatuses(), 
                    bbopt = botbouncer.getOpt();

                visitor.id = 666;
                visitor.ip = req.ip = chance.ip(); 
                visitor.setStatusId(statuses.BANNED);

                return botbouncer.bounce(req, res, visitor)
                .then(function(){
                    expect(res._getData()).to.equal(body);
                    expect(res._getStatusCode()).to.equal(bbopt.bounce.statusCode);
                    expect(res._headers['Content-Type']).to.equal(bbopt.bounce.contentType);
                })
                .then(done)
                .fail(done); 
            });
        });

        context('BIP32', function(){
            it('should use deriveIndexStart option to generate first bitcoin address', function(done){
                var opt = lo.cloneDeep(initOpt);

                lo.merge(opt, {
                    wipe: true,
                    bounce: {
                        adminEmail: 'foo@bar.com'
                    },
                    payment:{
                        bitcoin:{
                            deriveIndexStart: 9999 
                        }
                    }
                });

                return botbouncer.init(opt)
                .then(function(){
                    var req = mockreq.getRandomBrowserRequest(), 
                        res = httpMocks.createResponse(),
                        bbopt = botbouncer.getOpt(),
                        def = Q.defer(),
                        Payment = botbouncer.getModelPayment(),
                        pay = new Payment(),
                        body,
                        Visitor = botbouncer.getModelVisitor(),
                        visitor = new Visitor(),
                        statuses = Visitor.getStatuses(); 

                    visitor.id = 666;
                    visitor.ip = req.ip = chance.ip();
                    visitor.setStatusId(statuses.BANNED);

                    botbouncer.emitter.on('bouncePost', function(o){
                        def.resolve(o.data);
                    });

                    return botbouncer.bounce(req, res, visitor)
                    .then(function(){
                        body = res._getData();
                        return def.promise;
                    })
                    // after bounce event gives us the data, check body text contains the data 
                    .then(function(data){
                        expect(typeof(body)).to.equal('string');
                        expect(bitcorelib.Address.isValid(data.payments.bitcoin.address)).to.equal(true);
                        expect(body.indexOf(data.payments.bitcoin.address)).to.not.equal(-1);
                        expect(data.payments.bitcoin.address).to.equal(
                            mockreq.deriveAddressFromHdPubKey(
                                bbopt.payment.bitcoin.masterPublicKey, 
                                bbopt.payment.bitcoin.deriveIndexStart, 
                                bbopt.payment.bitcoin.network 
                            )
                        );
                    });
                })
                .then(done)
                .fail(done);
            });
        });
    });

    describe("handleRequest", function(){
        beforeEach(function(done){
            botbouncer.emitter.removeAllListeners();
            done();
        }); 

        var finishResponse = function(res){
            // mock response doesn't seem to call 'finish' event 
            res.on('end', function(){ res.emit('finish'); });
            res.send();
        };

        it('should ignore a request from a whitelisted ip', function(done){
            var ip = chance.ip(),
                opt = lo.cloneDeep(initOpt);

            lo.merge(opt, {
                whitelistIp: [ip]
            });
            return botbouncer.init(opt)
            .then(function(){
                var req = mockreq.getRandomBrowserRequest(),
                    res = httpMocks.createResponse(), 
                    def = Q.defer(),
                    next = function(err){
                        expect(typeof(err)).to.equal('undefined');
                        def.resolve();
                    };

                req.ip = ip;

                return botbouncer.handleRequest(req, res, next)
                .then(function(){
                    return def.promise;
                })
                .then(function(){
                    // ensure ip doesn't exist in database
                    var Visitor = botbouncer.getModelVisitor();
                    Visitor.find({where: {ip: req.ip}}, function(err, res){
                        expect(err).to.equal(null);
                        expect(res.length).to.equal(0);
                    });
                })
                .then(done)
                .fail(done); 
            });
        });
        it('should ignore a request from an excluded path', function(done){
            var req = mockreq.getRandomBrowserRequest(),
                purl = Url.parse(mockreq.basereq.url, false), 
                opt = lo.cloneDeep(initOpt);
            
            lo.merge(opt, {
                excludePath: [purl.path]
            });

            return botbouncer.init(opt)
            .then(function(){
                var res = httpMocks.createResponse(), 
                    def = Q.defer(),
                    next = function(err){
                        expect(typeof(err)).to.equal('undefined');
                        def.resolve();
                    };
                req.ip = chance.ip();

                return botbouncer.handleRequest(req, res, next)
                .then(function(){
                    return def.promise;
                })
                .then(function(){
                    // ensure ip doesn't exist in database
                    var Visitor = botbouncer.getModelVisitor();
                    Visitor.find({where: {ip: req.ip}}, function(err, res){
                        expect(err).to.equal(null);
                        expect(res.length).to.equal(0);
                    });
                })
                .then(done)
                .fail(done); 
            });
        });
        lo.forOwn(lo.cloneDeep(mockreq.agent.bot), function(botreq, botid){
            it('should ban + bounce impostor ' + botid + ' visitor on 2nd request', function(done){
                var opt = lo.cloneDeep(initOpt);
                lo.merge(opt, {
                    wipe: true
                });
                return botbouncer.init(opt)
                .then(function(){
                    var Visitor = botbouncer.getModelVisitor(),
                        statuses = Visitor.getStatuses(), 
                        now = moment.utc(),
                        bbopt = botbouncer.getOpt(); 

                    return Q().then(function(){
                        var ip = chance.ip(),
                            req = lo.cloneDeep(botreq),
                            res =  httpMocks.createResponse({
                                eventEmitter: events.EventEmitter
                            }),
                            now = moment.utc(),
                            nextCheck = false,
                            detectDone = Q.defer(),
                            detectCheck = function(){
                                // ensure visitor status is set in db
                                Visitor.find({where: {ip: req.ip}}, function(err, res){
                                    if (err) return detectDone.reject(err);
                                    expect(res.length).to.equal(1);
                                    expect(res[0].status_id).to.equal(statuses.BANNED);
                                    expect(res[0].status_reason).to.equal('ua-impostor');
                                    expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                    expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                    expect(moment.isDate(res[0].status_set)).to.equal(true);
                                    expect(now.isBefore(res[0].status_set)).to.equal(true);
                                    detectDone.resolve();
                                })
                            },
                            bounceDone = Q.defer(),
                            bounceCheck = function(){
                                bounceDone.resolve();
                            };
                        
                        // just in case the ip matches the valid bot's ip
                        while(ip === req.ip) ip = chance.ip();
                        req.ip = ip;

                        // check results once detect is finished
                        botbouncer.emitter.once('detectVisitorEnd', detectCheck);

                        return botbouncer.handleRequest(req, res, function(){
                            nextCheck = true;
                            finishResponse(res);
                        })
                        .then(function(){
                            expect(nextCheck).to.equal(true);
                            return detectDone.promise; 
                        })
                        // send a second request, expected to be bounced 
                        .then(function(){
                            var def = Q.defer();
                            botbouncer.emitter.once('bouncePost', bounceCheck);
                            setTimeout(function(){
                                req = lo.cloneDeep(botreq);
                                res =  httpMocks.createResponse({
                                    eventEmitter: events.EventEmitter
                                });
                                req.ip = ip;
                                return botbouncer.handleRequest(req, res, function(){
                                    // shouldnt get here
                                    expect(true).to.equal(false);
                                })
                                .then(def.resolve)
                                .fail(def.reject)
                            }, bbopt.detectFrequency);
                            return def.promise;
                        })
                        .then(function(){
                            return bounceDone.promise;
                        });

                    }); 
                })
                .then(done)
                .fail(done);
            });
        });

        lo.forOwn(lo.cloneDeep(mockreq.agent.bot), function(botreq, botid){
            it('should not bounce impostor ' + botid + ' visitor when bounce is disabled', function(done){
                var opt = lo.cloneDeep(initOpt);
                lo.merge(opt, {
                    wipe: true,
                    bounce: {
                        enabled: false
                    }
                });
                return botbouncer.init(opt)
                .then(function(){
                    var Visitor = botbouncer.getModelVisitor(),
                        statuses = Visitor.getStatuses(), 
                        now = moment.utc(),
                        bbopt = botbouncer.getOpt(); 

                    return Q().then(function(){
                        var ip = chance.ip(),
                            req = lo.cloneDeep(botreq),
                            res =  httpMocks.createResponse({
                                eventEmitter: events.EventEmitter
                            }),
                            now = moment.utc(),
                            nextCheck = false,
                            detectDone = Q.defer(),
                            detectCheck = function(){
                                // ensure visitor status is set in db
                                Visitor.find({where: {ip: req.ip}}, function(err, res){
                                    if (err) return detectDone.reject(err);
                                    expect(res.length).to.equal(1);
                                    expect(res[0].status_id).to.equal(statuses.BANNED);
                                    expect(res[0].status_reason).to.equal('ua-impostor');
                                    expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                    expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                    expect(moment.isDate(res[0].status_set)).to.equal(true);
                                    expect(now.isBefore(res[0].status_set)).to.equal(true);
                                    detectDone.resolve();
                                })
                            },
                            noEventCheck = function(obj){
                                // shouldnt get here
                                expect(true).to.equal(false, obj);
                            };
                        
                        // just in case the ip matches the valid bot's ip
                        while(ip === req.ip) ip = chance.ip();
                        req.ip = ip;

                        // check results once detect is finished
                        botbouncer.emitter.once('detectVisitorEnd', detectCheck);

                        return botbouncer.handleRequest(req, res, function(){
                            nextCheck = true;
                            finishResponse(res);
                        })
                        .then(function(){
                            expect(nextCheck).to.equal(true);
                            return detectDone.promise;
                        })
                        // send a second request, expected to also go thru 
                        .then(function(){
                            var def = Q.defer();
                            // should not bounce
                            botbouncer.emitter.once('bouncePost', noEventCheck);
                            // should not run detection
                            botbouncer.emitter.once('detectVisitorEnd', noEventCheck);

                            setTimeout(function(){
                                req = lo.cloneDeep(botreq);
                                res =  httpMocks.createResponse({
                                    eventEmitter: events.EventEmitter
                                });
                                return botbouncer.handleRequest(req, res, function(){
                                    nextCheck = true;
                                })
                                .then(def.resolve)
                                .fail(def.reject);
                            }, bbopt.detectFrequency);
                            return def.promise;
                        })
                        .then(function(){
                            expect(nextCheck).to.equal(true);
                        });
                    }); 
                })
                .then(done)
                .fail(done);
            });
        });
        lo.forOwn(lo.cloneDeep(mockreq.agent.bot), function(botreq, botid){
            it('should set valid ' + botid + ' visitor status = allowed, allow requests', function(done){
                var opt = lo.cloneDeep(initOpt); 
                lo.merge(opt, {
                    wipe: true
                });
                return botbouncer.init(opt)
                .then(function(){
                    var Visitor = botbouncer.getModelVisitor(),
                        statuses = Visitor.getStatuses(), 
                        now = moment.utc(),
                        bbopt = botbouncer.getOpt(); 

                    return Q().then(function(){
                        var req = lo.cloneDeep(botreq),
                            res =  httpMocks.createResponse({
                                eventEmitter: events.EventEmitter
                            }),
                            now = moment.utc(),
                            nextCheck = false,
                            detectDone = Q.defer(),
                            detectCheck = function(){
                                // ensure visitor status is set in db
                                Visitor.find({where: {ip: req.ip}}, function(err, res){
                                    if (err) return detectDone.reject(err);
                                    expect(res.length).to.equal(1);
                                    expect(res[0].status_id).to.equal(statuses.ALLOWED);
                                    expect(res[0].status_reason).to.equal('ua-impostor');
                                    expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                    expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                    expect(moment.isDate(res[0].status_set)).to.equal(true);
                                    expect(now.isBefore(res[0].status_set)).to.equal(true);
                                    detectDone.resolve();
                                })
                            },
                            noEventCheck = function(obj){
                                // shouldnt get here
                                expect(true).to.equal(false, obj);
                            };
                        
                        // check results once detect is finished
                        botbouncer.emitter.once('detectVisitorEnd', detectCheck);

                        return botbouncer.handleRequest(req, res, function(){
                            nextCheck = true;
                            finishResponse(res);
                        })
                        .then(function(){
                            expect(nextCheck).to.equal(true);
                            return detectDone.promise; 
                        })
                        // send a second request, expected to also go thru 
                        .then(function(){
                            var def = Q.defer();
                            // should not bounce
                            botbouncer.emitter.once('bouncePost', noEventCheck);
                            // should not run detection
                            botbouncer.emitter.once('detectVisitorEnd', noEventCheck);

                            setTimeout(function(){
                                req = lo.cloneDeep(botreq);
                                res =  httpMocks.createResponse({
                                    eventEmitter: events.EventEmitter
                                });
                                return botbouncer.handleRequest(req, res, function(){
                                    nextCheck = true;
                                })
                                .then(def.resolve)
                                .fail(def.reject);
                            }, bbopt.detectFrequency);
                            return def.promise;
                        })
                        .then(function(){
                            expect(nextCheck).to.equal(true);
                        });
                    }); 
                })
                .then(done)
                .fail(done);
            });
        });

        var browsers = mockreq.getRandomBrowserRequest({count: 10});

        lo.forEach(browsers, function(botreq){
            it('should set valid ' + botreq.uaid + ' visitor status = null and not bounce requests', function(done){
                var opt = lo.cloneDeep(initOpt);
                lo.merge(opt, {wipe: true});

                return botbouncer.init(opt)
                .then(function(){
                    var Visitor = botbouncer.getModelVisitor(),
                        statuses = Visitor.getStatuses(), 
                        now = moment.utc(),
                        bbopt = botbouncer.getOpt(); 

                    return Q().then(function(){
                        var req = lo.cloneDeep(botreq),
                            res =  httpMocks.createResponse({
                                eventEmitter: events.EventEmitter
                            }),
                            ip,
                            now = moment.utc(),
                            nextCheck = false,
                            detectDone = Q.defer(),
                            detectCheck = function(){
                                // ensure visitor status is set in db
                                Visitor.find({where: {ip: req.ip}}, function(err, res){
                                    if (err) return detectDone.reject(err);
                                    expect(res.length).to.equal(1);
                                    expect(res[0].status_id).to.equal(null, res[0].status_reason);
                                    expect(res[0].status_reason).to.equal(null);
                                    expect(res[0].status_expires).to.equal(null);
                                    expect(moment.isDate(res[0].status_set)).to.equal(true);
                                    expect(now.isBefore(res[0].status_set)).to.equal(true);
                                    detectDone.resolve();
                                })
                            },
                            noEventCheck = function(obj){
                                // shouldnt get here
                                expect(true).to.equal(false, obj);
                            };

                        while(ip === req.ip) ip = chance.ip();
                        req.ip = ip;
                        
                        // check results once detect is finished
                        botbouncer.emitter.once('detectVisitorEnd', detectCheck);

                        return botbouncer.handleRequest(req, res, function(){
                            nextCheck = true;
                            finishResponse(res);
                        })
                        .then(function(){
                            expect(nextCheck).to.equal(true);
                            return detectDone.promise; 
                        })
                        // send a second request, expected to also go thru 
                        .then(function(){
                            var def = Q.defer();
                            // should not bounce
                            botbouncer.emitter.once('bouncePost', noEventCheck);
                            // should not run detection
                            botbouncer.emitter.once('detectVisitorEnd', noEventCheck);

                            setTimeout(function(){
                                req = lo.cloneDeep(botreq);
                                req.ip = ip;
                                res =  httpMocks.createResponse({
                                    eventEmitter: events.EventEmitter
                                });
                                return botbouncer.handleRequest(req, res, function(){
                                    nextCheck = true;
                                })
                                .then(def.resolve)
                                .fail(def.reject);
                            }, bbopt.detectFrequency);
                            return def.promise;
                        })
                        .then(function(){
                            expect(nextCheck).to.equal(true);
                        });
                    }); 
                })
                .then(done)
                .fail(done);
            });
        });
        it('should ban/bounce impostor googlebot, then run detection again after status expires', function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                banDuration: 3000,
                wipe: true
            });

            return botbouncer.init(opt)
            .then(function(){
                var botreq = lo.cloneDeep(mockreq.agent.bot.googlebot);

                var Visitor = botbouncer.getModelVisitor(),
                    statuses = Visitor.getStatuses(), 
                    now = moment.utc(),
                    bbopt = botbouncer.getOpt(); 

                return Q().then(function(){
                    var ip = chance.ip(),
                        req = lo.cloneDeep(botreq),
                        res =  httpMocks.createResponse({
                            eventEmitter: events.EventEmitter
                        }),
                        now = moment.utc(),
                        nextCheck = false,
                        detectDone = Q.defer(),
                        detectCheck = function(){
                            // ensure visitor status is set in db
                            Visitor.find({where: {ip: req.ip}}, function(err, res){
                                if (err) return detectDone.reject(err);
                                expect(res.length).to.equal(1);
                                expect(res[0].status_id).to.equal(statuses.BANNED);
                                expect(res[0].status_reason).to.equal('ua-impostor');
                                expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                expect(moment.isDate(res[0].status_set)).to.equal(true);
                                expect(now.isBefore(res[0].status_set)).to.equal(true);
                                detectDone.resolve();
                            })
                        },
                        bounceDone = Q.defer(),
                        bounceCheck = function(){
                            bounceDone.resolve();
                        },
                        noEventCheck = function(obj){
                            // shouldnt get here
                            expect(true).to.equal(false, obj);
                        };
                    
                    // just in case the ip matches the valid bot's ip
                    while(ip === req.ip) ip = chance.ip();
                    req.ip = ip;

                    // check results once detect is finished
                    botbouncer.emitter.once('detectVisitorEnd', detectCheck);

                    return botbouncer.handleRequest(req, res, function(){
                        nextCheck = true;
                        finishResponse(res);
                    })
                    .then(function(){
                        expect(nextCheck).to.equal(true);
                        return detectDone.promise; 
                    })
                    // send a second request, expected to be bounced 
                    .then(function(){
                        var def = Q.defer();
                        botbouncer.emitter.removeAllListeners();
                        botbouncer.emitter.once('bouncePost', bounceCheck);
                        setTimeout(function(){
                            req = lo.cloneDeep(botreq);
                            res =  httpMocks.createResponse({ eventEmitter: events.EventEmitter });
                            req.ip = ip;
                            return botbouncer.handleRequest(req, res, function(){
                                // shouldnt get here
                                expect(true).to.equal(false);
                            })
                            .then(def.resolve)
                            .fail(def.reject)
                        }, bbopt.detectFrequency);
                        return def.promise;
                    })
                    .then(function(){
                        return bounceDone.promise;
                    })
                    // send a third request after status expires, expected to go thru, but will trigger a detection
                    .then(function(){
                        var def = Q.defer();
                        botbouncer.emitter.removeAllListeners();
                        setTimeout(function(){
                            req = lo.cloneDeep(botreq);
                            res =  httpMocks.createResponse({ eventEmitter: events.EventEmitter });
                            req.ip = ip;

                            now = moment.utc();

                            // check results once detect is finished
                            nextCheck = false;
                            detectDone = Q.defer();
                            botbouncer.emitter.once('detectVisitorEnd', detectCheck);

                            return botbouncer.handleRequest(req, res, function(){
                                nextCheck = true;
                                finishResponse(res); 
                            })
                            .then(function(){
                                expect(nextCheck).to.equal(true);
                                return detectDone.promise;
                            })
                            .then(def.resolve)
                            .fail(def.reject)
                        }, bbopt.detectFrequency + bbopt.banDuration);
                        return def.promise;
                    })
                    // send 4th request, should be bounced
                    .then(function(){
                        var def = Q.defer();
                        botbouncer.emitter.removeAllListeners();
                        bounceDone = Q.defer();
                        botbouncer.emitter.once('bouncePost', bounceCheck);
                        setTimeout(function(){
                            req = lo.cloneDeep(botreq);
                            res = httpMocks.createResponse({ eventEmitter: events.EventEmitter });
                            req.ip = ip;

                            now = moment.utc();

                            // check results once detect is finished
                            nextCheck = false;

                            // should bounce, should not run detection
                            botbouncer.emitter.once('detectVisitorEnd', noEventCheck); 

                            return botbouncer.handleRequest(req, res, function(){
                                // shouldnt get here
                                expect(true).to.equal(false);
                            })
                            .then(def.resolve)
                            .fail(def.reject); 
                        }, bbopt.detectFrequency);
                        return def.promise;
                    })
                    .then(function(){
                        return bounceDone.promise;
                    })
                }); 
            })
            .then(done)
            .fail(done);
        });

        it('should ban/bounce impostor googlebot, allow after payment, ' +
        'and ban/bounce again after allow duration expires',
        function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                wipe: true,
                detectFrequency: 100,
                payment:{
                    allowedDuration: 500,
                    bitcoin: {
                        checkFrequency: 1000,
                        amount: '0.0017885', 
                        deriveIndexStart: 11, 
                        masterPublicKey: 'xpub661MyMwAqRbcF52T1XkEPjCo9ETaj1t75XBYRN5dwsW4ETWmd86WpyzqKAV26NNED2E3wWg2i2f1HyKAKKgjQGtfMnBwpGXMXnjob25Pcse'
                    }
                }
            });

            return botbouncer.init(opt)
            .then(function(){
                var botreq = lo.cloneDeep(mockreq.agent.bot.googlebot);

                var Visitor = botbouncer.getModelVisitor(),
                    statuses = Visitor.getStatuses(),
                    now = moment.utc(),
                    bbopt = botbouncer.getOpt(); 

                return Q().then(function(){
                    var ip = chance.ip(),
                        req = lo.cloneDeep(botreq),
                        res =  httpMocks.createResponse({
                            eventEmitter: events.EventEmitter
                        }),
                        nextCheck = false,
                        detectDone = Q.defer(),
                        detectCheckBanned = function(){
                            // ensure visitor status is set in db
                            Visitor.find({where: {ip: req.ip}}, function(err, res){
                                if (err) return detectDone.reject(err);
                                expect(res.length).to.equal(1);
                                expect(res[0].status_id).to.equal(statuses.BANNED);
                                expect(res[0].status_reason).to.equal('ua-impostor');
                                expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                expect(moment.isDate(res[0].status_set)).to.equal(true);
                                expect(now.isBefore(res[0].status_set)).to.equal(true);
                                detectDone.resolve();
                            })
                        },
                        bounceDone = Q.defer(),
                        bounceCheck = function(o){
                            expect(o.data.res._getStatusCode()).to.equal(bbopt.bounce.statusCode);
                            bounceDone.resolve();
                        },
                        noEventCheck = function(obj){
                            // shouldnt get here
                            expect(true).to.equal(false, obj);
                        };
                    
                    // just in case the ip matches the valid bot's ip
                    while(ip === req.ip) ip = chance.ip();
                    req.ip = ip;

                    botbouncer.emitter.once('detectVisitorEnd', detectCheckBanned);

                    // send first request, check detect results
                    return botbouncer.handleRequest(req, res, function(){
                        nextCheck = true;
                        finishResponse(res);
                    })
                    .then(function(){
                        expect(nextCheck).to.equal(true);
                        return detectDone.promise; 
                    })
                    // send a second request, expected to be bounced 
                    .then(function(){
                        var def = Q.defer();
                        botbouncer.emitter.removeAllListeners();
                        botbouncer.emitter.once('bouncePost', bounceCheck);
                        setTimeout(function(){
                            req = lo.cloneDeep(botreq);
                            res =  httpMocks.createResponse({ eventEmitter: events.EventEmitter });
                            req.ip = ip;
                            return botbouncer.handleRequest(req, res, function(){
                                // shouldnt get here
                                expect(true).to.equal(false);
                            })
                            .then(def.resolve)
                            .fail(def.reject)
                        }, bbopt.detectFrequency);
                        return def.promise;
                    })
                    .then(function(){
                        return bounceDone.promise;
                    })
                    // send a third request after payment check, expect access to be granted b/c full settled payment 
                    .then(function(){
                        var def = Q.defer();
                        botbouncer.emitter.removeAllListeners();
                        setTimeout(function(){
                            req = lo.cloneDeep(botreq);
                            res =  httpMocks.createResponse({ eventEmitter: events.EventEmitter });
                            req.ip = ip;
                            now = moment.utc();

                            // check results once detect is finished
                            nextCheck = false;
                            var nextdef = Q.defer();

                            return botbouncer.handleRequest(req, res, function(){
                                nextCheck = true;
                                nextdef.resolve();
                            })
                            .then(function(){
                                return nextdef.promise; 
                            })
                            .then(function(){
                                expect(nextCheck).to.equal(true);
                            })
                            .then(def.resolve)
                            .fail(def.reject)
                        }, bbopt.payment.bitcoin.checkFrequency * 2);
                        return def.promise;
                    })
                    // send 4th request after allowed status has expired, should be detected and banned
                    .then(function(){
                        botbouncer.emitter.removeAllListeners();

                        var def = Q.defer(),
                            detectDone = Q.defer(),
                            detectCheckBanned = function(){
                                // ensure visitor status is set in db
                                Visitor.find({where: {ip: req.ip}}, function(err, res){
                                    if (err) return detectDone.reject(err);
                                    expect(res.length).to.equal(1);
                                    expect(res[0].status_id).to.equal(statuses.BANNED);
                                    expect(res[0].status_reason).to.equal('ua-impostor');
                                    expect(moment.isDate(res[0].status_expires)).to.equal(true);
                                    expect(now.isBefore(res[0].status_expires)).to.equal(true);
                                    expect(moment.isDate(res[0].status_set)).to.equal(true);
                                    expect(now.isBefore(res[0].status_set)).to.equal(true);
                                    detectDone.resolve();
                                })
                            };

                        setTimeout(function(){
                            req = lo.cloneDeep(botreq);
                            res = httpMocks.createResponse({ eventEmitter: events.EventEmitter });
                            req.ip = ip;
                            now = moment.utc();

                            // check results once detect is finished
                            botbouncer.emitter.once('detectVisitorEnd', detectCheckBanned);

                            return botbouncer.handleRequest(req, res, function(){
                                finishResponse(res);
                            })
                            .then(function(){
                                return detectDone.promise;
                            })
                            .then(def.resolve)
                            .fail(def.reject); 
                        }, bbopt.payment.allowedDuration + 1);

                        return def.promise;
                    })
                    // send 5th request, expected to be bounced
                    .then(function(){
                        var def = Q.defer();
                        botbouncer.emitter.removeAllListeners();
                        botbouncer.emitter.once('bouncePost', bounceCheck);
                        setTimeout(function(){
                            req = lo.cloneDeep(botreq);
                            res =  httpMocks.createResponse({ eventEmitter: events.EventEmitter });
                            req.ip = ip;
                            return botbouncer.handleRequest(req, res, function(){
                                // shouldnt get here
                                expect(true).to.equal(false);
                            })
                            .then(def.resolve)
                            .fail(def.reject)
                        }, bbopt.detectFrequency);
                        return def.promise;
                    })
                    .then(function(){
                        return bounceDone.promise;
                    })
                }); 
            })
            .then(done)
            .fail(done);
        });
    });

    describe("lookupHostname", function(){
        it('should set and save visitor hostname to something google-ish when ip = 8.8.8.8', function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                wipe: true
            });

            return botbouncer.init(opt)
            .then(function(){
                var req = mockreq.getRandomBrowserRequest(),
                    Visitor = botbouncer.getModelVisitor(),
                    visitor = new Visitor(), 
                    statuses = Visitor.getStatuses(), 
                    bbopt = botbouncer.getOpt();

                req.ip = '8.8.8.8'; 

                return botbouncer.saveVisitorRequest(req)
                .then(function(visitor){
                    expect(typeof(visitor.id)).to.equal('number');
                    return botbouncer.lookupHostname(visitor, {save: true})
                    .then(function(v){
                        expect(v instanceof Visitor).to.equal(true);
                        expect(typeof(v.hostname)).to.equal('string');
                        expect(v.hostname.indexOf('google.com')).to.not.equal(-1);

                        // check db
                        var def = Q.defer();
                        Visitor.find({where: {id: v.id}}, function(err, res){
                            expect(err).to.equal(null);
                            expect(res.length).to.equal(1);
                            var v2 = res[0];
                            expect(v2.hostname).to.equal(v.hostname);
                            def.resolve();
                        });
                        return def.promise;
                    });
                });
            })  
            .then(done)
            .fail(done);
        }); 
        it('should reject when called with a visitor object with no id set', function(done){
            var opt = lo.cloneDeep(initOpt);

            return botbouncer.init(opt)
            .then(function(){
                var Visitor = botbouncer.getModelVisitor(),
                    visitor = new Visitor(), 
                    statuses = Visitor.getStatuses(), 
                    bbopt = botbouncer.getOpt();

                visitor.ip = '8.8.8.8'; 

                return botbouncer.lookupHostname(visitor, {save: true})
                .then(function(v){
                    // should not get here
                    expect(true).to.equal(false);
                })
                .fail(function(err){
                    expect(typeof(err)).to.equal('object');
                    expect(err instanceof Error).to.equal(true);
                    done();
                });        
            })  
        }); 
    });

    describe('prune', function(){
        beforeEach(function(done){
            botbouncer.emitter.removeAllListeners();
            done();
        });

        it("should periodically prune", function(done){
            var opt = lo.cloneDeep(initOpt),
                checks = 5,
                starts = 0,
                stops = 0;

            lo.merge(opt, {
                //wipe: true, 
                prune:{
                    frequency: 200,
                    timeout: 100
                }
            });

            botbouncer.emitter.on('pruneStart', function(){ starts++; });
            botbouncer.emitter.on('pruneEnd', function(){ stops++; });

            return botbouncer.init(opt)
            .then(function(){
                var def = Q.defer(),
                    bbopt = botbouncer.getOpt();

                setTimeout(function(){
                    botbouncer.killPruneInterval();
                    botbouncer.emitter.removeAllListeners('pruneStart');
                    botbouncer.emitter.removeAllListeners('pruneEnd');
                    expect(starts).to.equal(stops);
                    expect(checks - 1).to.equal(stops);
                    def.resolve();
                }, (bbopt.prune.frequency * checks) + 1);
                return def.promise;
            })
            .then(done)
            .fail(done);
        });
    
        it("should only delete old visitor records with null status_id and related request records", function(done){
            var opt = lo.cloneDeep(initOpt);

            lo.merge(opt, {
                wipe: true, 
                prune:{
                    frequency: 0
                }
            });

            return botbouncer.init(opt)
            .then(function(){
                var i, 
                    ip,
                    ips = [],
                    p = Q.resolve(),
                    bbopt = botbouncer.getOpt(),
                    reqcount = 25,
                    delcount = Math.floor(reqcount / 2),
                    now = moment.utc(),
                    cutoff = now.clone().subtract(bbopt.prune.olderThan + 1, 'milliseconds'), 
                    Schema = botbouncer.getSchema(),
                    Visitor = botbouncer.getModelVisitor(),
                    Request = botbouncer.getModelRequest(),
                    statuses = Visitor.getStatuses(); 

                for(i = 1; i <= reqcount; i++)(function(i){
                    p = p.then(function(){ 
                        while(lo.includes(ips, (ip = chance.ip()))){};
                        ips.push(ip);
                        var req = mockreq.getRandomBrowserRequest(),
                            requested = i > delcount ? now.toDate() : cutoff.toDate(),
                            // give 1 old record a non-null status, it should not be pruned
                            status_id = i === delcount ? statuses.BANNED : null;

                        req.ip = ip;
                        req._botbouncer = { requested:  requested};

                        return Q().then(function(){
                            // first save a visitor object so we can set it's created timestamp (thats the timestamp 
                            // prune uses).
                            var visitor = new Visitor({
                                    ip: ip,
                                    status_id: status_id, 
                                    created: requested
                                }),
                                def = Q.defer();

                            visitor.save(function(err){
                                if (err && ! Schema.isUniqueConstraintError(err)) return def.reject(err);
                                def.resolve();
                            });
                            return def.promise;
                        }) 
                        .then(function(){
                            return botbouncer.saveVisitorRequest(req);
                        })
                    });
                })(i);

                return p.then(function(){
                    // decrement expected deleted count b/c 1 non-null-status old record should not be pruned
                    delcount--;
                    return Q.ninvoke(Visitor, 'count'); 
                })
                .then(function(cnt){
                    expect(cnt).to.equal(reqcount); 
                    return Q.ninvoke(Request, 'count');
                })
                .then(function(cnt){
                    expect(cnt).to.equal(reqcount);

                    return botbouncer.isPruning()
                    .then(function(inprog){
                        expect(inprog).to.equal(false);
                        return botbouncer.prune();
                    });
                })
                .then(function(){
                    return botbouncer.isPruning()
                    .then(function(inprog){
                        expect(inprog).to.equal(false);
                        return Q.ninvoke(Visitor, 'count'); 
                    });
                })
                .then(function(cnt){
                    expect(cnt).to.equal(reqcount - delcount, 'remaining visitor count');
                    return Q.ninvoke(Request, 'count');
                })
                .then(function(cnt){
                    expect(cnt).to.equal(reqcount - delcount, 'remaining request count'); 
                })
            })
            .then(done)
            .fail(done);
        });
    });

    describe('checkPayments (wait for it, some tests take up to 2 minutes)', function(){
        var hdpubkey = mockreq.getRandomHdPubKey(), count = 1000;

        it('should set updated timestamp on large number (' + count + ') of pending payment records requiring ' +
            'API calls to be made in multiple batched sets', function(done){
            this.timeout(120000);

            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                wipe: true,
                payment:{
                    bitcoin: {
                        checkFrequency: 0,
                        network: 'livenet',
                        confirmations: 0
                    }
                }
            });

            return botbouncer.init(opt)
            .then(function(){
                var now = moment.utc(),
                    pays = [],
                    i,
                    Payment = botbouncer.getModelPayment(),
                    pm = Payment.getPaymentMethods(),
                    ps = Payment.getStatuses(),
                    am = Payment.getAddressMethods(),
                    network = Payment.getNetworks(),
                    amountOwed = 123,
                    method = pm.BITCOIN,
                    methodName = 'bitcoin',
                    net = network.BITCOIN.LIVENET,
                    p = Q.resolve(),
                    now = moment.utc();

                // create records 
                for(i = 0; i < count; i++)(function(i){
                    var pay = new Payment({
                        visitor_id: i + 1,
                        method_id: method, 
                        address_method_id: am.HDPUBKEY,
                        amount_owed: amountOwed, 
                        amount_rcvd: 0,
                        hdpubkey: hdpubkey,
                        network_id: net, 
                        status_id: ps.PENDING,
                        expires: now.clone().add(3, 'days').toDate()
                    });

                    p = p.then(function(){
                        return pay.generateAddress();
                    })
                    .then(function(){
                        var def = Q.defer();
                        pay.save(function(err, paynew){
                            if (err) return def.reject(err);
                            pays.push(paynew); 
                            return def.resolve();
                        });
                        return def.promise; 
                    });
                })(i);

                return p.then(function(){
                    return botbouncer.isCheckingPayments(methodName)
                    .then(function(inprog){
                        expect(inprog).to.equal(false);
                        return botbouncer.checkPayments({method: methodName});
                    })
                })
                // check results
                .then(function(r){
                    return botbouncer.isCheckingPayments(methodName)
                    .then(function(inprog){
                        expect(inprog).to.equal(false);
                        expect(r.errors instanceof Array).to.equal(true); 
                        expect(r.errors.length).to.equal(0, JSON.stringify(r.errors));
                        expect(r.total).to.equal(count);
                        expect(r.settled).to.equal(0);

                        // caminte IN query operator isn't working with strings...
                        return Q.ninvoke(Payment, 'find', {});
                    });
                })
                .then(function(r){
                    expect(r.length).to.equal(count);

                    // check statuses
                    lo.forEach(r, function(pay){
                        expect(now.isBefore(pay.updated)).to.equal(true, 'id = ' + pay.id);
                        expect(pay.amount_owed).to.equal(amountOwed);
                        expect(pay.status_id).to.equal(ps.PENDING);
                    });
                });
            })
            .then(done)
            .fail(done);
        });

        it('should update visitors + payments paid in full, partially, and not at all', function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                wipe: true,
                payment:{
                    bitcoin: {
                        checkFrequency: 0
                    }
                }
            });

            return botbouncer.init(opt)
            .then(function(){
                var now = moment.utc(),
                    visitors = {},
                    Payment = botbouncer.getModelPayment(),
                    Visitor = botbouncer.getModelVisitor(),
                    vs = Visitor.getStatuses(), 
                    pm = Payment.getPaymentMethods(),
                    ps = Payment.getStatuses(),
                    am = Payment.getAddressMethods(),
                    network = Payment.getNetworks(),
                    method = pm.BITCOIN,
                    methodName = 'bitcoin',
                    net = network.BITCOIN.LIVENET,
                    p = Q.resolve(),
                    now = moment.utc(),
                    // livenet zombie addresses that haven't been touched, expected balances in satoshis.
                    // NOTE: if tests fail, coins may have been moved
                    addies = mockreq.getBitcoinZombieAddresses(),
                    amountOwed = 5000000000,
                    alladdies = Object.keys(addies.paid).concat(Object.keys(addies.unpaid));

                // create records 
                lo.forEach(alladdies, function(addy, i){
                    // visitors
                    p = p.then(function(){
                        var visitor = new Visitor();
                        visitor.ip = chance.ip();
                        visitor.setStatusId(vs.BANNED);

                        return Q().then(function(){
                            var def = Q.defer();
                            visitor.isValid(function(valid){
                                expect(valid).to.equal(true);
                                def.resolve(visitor);
                            });
                            return def.promise;
                        })
                        .then(function(visitor){
                            return Q.ninvoke(visitor, 'save');
                        })
                    })
                    // payments
                    .then(function(visitor){
                        visitor._paid = addy in addies.paid; 
                        visitors[visitor.id] = visitor;

                        var pay = new Payment({
                            visitor_id: visitor.id, 
                            method_id: method,
                            address: addy,
                            address_method_id: am.HDPUBKEY,
                            amount_owed: amountOwed,
                            amount_rcvd: 0,
                            hdpubkey: hdpubkey,
                            network_id: net,
                            status_id: ps.PENDING,
                            expires: now.clone().add(3, 'days').toDate()
                        });

                        var def = Q.defer();
                        pay.isValid(function(valid){
                            expect(valid).to.equal(true);
                            def.resolve(pay);
                        });
                        return def.promise;
                    })
                    .then(function(pay){
                        var def = Q.defer();
                        pay.save(function(err, paynew){
                            if (err) return def.reject(err);
                            return def.resolve();
                        });
                        return def.promise; 
                    });
                });

                return p.then(function(){
                    return botbouncer.isCheckingPayments(methodName)
                    .then(function(inprog){
                        expect(inprog).to.equal(false);
                        return botbouncer.checkPayments({method: methodName});
                    })
                })
                // check results
                .then(function(r){
                    return botbouncer.isCheckingPayments(methodName)
                    .then(function(inprog){
                        expect(r.errors instanceof Array).to.equal(true);
                        expect(r.errors.length).to.equal(0);
                        expect(r.total).to.equal(alladdies.length);
                        expect(r.settled).to.equal(Object.keys(addies.paid).length);

                        // caminte IN query operator isn't working with strings...
                        return Q.ninvoke(Payment, 'find', {});
                    });
                })
                // check payment statuses
                .then(function(r){
                    expect(r.length).to.equal(alladdies.length);

                    // check payment statuses
                    var payaddies = r.map(function(pay){ return pay.address;});
                    payaddies.sort();
                    alladdies.sort();
                    expect(payaddies).to.deep.equal(alladdies);

                    lo.forEach(r, function(pay){
                        expect(now.isBefore(pay.updated)).to.equal(true);
                        expect(pay.amount_owed).to.equal(amountOwed);
                        switch(pay.status_id){
                            case ps.PENDING:
                                expect(pay.address in addies.unpaid).to.equal(true); 
                                expect(pay.amount_rcvd).to.equal(addies.unpaid[pay.address]);
                                break;

                            case ps.SETTLED:
                                expect(pay.address in addies.paid).to.equal(true); 
                                expect(pay.amount_rcvd).to.equal(addies.paid[pay.address]);
                                break;

                            // shouldnt get here
                            default:
                                expect(true).to.equal(false); break;
                                break;
                        }
                    });
                })
                // check visitor statuses
                .then(function(){
                    return Q.ninvoke(Visitor, 'find', {});
                })
                .then(function(r){
                    expect(r.length).to.equal(Object.keys(visitors).length);

                    lo.forEach(r, function(visitor, i){
                        // paid
                        if (visitors[visitor.id]._paid){
                            expect(visitor.getStatusId()).to.equal(vs.ALLOWED);
                            expect(
                                moment(visitor.status_set).isAfter(visitors[visitor.id].status_set)
                            ).to.equal(true);
                            expect(visitor.status_reason).to.not.equal(visitors[visitor.id].status_reason);
                            expect(moment(visitor.status_expires).isAfter(now)).to.equal(true);
                        }
                        // unpaid or partial paid
                        else {
                            expect(visitor.getStatusId()).to.equal(vs.BANNED); 
                            expect(
                                moment(visitor.status_set).isSame(visitors[visitor.id].status_set)
                            ).to.equal(true);
                            expect(visitor.status_reason).to.equal(visitors[visitor.id].status_reason);
                            expect(visitor.status_expires).to.equal(null);
                            expect(visitors[visitor.id].status_expires).to.equal(null);
                        }

                        // other props shouldnt change
                        expect(moment(visitor.created).isSame(visitors[visitor.id].created)).to.equal(true);
                        lo.forEach(['id', 'ip', 'ipv', 'hostname'], function(k){
                            expect(visitors[visitor.id][k]).to.equal(visitors[visitor.id][k]);
                        });
                    });
                })
            })
            .then(done)
            .fail(done);
        });

        it("should periodically checkPayments", function(done){
            var opt = lo.cloneDeep(initOpt),
                checks = 5,
                starts = 0,
                stops = 0;

            lo.merge(opt, {
                wipe: true, 
                payment:{
                    bitcoin:{
                        checkFrequency: 100,
                        checkTimeout: 50
                    }
                } 
            });

            botbouncer.emitter.on('checkPaymentsStart', function(){ starts++; });
            botbouncer.emitter.on('checkPaymentsEnd', function(){ stops++; });

            return botbouncer.init(opt)
            .then(function(){
                var def = Q.defer(),
                    bbopt = botbouncer.getOpt();

                setTimeout(function(){
                    botbouncer.killCheckPaymentsInterval('bitcoin');
                    botbouncer.emitter.removeAllListeners('checkPaymentsStart');
                    botbouncer.emitter.removeAllListeners('checkPaymentsEnd');
                    expect(starts).to.equal(stops);
                    expect(checks - 1).to.equal(stops);
                    def.resolve();
                }, (bbopt.payment.bitcoin.checkFrequency * checks) + 1);
                return def.promise;
            })
            .then(done)
            .fail(done);
        });

        it('botbouncer should call checkPayments() X times within a time limit with respect to checkTimeout', 
            function(done){
            var opt = lo.cloneDeep(initOpt);
            lo.merge(opt, {
                wipe: true,
                payment:{
                    bitcoin:{
                        checkFrequency: 100,
                        checkTimeout: 500
                    }
                }
            });

            var timelimit = 1000,
                expectedcalls = Math.floor(timelimit / opt.payment.bitcoin.checkFrequency) - 1,
                expectedends = Math.floor(timelimit / opt.payment.bitcoin.checkTimeout), 
                defcalls = Q.defer(),
                defends = Q.defer(),
                timeout,
                p = [];

            p.push(defcalls.promise);
            p.push(defends.promise);

            botbouncer.emitter.on('checkPaymentsPre', function(r){
                expectedcalls--;
                if (expectedcalls <= 0) defcalls.resolve();
            });

            // call completes b/c timeout wait exceeded
            botbouncer.emitter.on('checkPaymentsEnd', function(r){
                expectedends--;
                if (expectedends <= 0) defends.resolve();
            });

            return botbouncer.init(opt)
            .then(function(){
                timeout = setTimeout(function(){
                    // should not get here
                    expect(true).to.equal(false, 'time limit ran out'); 
                    defcalls.resolve();
                    defends.resolve();
                }, timelimit);

                return Q.all(p); 
            })
            .then(function(){
                clearTimeout(timeout);
            })
            .then(done)
            .fail(done);
        });
    });
});
