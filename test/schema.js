'use strict';

var lo = require('lodash'),
    Q = require('q'),
    fs = require('fs'),
    moment = require('moment'),
    expect = require("chai").expect,
    mockreq = require('./mockreq'),
    setup = require('./setup'),
    util = require('../lib/utility'),
    bitcorelib = require('bitcore-lib'),
    schemaArgs = setup.schemaArgs,
    schema, 
    Schema, 
    Visitor, 
    Request, 
    Payment,
    Meta,
    vs,     // visitor statuses
    pm,     // payment methods
    ps,     // payment statuses
    am,     // address methods
    network; // payment networks

describe("schema", function() {
    before(function (done) {
        setup.removeDb();
        schema = setup.getSchema();
        schemaArgs = setup.schemaArgs;
        Schema = schema.Schema;
        Visitor = schema.Visitor;
        Request = schema.Request;
        Payment = schema.Payment;
        Meta = schema.Meta;
        vs = Visitor.getStatuses();
        pm = Payment.getPaymentMethods();
        ps = Payment.getStatuses();
        am = Payment.getAddressMethods();
        network = Payment.getNetworks();
        return Schema.onConnected().then(done);
    });
    after(function (done) {
        setup.removeDb();
        done();
    });

    describe('cloneModelForTransaction', function(){
        it("should not change the original model's client object or schema's client object", function(done){
            return Q.ninvoke(Schema.client, 'beginTransaction')
            .then(function(trx){
                var Visitor2 = Schema.cloneModelForTransaction(Visitor, trx);

                expect(typeof(Visitor2.schema.adapter.client.commit)).to.equal('function');
                expect(typeof(Visitor.schema.adapter.client.commit)).to.equal('undefined');
                expect(typeof(Schema.client.commit)).to.equal('undefined');
                expect(typeof(Schema.client.currentTransaction)).to.equal('object');
                expect(typeof(Visitor2.schema.adapter.client.currentTransaction)).to.equal('undefined');

                expect(Visitor2.schema.adapter.client).to.not.deep.equal(Visitor.schema.adapter.client);
                expect(Visitor2.schema.adapter.client).to.not.deep.equal(Schema.client);
                 
                return Q.ninvoke(trx, 'commit');
            })
            .then(done)
            .fail(done);
        }); 
    });

    describe('cloneInstanceForTransaction', function(){
        it("should not change the original instance's client object or schema's client object", function(done){
            var visitor = new Visitor();
            return Q.ninvoke(Schema.client, 'beginTransaction')
            .then(function(trx){
                var visitor2 = Schema.cloneInstanceForTransaction(visitor, Visitor, trx);

                expect(typeof(visitor2.constructor.schema.adapter.client.commit)).to.equal('function');
                expect(typeof(visitor.constructor.schema.adapter.client.commit)).to.equal('undefined');

                expect(typeof(Schema.client.commit)).to.equal('undefined');
                expect(typeof(Schema.client.currentTransaction)).to.equal('object');
                expect(typeof(visitor2.constructor.schema.adapter.client.currentTransaction)).to.equal('undefined');

                expect(visitor2.constructor.schema.adapter).to.not.deep.equal(
                    visitor.constructor.schema.adapter
                );
                expect(visitor2.constructor.schema.adapter).to.not.deep.equal(Schema.client);
                expect(visitor).to.not.deep.equal(visitor2); 

                return Q.ninvoke(trx, 'commit');
            })
            .then(done)
            .fail(done);
        }); 
    });

    describe("Meta model", function() {
        describe('Meta.getAndSet', function(){
            it("should create a new record if key's record doesn't exist", function(done){
                return Q().then(function(){
                    // wipe
                    return Q.ninvoke(Schema, 'automigrate');
                })
                .then(function(){
                    return Meta.getAndSet('foo', function(val){
                        expect(typeof(val)).to.equal('undefined');
                        return 'bar';
                    })
                    .then(function(val){
                        expect(val).to.equal('bar');
                        return Q.ninvoke(Meta, 'find', {where: {key: 'foo'}}) 
                        .then(function(r){
                            expect(r.length).to.equal(1);
                            expect(r[0].key).to.equal('foo');
                            expect(r[0].val).to.equal('bar');
                        });
                    });
                })
                .then(done)
                .fail(done);
            }); 
            it("should update record if key's row already exists", function(done){
                return Q().then(function(){
                    // wipe
                    return Q.ninvoke(Schema, 'automigrate');
                })
                .then(function(){
                    return Meta.getAndSet('foo', function(val){
                        expect(typeof(val)).to.equal('undefined');
                        return 'bar';
                    })
                    .then(function(val){
                        expect(val).to.equal('bar');
                        return Meta.getAndSet('foo', function(val){
                            expect(val).to.equal('bar');
                            return 'oof';
                        });
                    })
                    .then(function(val){
                        expect(val).to.equal('oof');
                        return Q.ninvoke(Meta, 'find', {where: {key: 'foo'}}) 
                        .then(function(r){
                            expect(r.length).to.equal(1);
                            expect(r[0].key).to.equal('foo');
                            expect(r[0].val).to.equal('oof');
                        });
                    });
                })
                .then(done)
                .fail(done);
            });
            it("should atomically get and set row val when called multiple times async with other update queries", 
            function(done){
                var trxdone = {},
                    querydone = {},
                    count = 10;

                return Q().then(function(){
                    // wipe
                    return Q.ninvoke(Schema, 'automigrate');
                })
                .then(function(){
                    var p = [],
                        p2 = [];

                    for(var i = 0; i < count; i++)(function(i){
                        p.push(
                            Meta.getAndSet('foo', function(val){
                                // interspersed queries should always be executed after getAndSet trx is complete 
                                p2.push(
                                    Q().then(function(){
                                        expect(typeof(trxdone[i])).to.equal('undefined');
                                        return Q.ninvoke(Meta, 'update', {key: 'foo'}, {val: 'bar'})
                                        .then(function(){
                                            expect(trxdone[i]).to.equal(true); 
                                            querydone[i] = true;
                                        })
                                    })
                                );

                                var def = Q.defer();
                                setTimeout(function(){
                                    def.resolve(i); 
                                }, 100);

                                return def.promise;
                            })
                            .then(function(val){
                                trxdone[i] = true;
                            })
                        );
                    })(i);

                    return Q.all(p).then(function(){ return Q.all(p2); });
                })
                .then(function(){
                    for(var i = 0; i < count; i++)(function(i){
                        expect(trxdone[i]).to.equal(true);
                        expect(querydone[i]).to.equal(true);
                    })(i);

                    return Meta.getAndSet('foo', function(val){
                        expect(val).to.equal('bar');
                        return;
                    })
                    .then(function(){});
                })
                .then(done)
                .fail(done);
            });
        });
    });

    describe("Request model", function() {
        it('should validate and create record', function(done){
            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // validate 
            .then(function(){
                var def = Q.defer(),
                    r = new Request();

                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = 666;

                r.isValid(function(valid){
                    expect(valid).to.equal(true);
                    def.resolve(r); 
                });
                return def.promise;
            })
            // create 
            .then(function(r){
                var def = Q.defer();
                r.save(function(err, rnew){
                    expect(err).to.equal(null);
                    def.resolve(new Request(rnew));
                });
                return def.promise;
            })
            // lookup
            .then(function(r){
                var def = Q.defer();
                Request.find({where: {id: r.id}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(res[0].toObject()).to.deep.equal(r.toObject());
                    def.resolve();
                });
                return def.promise;
            })
            .then(done)
            .fail(function(err){
                done(err);
            });
        });
        it('create of duplicate record should throw unique constraint error', function(done){
            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // create 
            .then(function(){
                var r = new Request();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = 666;
                return Q.ninvoke(r, 'save');
            })
            // try to create again 
            .then(function(rnew){
                return Q.ninvoke(Request, 'create', rnew);
            })
            // should fail 
            .fail(function(err){
                expect(Schema.isUniqueConstraintError(err)).to.equal(true);
                return done();
            });
        });
        it('save should update record', function(done){
            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // create 
            .then(function(){
                var r = new Request();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = 666;
                return Q.ninvoke(r, 'save');
            })
            // update 
            .then(function(r){
                var def = Q.defer();
                r.visitor_id = 666;
                r.protocol = 'http';
                r.path = '/someother/path';
                r.query = null; 
                r.headers = {'user-agent': '-'};
                r.save(function(err, rnew){
                    expect(err).to.equal(null);
                    def.resolve(rnew);
                });
                return def.promise; 
            })
            // query
            .then(function(rnew){
                var def = Q.defer();
                Request.find({where: {id: rnew.id}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(rnew.toObject()).to.deep.equal(res[0].toObject());

                    // confirm dates are indeed date objects 
                    lo.forOwn(Request.getPropsDefs(), function(prop, k){
                        if (prop.type &&
                            prop.type.toString().indexOf('function Date()') === 0){ 
                            if (res[0][k]) expect(res[0][k] instanceof Date).to.equal(true);
                        }
                    });
                    def.resolve();
                });
                return def.promise; 
            })
            .then(done)
            .fail(function(err){
                done(err);
            });
        });
    });

    describe("Visitor model", function() {
        it('setIpv should set ipv = 4 for ipv4 ip addresses', function(done){
            var v = new Visitor(),
                ips = ['127.0.0.1', '192.168.0.1', '93.18.220.156'];

            lo.forEach(ips, function(ip){
                v.ip = ip;
                v.setIpv();
                expect(v.ipv).to.equal(4);
                v.ipv = null;
            });
            done();
        });
        it('setIpv should set ipv = 6 for ipv6 ip addresses', function(done){
            var v = new Visitor(),
                ips = [
                '::1',
                'FE80:0000:0000:0000:0202:B3FF:FE1E:8329',
                'FE80::0202:B3FF:FE1E:8329',
                '2001:0db8:0a0b:12f0:0000:0000:0000:0001',
                '2001:cdba:0000:0000:0000:0000:3257:9652',
                '2001:cdba:0:0:0:0:3257:9652',
                '2001:cdba::3257:9652',
                '3ffe:1900:4545:3:200:f8ff:fe21:67cf',
                'fe80::200:f8ff:fe21:67cf'
            ]; 

            lo.forEach(ips, function(ip){
                v.ip = ip;
                v.setIpv();
                expect(v.ipv).to.equal(6);
                v.ipv = null;
            });
            done();
        });

        it('hasStatusExpired should return false for an unexpired status', function(done){
            var v = new Visitor(),
                now = moment.utc(),
                wait = 100;

            v.setStatusId(vs.BLACKLISTED, {until: now.add(wait, 'milliseconds').toDate()});
            expect(v.getStatusId()).to.equal(vs.BLACKLISTED);
            setTimeout(function(){
                expect(v.hasStatusExpired()).to.equal(false); 
                done();
            }, wait - 10);

        });

        it('getStatus should return null for an expired status', function(done){
            var v = new Visitor(),
                now = moment.utc(),
                wait = 10;

            v.setStatusId(vs.BLACKLISTED, {until: now.add(wait, 'milliseconds').toDate()});
            expect(v.getStatusId()).to.equal(vs.BLACKLISTED);
            setTimeout(function(){
                expect(v.getStatusId()).to.equal(null);
                done();
            }, wait + 1);
        });

        it('should validate and create ipv4 record', function(done){
            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // validate 
            .then(function(){
                var v = new Visitor({
                    ip: '93.18.220.156',
                    hostname: 'foo.bar.com'
                }),
                def = Q.defer();

                v.isValid(function(valid){
                    expect(valid).to.equal(true);
                    def.resolve(v); 
                });
                return def.promise;
            })
            // create 
            .then(function(v){
                var def = Q.defer();
                v.save(function(err, vnew){
                    expect(err).to.equal(null);
                    expect(vnew.ipv).to.equal(4);
                    def.resolve(new Visitor(vnew));
                });
                return def.promise;
            })
            // lookup
            .then(function(v){
                var def = Q.defer();
                Visitor.find({where: {ip: v.ip}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(res[0].toObject()).to.deep.equal(v.toObject());
                    def.resolve();
                });
                return def.promise;
            })
            .then(done)
            .fail(function(err){
                done(err);
            });
        });
        it('create of duplicate record should throw unique constraint error on ip column', function(done){
            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // create 
            .then(function(){
                var v = new Visitor({
                    ip: '93.18.220.156',
                    hostname: 'foo.bar.com'
                });
                return Q.ninvoke(v, 'save');
            })
            // try to create again 
            .then(function(vnew){
                var v = {
                    ip: '93.18.220.156',
                    hostname: 'foo.bar.baz'
                }; 
                return Q.ninvoke(Visitor, 'create', v);
            })
            // should fail 
            .fail(function(err){
                if (err.message && err.message.indexOf('SQLITE_CONSTRAINT: UNIQUE constraint failed: visitor.ip') === 0){
                    return done();
                }
                done(err);
            });
        });
        it('save should update record', function(done){
            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // create 
            .then(function(){
                var v = new Visitor({
                    ip: '93.18.220.156',
                    hostname: 'foo.bar.com'
                });
                return Q.ninvoke(v, 'save');
            })
            // update 
            .then(function(vnew){
                vnew.setStatusId(vs.BLACKLISTED, {until: moment.utc().add(30, 'days').toDate()});
                var def = Q.defer();
                vnew.save(function(err, vnew){
                    expect(err).to.equal(null);
                    def.resolve(vnew);
                });
                return def.promise; 
            })
            // query
            .then(function(vnew){
                var def = Q.defer();
                Visitor.find({where: {id: vnew.id}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(vnew.toObject()).to.deep.equal(res[0].toObject());

                    // confirm dates are indeed date objects 
                    lo.forOwn(Visitor.getPropsDefs(), function(prop, k){
                        if (prop.type &&
                            prop.type.toString().indexOf('function Date()') === 0){ 
                            if (res[0][k]) expect(res[0][k] instanceof Date).to.equal(true);
                        }
                    });
                    def.resolve();
                });
                return def.promise; 
            })
            .then(done)
            .fail(function(err){
                done(err);
            });
        });

        it('save new record + related request record', function(done){
            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // create 
            .then(function(){
                var v = new Visitor({
                    ip: '93.18.220.156',
                    hostname: 'foo.bar.com'
                });
                return Q.ninvoke(v, 'save');
            })
            .then(function(v){
                var r = new Request(),
                    def = Q.defer();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = v.id;
                v.requests.create(r, function(err, rnew){
                    return def.resolve({v: v, r: rnew});
                });
                return def.promise;
            })
            // query
            .then(function(obj){
                var v = obj.v;
                var r = obj.r;
                var def = Q.defer();
                Visitor.find({where: {id: v.id}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(v.toObject()).to.deep.equal(res[0].toObject());

                    // check request was created
                    v.requests({}, function(err, res){
                        expect(res.length).to.equal(1);
                        expect(r.toObject()).to.deep.equal(res[0].toObject());
                        def.resolve(obj);
                    });
                });
                return def.promise; 
            })
            // add another request record
            .then(function(obj){
                var v = obj.v;
                var r = new Request(),
                    def = Q.defer();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = v.id;
                v.requests.create(r, function(err, rnew){
                    return def.resolve({v: v, r: rnew});
                });
                return def.promise;
            })
            // query
            .then(function(obj){
                var v = obj.v;
                var r = obj.r;
                var def = Q.defer();
                Visitor.find({where: {id: v.id}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);

                    // check requests created
                    v.requests({}, function(err, res){
                        expect(res.length).to.equal(2); 
                        expect(r.toObject()).to.deep.equal(res[1].toObject());
                        def.resolve();
                    });
                });
                return def.promise; 
            })
            .then(done)
            .fail(function(err){
                done(err);
            });
        });
        it('should have correct requested datetimes when adding multiple requests', function(done){
            var now = moment.utc();

            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // create 
            .then(function(){
                var v = new Visitor({
                    ip: '93.18.220.156',
                    hostname: 'foo.bar.com'
                });
                return Q.ninvoke(v, 'save');
            })
            // first request
            .then(function(v){
                var r = new Request(),
                    def = Q.defer();
                r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                r.visitor_id = v.id;
                v.requests.create(r, function(err, rnew){
                    return def.resolve({v: v, r: rnew});
                });
                return def.promise;
            })
            // 2nd request
            .then(function(obj){
                var v = obj.v; 
                var r = new Request(),
                    def = Q.defer();
                setTimeout(function(){
                    r.fromExpressRequest(mockreq.getRandomBrowserRequest());
                    r.visitor_id = v.id;
                    v.requests.create(r, function(err, rnew){
                        return def.resolve({v: v, r1: obj.r, r2: rnew});
                    });
                }, 10);
                return def.promise;
            })
            // query
            .then(function(obj){
                var v = obj.v;
                var r1 = obj.r1;
                var r2 = obj.r2;
                var def = Q.defer();
                Visitor.find({where: {id: v.id}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(v.toObject()).to.deep.equal(res[0].toObject());

                    // check requests were created
                    v.requests({}, function(err, res){
                        expect(res.length).to.equal(2); 
                        expect(r1.toObject()).to.deep.equal(res[0].toObject());
                        expect(r2.toObject()).to.deep.equal(res[1].toObject());

                        // check timestamps
                        var r1reqd = moment(r1.requested);
                        var r2reqd = moment(r2.requested);
                        expect(now.isBefore(r1reqd)).to.equal(true);
                        expect(now.isBefore(r2reqd)).to.equal(true);
                        expect(r1reqd.isBefore(r2.reqd)).to.equal(true);

                        def.resolve();
                    });
                });
                return def.promise; 
            })
            .then(done)
            .fail(function(err){
                done(err);
            });
        });

        describe('getPendingPayment', function(){
            it('should only create 1 pending payment (via transaction) when called multiple times async', 
            function(done){
                var trxdone = {};

                return Q().then(function(){
                    var v = new Visitor({
                        ip: '66.66.66.66', 
                        hostname: 'foo.bar.com',
                        status_id: vs.BANNED,
                        status_reason: 'cuz',
                        status_expires: moment.utc().add(3, 'days').toDate()
                    });

                    return Q.ninvoke(v, 'save');
                })
                .then(function(v){
                    var p = [],
                        count = 10,
                        now = moment.utc(),
                        hdpubkey = mockreq.getRandomHdPubKey(),
                        pays = [];

                    for(var i = 0; i < count; i++)(function(i){
                        p.push(
                            v.getPendingPayment({
                                create: true,
                                method_id:  pm.BITCOIN,
                                network_id: network.BITCOIN.LIVENET,
                                paymentProps: {
                                    method_id: pm.BITCOIN,
                                    address_method_id: am.HDPUBKEY, 
                                    hdpubkey: hdpubkey, 
                                    network_id: network.BITCOIN.LIVENET,
                                    expires: now.clone().add(3, 'days').toDate()

                                },
                                amountOwed: 1.00345678 
                            })
                            // trx complete
                            .then(function(pay){
                                trxdone[i] = true;
                                pays.push(pay);
                            })
                        );

                        // intersperse some fast async queries and ensure they always get executed after the 
                        // transaction is complete
                        p.push((function(){
                            var def = Q.defer();
                            setTimeout(function(){
                                return Q.ninvoke(Payment, 'count')
                                .then(function(){
                                    expect(trxdone[i]).to.equal(true);   
                                })
                                .then(def.resolve);
                            }, (i) * 10);
                            return def.promise;
                        })());

                        p.push((function(){
                            var def = Q.defer();
                            setTimeout(function(){
                                return Q.ninvoke(Visitor, 'count')
                                .then(function(){
                                    expect(trxdone[i]).to.equal(true);   
                                })
                                .then(def.resolve);
                            }, (i) * 10);
                            return def.promise;
                        })());

                    })(i);
                    return Q.all(p)
                    .then(function(){
                        lo.forEach(trxdone, function(f){
                            expect(f).to.equal(true);
                        });

                        // ensure all returned pending payments are the same
                        var pay = pays[0];
                        expect(pay instanceof Payment).to.equal(true);
                        lo.forEach(pays, function(p, i){
                            expect(p instanceof Payment).to.equal(true);
                            expect(p.toObject()).to.deep.equal(pay.toObject());

                            // ensure the client is not the transactional client
                            expect(typeof(p.constructor.schema.adapter.client.commit)).to.equal('undefined');
                        });

                        // check database 
                        return Q.ninvoke(Payment, 'find', {
                            where: {
                                visitor_id: v.id, 
                                method_id: pm.BITCOIN
                            }
                        })
                        .then(function(r){
                            expect(r.length).to.equal(1);
                        });
                    });
                })
                .then(done)
                .fail(done);
            }); 
        });
    });

    describe("Payment model", function() {
        var hdpubkey = mockreq.getRandomHdPubKey(); 

        describe('getStatuses', function(){
            it('should return object of statuses', function(done){
                var s = Payment.getStatuses();
                expect(typeof(s)).to.equal('object');
                expect(Object.keys(s).length > 0).to.equal(true);
                for(var k in s){
                    expect(typeof(k)).to.equal('string');
                    expect(util.isPositiveInteger(s[k])).to.equal(true);
                } 
                done();
            });
        });

        describe('setAmountFromDecimal', function(){
            lo.forEach(['amount_owed', 'amount_rcvd'], function(k){
                it('should convert decimal to integer units (and vice versa) for field: ' + k, function(done){
                    var pay = new Payment({
                        visitor_id: 666,
                        method_id: pm.BITCOIN
                    });

                    pay.setAmountFromDecimal(0.00000001, k);
                    expect(pay[k]).to.equal('1');

                    pay.setAmountFromDecimal(0.12345678, k);
                    expect(pay[k]).to.equal('12345678');

                    pay.setAmountFromDecimal(12345678.12345678, k);
                    expect(pay[k]).to.equal('1234567812345678');

                    // > 15 digit ints need to be ina string, console.log(9332654729891549) = 9332654729891548
                    pay.setAmountFromDecimal('9332654729891549', k);
                    expect(pay[k]).to.equal('933265472989154900000000');

                    // sqlite integer max 2^63-1 = 9223372036854775807
                    pay.setAmountFromDecimal('9223372036854775807', k);
                    expect(pay[k]).to.equal('922337203685477580700000000');

                    // reverse it
                    pay.setAmountFromDecimal('1', k, {reverse: true});
                    expect(pay[k]).to.equal('0.00000001');

                    pay.setAmountFromDecimal(12345678, k, {reverse: true});
                    expect(pay[k]).to.equal('0.12345678');

                    pay.setAmountFromDecimal('1234567812345678', k, {reverse: true});
                    expect(pay[k]).to.equal('12345678.12345678');

                    pay.setAmountFromDecimal('933265472989154900000000', k, {reverse: true});
                    expect(pay[k]).to.equal('9332654729891549');

                    pay.setAmountFromDecimal('922337203685477580700000000', k, {reverse: true});
                    expect(pay[k]).to.equal('9223372036854775807');

                    done();
                });
            });
        });

        describe('reuseExpired', function(){
            it("should return false when no expired payment exists and not modify payment object", function(done){
                return Q().then(function(){
                    // wipe
                    return Q.ninvoke(Schema, 'automigrate');
                })
                .then(function(){
                    var pay = new Payment({
                            visitor_id: 666,
                            method_id: pm.BITCOIN,
                            address_method_id: am.HDPUBKEY,
                            network_id: network.BITCOIN.LIVENET
                        }),
                        payorig = lo.cloneDeep(pay.toObject());

                    return pay.reuseExpired()
                    .then(function(r){
                        expect(r).to.equal(false);
                        expect(typeof(r.id)).to.equal('undefined');
                        expect(pay.toObject()).to.deep.equal(payorig);
                    });
                })
                .then(done)
                .fail(done);
            });

            it("should hijack the oldest existing expired payment record", function(done){
                return Q().then(function(){
                    // wipe
                    return Q.ninvoke(Schema, 'automigrate');
                })
                .then(function(){
                    // add X expired payment records
                    var paycount = 4, 
                        pays = [],
                        p = Q.resolve(),
                        hdpubkey = mockreq.getRandomHdPubKey(),
                        now = moment.utc();

                    return Q().then(function(){
                        // instantiate X payments, evens are pending, odds are expired 
                        var i;

                        for(i = 0; i < paycount; i++)(function(i){
                            var notexpired = i % 2 === 0;
                            var pay = new Payment({
                                visitor_id: i + 777,
                                method_id: pm.BITCOIN,
                                address_method_id: am.HDPUBKEY,
                                amount_owed: 123,
                                amount_rcvd: 0,
                                hdpubkey: hdpubkey,
                                network_id: network.BITCOIN.LIVENET,
                                status_id: notexpired ? ps.PENDING : ps.EXPIRED,
                                expires: notexpired ? 
                                    now.clone().add(3, 'days').toDate() : now.clone().subtract(3, 'days').toDate()
                            });

                            // save
                            p = p.then(function(){
                                return Q.ninvoke(pay, 'save', {generateAddress: true, reuseExpiredPayment: false}) 
                                .then(function(paynew){
                                    pays.push(paynew);
                                })
                            });
                        })(i);

                        return p; 
                    })
                    // expect a new payment to reuse the pays[1] properties
                    .then(function(){
                        var pay = new Payment({
                            visitor_id: 666,
                            method_id: pm.BITCOIN,
                            address_method_id: am.HDPUBKEY,
                            network_id: network.BITCOIN.LIVENET,
                            amount_owed: 999999,
                            amount_rcvd: 888888,
                            hdpubkey: mockreq.getRandomHdPubKey(), 
                            status_id: ps.PENDING,
                            expired: now.clone().add(100, 'days').toDate(),
                        }),
                        payorig = lo.cloneDeep(pay.toObject());

                        return pay.reuseExpired()
                        .then(function(r){
                            expect(r).to.equal(true);

                            // should share specific properties of pays[1], the first expired payment record
                            var copiedProps = ['id', 'address', 'address_method_id', 'hdpubkey', 'derive_index', 'created'];
                            lo.forOwn(pay.toObject(), function(v, k){
                                if (lo.includes(copiedProps, k)){
                                    expect(pay[k]).to.deep.equal(pays[1][k]); 
                                    return;
                                }
                                expect(pay[k]).to.deep.equal(payorig[k]);
                            });
                        });
                    })
                })
                .then(done)
                .fail(done);

            });
        });

        describe('generateAddress', function(){
            describe('hd public key method', function(){
                it("should return the hdpubkey's first derived address", function(done){
                    return Q().then(function(){
                        // wipe
                        return Q.ninvoke(Schema, 'automigrate');
                    })
                    .then(function(){
                        var pay = new Payment({
                                visitor_id: 666,
                                method_id: pm.BITCOIN, 
                                address_method_id: am.HDPUBKEY, 
                                network_id: network.BITCOIN.LIVENET 
                            });

                        return pay.generateAddress({hdpubkey: hdpubkey})
                        .then(function(addy){
                            expect(typeof(addy)).to.equal('string');
                            expect(addy).to.equal(pay.address);
                            expect(bitcorelib.Address.isValid(pay.address)).to.equal(true);
                            expect(addy).to.equal(mockreq.deriveAddressFromHdPubKey(hdpubkey, 0, 'livenet'));
                        });
                    })
                    .then(done)
                    .fail(done);
                });

                var deriveIndex = 666;
                it("should return the hdpubkey's " + deriveIndex + "th derived address", function(done){
                    return Q().then(function(){
                        // wipe
                        return Q.ninvoke(Schema, 'automigrate');
                    })
                    .then(function(){
                        var pay = new Payment({
                                visitor_id: 777,
                                method_id: pm.BITCOIN, 
                                address_method_id: am.HDPUBKEY, 
                                network_id: network.BITCOIN.LIVENET
                            });

                        return pay.generateAddress({hdpubkey: hdpubkey, deriveIndexStart: deriveIndex})
                        .then(function(addy){
                            expect(typeof(addy)).to.equal('string');
                            expect(addy).to.equal(pay.address);
                            expect(bitcorelib.Address.isValid(pay.address)).to.equal(true);
                            expect(addy).to.equal(mockreq.deriveAddressFromHdPubKey(hdpubkey, deriveIndex, 'livenet'));
                        });
                    })
                    .then(done)
                    .fail(done);
                });
            });
        });

        it('should validate and create record', function(done){
            var pay;

            return Q().then(function(){
                // wipe
                return Q.ninvoke(Schema, 'automigrate');
            })
            // validate 
            .then(function(){
                var def = Q.defer();
                pay = new Payment({
                    visitor_id: 666,
                    method_id: pm.BITCOIN,
                    address_method_id: am.HDPUBKEY,
                    hdpubkey: hdpubkey,
                    network_id: network.BITCOIN.LIVENET 
                }); 

                pay.setAmountFromDecimal('20999999.12345678', 'amount_owed');
                pay.setAmountFromDecimal(0.00, 'amount_rcvd');

                return pay.generateAddress();
            })
            .then(function(){
                var def = Q.defer();
                pay.isValid(function(valid){
                    expect(valid).to.equal(true); 
                    def.resolve(pay);
                });
                return def.promise;
            })
            // create 
            .then(function(pay){
                var def = Q.defer();
                pay.save(function(err, paynew){
                    expect(err).to.equal(null);
                    def.resolve(new Payment(paynew));
                });
                return def.promise;
            })
            // lookup
            .then(function(pay){
                var def = Q.defer();
                Payment.find({where: {id: pay.id}}, function(err, res){
                    expect(err).to.equal(null);
                    expect(res.length).to.equal(1);
                    expect(typeof(res[0])).to.equal('object');
                    expect(res[0].toObject()).to.deep.equal(pay.toObject());
                    def.resolve();
                });
                return def.promise;
            })
            .then(done)
            .fail(function(err){
                done(err);
            });
        });

        describe('save', function(){
            describe('hd public key method (some tests are slow)', function(){
                var paycount = 100;
                it('should create payment records with unique generated addresses when called async ' + 
                   paycount + ' times', function(done){
                    var pays = [];

                    return Q().then(function(){
                        // wipe
                        return Q.ninvoke(Schema, 'automigrate');
                    })
                    .then(function(){
                        // instantiate X payments without any addresses
                        var i; 

                        for(i = 0; i < paycount; i++)(function(i){ 
                            var pay = new Payment({
                                visitor_id: i + 777,
                                method_id: pm.BITCOIN,
                                address_method_id: am.HDPUBKEY,
                                amount_owed: 123,
                                amount_rcvd: 0,
                                hdpubkey: hdpubkey,
                                network_id: network.BITCOIN.LIVENET
                            });

                            pays.push(pay);
                        })(i);

                        // save them all
                        var p = [];

                        lo.forEach(pays, function(pay, i){
                            p.push((function(){
                                var def = Q.defer();
                                pay.save(function(err, paynew){
                                    if (err) return def.reject(err);
                                    pays[i] = paynew;
                                    return def.resolve();
                                });
                                return def.promise;
                            })());
                        });

                        return Q.all(p);
                    })
                    // expect all payments to now have a unique address
                    .then(function(){
                        var addys = pays.map(function(pay){ return pay.address; }); 

                        expect(addys.length).to.equal(lo.uniq(addys).length);
                        return Q.resolve();
                    })
                    .then(done)
                    .fail(done);
                });

                it('should reuse expired payment records when enabled and possible', function(done){
                    // instantiate X payments without any addresses
                    // first 25 will be expired with newly generated addresses
                    // next 25 should reuse the first 25 payment expired payment records
                    // remaining 50 will generate new addresses
                    // total = 75 records in db
                    var pays = {},
                        p = [],
                        expiredCount = 25,
                        totalRecords = paycount - expiredCount;

                    return Q().then(function(){
                        // wipe
                        return Q.ninvoke(Schema, 'automigrate');
                    })
                    .then(function(){
                        var i,
                            now = moment.utc();

                        for(i = 0; i < paycount; i++)(function(i){
                            var expired = i < expiredCount;

                            var pay = new Payment({
                                visitor_id: i + 777,
                                method_id: pm.BITCOIN,
                                address_method_id: am.HDPUBKEY,
                                amount_owed: i + 123,
                                amount_rcvd: 0, 
                                hdpubkey: hdpubkey,
                                network_id: network.BITCOIN.LIVENET,
                                status_id: expired ? ps.EXPIRED : ps.PENDING,
                                expires: expired ?
                                    now.clone().subtract(3, 'days').toDate() : now.clone().add(3, 'days').toDate() 
                            });

                            p.push(Q.ninvoke(
                                    pay, 'save', {generateAddress: true, reuseExpiredPayment: true}
                                )
                                .then(function(paynew){
                                    pays[paynew.id] = paynew;
                                })
                            );
                        })(i);

                        return Q.all(p);
                    })
                    // expect all payments to now have a unique address
                    .then(function(){
                        pays = lo.values(pays);
                        expect(pays.length).to.equal(totalRecords);

                        // all addresses should be unique
                        var addys = pays.map(function(pay){ return pay.address; });
                        expect(addys.length).to.equal(lo.uniq(addys).length);

                        // check db
                        // should be no expired payments
                        return Q.ninvoke(Payment, 'count', {where: {status_id: ps.EXPIRED}})
                        .then(function(cnt){
                            expect(cnt).to.equal(0);

                            // should be totalRecords pending payments 
                            return Q.ninvoke(Payment, 'count', {where: {status_id: ps.PENDING}});
                        })
                        .then(function(cnt){
                            expect(cnt).to.equal(totalRecords);
                        });
                    })
                    .then(done)
                    .fail(done);
                });
            });
        });

        describe('expirePayments', function(){
            it('should only set expired status on payments with expires date >= now', function(done){
                return Q().then(function(){
                    // wipe
                    return Q.ninvoke(Schema, 'automigrate');
                })
                .then(function(){
                    var now = moment.utc(),
                        i,
                        activecount = 6,
                        expirecount = 19,
                        activeids = [],
                        expireids = [],
                        p = Q.resolve();

                    // save records not expected to be expired 
                    for(i = 0; i < activecount; i++)(function(i){ 
                        var pay = new Payment({
                            visitor_id: i + 1,
                            method_id: pm.BITCOIN,
                            address_method_id: am.HDPUBKEY,
                            amount_owed: 123,
                            amount_rcvd: 0,
                            hdpubkey: hdpubkey,
                            network_id: network.BITCOIN.LIVENET,
                            status_id: ps.PENDING,
                            // make 1 record that doesnt ever expire
                            expires: i === 1 ? null : now.clone().add(3, 'days').toDate() 
                        });

                        p = p.then(function(){
                            return pay.generateAddress();
                        })
                        .then(function(){
                            var def = Q.defer();
                            pay.isValid(function(valid){
                                expect(valid).to.equal(true); 
                                def.resolve(pay);
                            });
                            return def.promise;
                        })
                        .then(function(){
                            var def = Q.defer();
                            pay.save(function(err, paynew){
                                if (err) return def.reject(err);
                                activeids.push(paynew.id); 
                                return def.resolve();
                            });
                            return def.promise; 
                        });
                    })(i);

                    // save records expected to be expired
                    for(i = 0; i < expirecount; i++)(function(i){ 
                        var pay = new Payment({
                            visitor_id: i + 1,
                            method_id: pm.BITCOIN,
                            address_method_id: am.HDPUBKEY,
                            amount_owed: 123,
                            amount_rcvd: 0,
                            hdpubkey: hdpubkey,
                            network_id: network.BITCOIN.LIVENET,
                            status_id: ps.PENDING,
                            expires: now.clone().subtract(1, 'millisecond').toDate()
                        });

                        p = p.then(function(){
                            return pay.generateAddress();
                        })
                        .then(function(){
                            var def = Q.defer();
                            pay.isValid(function(valid){
                                expect(valid).to.equal(true); 
                                def.resolve(pay);
                            });
                            return def.promise;
                        })
                        .then(function(){
                            var def = Q.defer();
                            pay.save(function(err, paynew){
                                if (err) return def.reject(err);
                                expireids.push(paynew.id); 
                                return def.resolve();
                            });
                            return def.promise; 
                        });
                    })(i);

                    return p.then(function(){
                        return Payment.expirePayments();
                    })
                    // check results
                    .then(function(){
                        return Q.ninvoke(Payment, 'find', {where: {status_id: ps.PENDING}});
                    })
                    .then(function(r){
                        expect(r.length).to.equal(activecount);
                        var ids = r.map(function(pay){ return pay.id; });
                        expect(ids).to.deep.equal(activeids);
                    })
                    .then(function(){
                        return Q.ninvoke(Payment, 'find', {where: {status_id: ps.EXPIRED}});
                    })
                    .then(function(r){
                        expect(r.length).to.equal(expirecount);
                        var ids = r.map(function(pay){ return pay.id; });
                        expect(ids).to.deep.equal(expireids);
                    });
                })
                .then(done)
                .fail(done);
            });
        });
    });
});
