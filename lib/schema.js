'use strict';

var caminte = require('caminte'),
    Schema  = caminte.Schema,
    lo = require('lodash'),
    validator = require('validator'), 
    Q = require('q'),
    moment = require('moment'),
    util = require('./utility'),
    sqlite3trx = require("sqlite3-transactions").TransactionDatabase,
    Url = require('url'); 

module.exports = function (opt) {
    opt = opt || {};
    lo.defaults(opt,{
        dbConfig: {} 
    });
    var ipvs = [4, 6],
        visitorStatus = {
            WHITELISTED: 1, 
            ALLOWED: 2, 
            BLACKLISTED: 3,
            BANNED: 4,
            SHITLISTED: 5
        },
        schema  = new Schema(opt.dbConfig.driver, opt.dbConfig);

    schema.on('error', function(err){
        schema.connError = err;
    });

    /**
     * Determines if an error object is a unique contstraint error 
     * 
     * @param {object} err      error object 
     * @return {bool} 
     */
    schema.isUniqueConstraintError = function(err){
        return err && err.message && err.message.indexOf('SQLITE_CONSTRAINT: UNIQUE constraint failed:') === 0;
    };

    // Meta - key/val table used for storing app state info, db version, etc 
    var metaProps = {
        key: { type: schema.String, 'null': false},
        val: { type: schema.String, 'null': true} 
    },
    metaIdx = {
        indexes: {
            key: {
                columns: 'key', 
                unique: true
            } 
        }
    },
    Meta = schema.define('meta', metaProps);

    /**
     * DBINCOMPAT?
     *
     * Performs an atomic value get and set using a transaction. Value is retrieved, passed to the supplied callback, 
     * and the callback's returned value is inserted/updated as the row's val value.
     * The callback is passed one parameter: 
     *
     * val      value of the record's val field
     *
     * Callback should return either the new value to set or a promise object that resolves with the new value to set.
     * 
     * @param {string} key      key value
     * @param {function} cb     callback called with retrieved value
     * @return {object}         promise object, resolves with new value
     */
    Meta.getAndSet = function(key, cb){
        return Q.ninvoke(schema.client, 'beginTransaction')
        .then(function(trx){
            var Meta2 = schema.cloneModelForTransaction(Meta, trx),
                exists = false;

            return Q.ninvoke(Meta2, 'find', {where: {key: key}})
            .then(function(r){
                exists = r && r[0];
                var val = exists ? r[0].val : undefined;

                var p; 
                try{ p = cb(val); }
                catch(e){
                    return Q.reject(e);
                }
                return p; 
            })
            .then(function(val){
                if (typeof(val) === 'undefined') return;

                if (exists){
                    return Q.ninvoke(Meta2, 'update', {key: key}, {val: val})
                    .then(function(){
                        return val;
                    });
                }
                return Q.ninvoke(Meta2, 'create', {key: key, val: val})
                .then(function(){
                    return val;
                });
            })
            .then(function(val){
                return Q.ninvoke(trx, 'commit').then(function(){ return val; });
            })
            .fail(function(err){
                var def = Q.defer();
                trx.rollback(function(e){ def.reject(err); });
                return def.promise;
            });
        }); 
    };

    // Visitor
    var visitorProps = {
        // id: { type: schema.Integer}, caminte creates this column automatically
        ip: { type: schema.String,  limit: 46, 'null': false},
        ipv: { type: schema.Integer},
        hostname: { type: schema.String, limit: 255, 'null': true, default: null},
        created: {type: schema.Date, default: Date.now, 'null': false},
        status_id: {type: schema.Integer, limit: 20, 'null': true, default: null},
        status_reason: {type: schema.String, limit: 100, 'null': true, default: null},
        status_set: {type: schema.Date, 'null': true},  // when their current status was set
        status_expires: {type: schema.Date, 'null': true}, // when their current status is to be unset
    },
    visitorIdx = {
        // primaryKeys: ['id'], caminte does this automatically
        indexes: {
            ip: {
                columns: 'ip',
                unique: true
            },
            status_id:{
                columns: 'status_id'
            },
            created:{
                columns: 'created'
            }
        }
    },
    Visitor = schema.define('visitor', visitorProps, visitorIdx);

    // Visitor validation
    Visitor.validateAsync('ip', function(err, done){
            var that = this;
            process.nextTick(function () {
                if (! validator.isIP(that.ip)) err();
                done();
            });
        },  
        {message: 'invalid ip'}
    );
    Visitor.validatesNumericalityOf('ipv', {int: true});

    Visitor.validateAsync('hostname', function(err, done){
            var that = this;
            process.nextTick(function () {
                if ((typeof(that.hostname) !== 'string' &&
                    that.hostname !== null) ||
                    (typeof(that.hostname) === 'string' &&
                    that.hostname.length > visitorProps.hostname.limit)){ 
                    err();
                }
                done();
            });
        },  
        {message: 'invalid hostname'}
    );
    Visitor.validateAsync('status_id', function(err, done){
            var that = this;
            process.nextTick(function () {
                if (typeof(that.status_id) !== 'undefined' && 
                    that.status_id !== null && 
                    ! lo.includes(lo.values(visitorStatus), that.status_id)){
                    err();
                }
                done();
            });
        },  
        {message: 'invalid visitor status_id'}
    );
    Visitor.validateAsync('status_set', function(err, done){
            var that = this;
            process.nextTick(function () {
                if (typeof(that.status_set) !== 'undefined' && 
                    that.status_set !== null && 
                    ! moment.isDate(that.status_set)){
                    err();
                }
                done();
            });
        },  
        {message: 'invalid visitor status_set date'}
    );
    Visitor.validateAsync('status_expires', function(err, done){
            var that = this;
            process.nextTick(function () {
                if (typeof(that.status_expires) !== 'undefined' && 
                    that.status_expires !== null && 
                    ! moment.isDate(that.status_expires)){
                    err();
                }
                done();
            });
        },  
        {message: 'invalid visitor status_expires date'}
    );
    Visitor.validateAsync('created', function(err, done){
            var that = this;
            process.nextTick(function () {
                if (! moment.isDate(that.created)) err();
                done();
            });
        },  
        {message: 'invalid visitor created date'}
    );

    Visitor.afterInitialize = function(){
        var that = this;

        // convert date milliseconds -> date objects
        lo.forOwn(Visitor.getPropsDefs(), function(prop, k){
            if (prop.type &&
                prop.type.toString().indexOf('function Date()') === 0 &&
                (typeof(that[k]) === 'string' || typeof(that[k]) === 'number')){
                that[k] = new Date(that[k]);
            }
        });
    };

    Visitor.beforeValidation = function(next){
        if (! this.ipv) this.setIpv();
        next();
    };

    /**
     * Returns an object of property definitions 
     * 
     * @function
     * @return {object} 
     */
    Visitor.getPropsDefs = function(){
        return visitorProps;
    };


    // TODO: get rid of these cloneDeep()'s and use Object.defineProperty to make them immutable
    Visitor.getStatuses = function(){
        return lo.cloneDeep(visitorStatus);
    }; 

    // Request
    var requestProps = { 
        // id: { type: schema.Integer}, caminte creates this column automatically
        visitor_id: { type: schema.Integer, 'null': false},
        method: {type: schema.String, limit: 10, 'null': true},
        protocol: {type: schema.String, limit: 10, 'null': true},
        hostname: {type: schema.String, limit: 2000, 'null': true},
        path: {type: schema.String, limit: 2000, 'null': true},
        query: {type: schema.JSON, limit: 2000, 'null': true},
        headers: { type: schema.JSON, 'null': true},
        requested: {type: schema.Date, default: Date.now, 'null': false},
        created: {type: schema.Date, default: Date.now, 'null': false}
    },
    requestIdx = { 
        // primaryKeys: ['id'], caminte does this automatically
        indexes: {
            visitor_id:{ 
                columns: 'visitor_id'
            },
            requested: { 
                columns: 'requested'
            }
        }
    },
    Request = schema.define('request', requestProps, requestIdx); 

    // Request validation
    Request.validatesNumericalityOf('visitor_id', {int: true});
    Request.validateAsync('requested', function(err, done){
            var that = this;
            process.nextTick(function () {
                if (! moment.isDate(that.requested)) err();
                done();
            });
        },
        {message: 'invalid request requested date'}
    );

    var Payment = require('./payment')({schema: schema, Visitor: Visitor});

    // relationships
    Visitor.hasMany(Request, {as: 'requests', foreignKey: 'visitor_id'});
    Request.belongsTo(Visitor, {as: 'visitor', foreignKey: 'visitor_id'});
    Payment.belongsTo(Visitor, {as: 'visitor', foreignKey: 'visitor_id'});

    /**
     * Resolves once the client is connected to db and the schema is initialized. 
     * Call this before doing anything on the db.
     *
     * @return {object}     promise object, resolves once connected and schema initialized 
     */
    schema.onConnected = function(){
        var that = this;

        return Q().then(function(){
            if (that.connError) return Q.reject(that.connError);

            if (that.connected) return; 
            var def = Q.defer();
            that.on('connected', function(){
                return def.resolve();
            });
            return def.promise;
        })
        .then(function(){
            // TODO: set client in each model dynamically
            if (opt.dbConfig.driver === 'sqlite3'){
                // set busyTimeout
                if (util.isPositiveIntegerOrZero(opt.dbConfig.busyTimeout) && 
                    typeof(that.client.configure) === 'function'){
                    that.client.configure('busyTimeout', parseInt(opt.dbConfig.busyTimeout));
                }

                // add support for sqlite3 async transactions
                that.client = new sqlite3trx(that.client); 
                Payment.schema.adapter.client = that.client;
                Visitor.schema.adapter.client = that.client;
                Request.schema.adapter.client = that.client;
                Meta.schema.adapter.client = that.client;

                // try to set sqlite3 journal mode to Write-Ahead Logging, far faster
                return Q().then(function(){
                    var def = Q.defer();
                    that.client.run('PRAGMA journal_mode = WAL', function(err, r){
                        if (err) return def.reject(err);
                        return def.resolve();
                    });
                    return def.promise;
                })
                // only recreate schema if any tables are missing
                // TODO: move into a transaction
                .then(function(){
                    // caminte autodates for in memory databases already
                    if (that._autoupdated || that.settings && that.settings.database === ':memory:') return;

                    var p = Q.resolve(),
                        autoupdate = false;

                    // TODO: dont loop over models, just query '.table' and compare

                    Object.keys(that.models).forEach(function(model) {
                        p = p.then(function(){
                            if (autoupdate) return;

                            var sql = 'PRAGMA TABLE_INFO(' + that.adapter.tableEscaped(model) + ')'; 
                            return Q.ninvoke(that.adapter, 'queryAll', sql);
                        })
                        .then(function(rows){
                            if (autoupdate) return; 
                            if (! rows || ! rows.length) autoupdate = true;
                        })
                    });

                    return p.then(function(){
                        if (! autoupdate) return;
                        return Q.ninvoke(that, 'autoupdate')
                        .then(function(){
                            that._autoupdated = true;
                        });
                    })
                })
            }
        });
    };

    /**
     * DBINCOMPAT
     *
     * For use with sqlite3 async transactions. Use after a beginTransaction call.
     * Creates a fully functional clone of a caminte model with a new database client object.
     * This is necessary for async sqlite3 transactions because they  require their own database client/wrapper
     * so that other async queries executed by the original model aren't interspersed with the transaction's queries.
     * And we need to clone the original model so that it's own database client isn't altered. 
     * 
     * @param {object} model        model class 
     * @param {object} client       new sqlite3 transactional db client 
     * @return {object}             cloned model class 
     */
    schema.cloneModelForTransaction = function(model, client){
        var modelclone = function(){
            model.apply(this, arguments);
        }
        lo.merge(modelclone, lo.cloneDeep(model));
        modelclone.prototype = new model();
        modelclone.prototype.constructor = modelclone; //function(){};
        lo.merge(modelclone.prototype.constructor, lo.cloneDeep(model.prototype.constructor));

        // caminte model's hidden immutable properties.  such fun.
        lo.forEach(['schema', 'modelName', 'cache', 'mru', 'relations'], function(k){
            modelclone[k] = lo.cloneDeep(model[k]);
            modelclone.prototype.constructor[k] = lo.cloneDeep(model.prototype.constructor[k]);
        });

        modelclone.schema.adapter.client = client;
        modelclone.prototype.constructor.schema.adapter.client = client;

        return modelclone;
    }

    /**
     * DBINCOMPAT
     *
     * For use with sqlite3 async transactions. Use after a beginTransaction call.
     * Creates a fully functional clone of a caminte model instance with a new database client object.
     * This is necessary for async sqlite3 transactions because they  require their own database client/wrapper
     * so that other async queries executed by the original model aren't interspersed with the transaction's queries.
     * And we need to clone the original model so that the original database client isn't altered.
     * 
     * @param {object} instance         instance to clone 
     * @param {object} model            model class 
     * @param {object} client           new sqlite3 transactional db client 
     * @return {object}                 cloned instance 
     */
    schema.cloneInstanceForTransaction = function(instance, model, client){
        var model2 = schema.cloneModelForTransaction(model, client),
            instance2 = new model2(instance.toObject());

        return instance2;
    }

    /**
     * Sets the ipv property with passed value, otherwise determines and sets it based on the ip property. 
     * 
     * @param {number} [ipv]    4 or 6, otherwise determined automatically 
     */
    Visitor.prototype.setIpv = function(ipv){
        if (lo.includes(ipvs, ipv)){
            this.ipv = ipv; 
            return;
        }
        if (validator.isIP(this.ip, 4)){
            this.ipv = 4;
            return;
        }
        if (validator.isIP(this.ip, 6)){
            this.ipv = 6;
            return;
        }

        throw Error('Failed to determine ipv from ip: ' + this.ip);
    };

    /**
     * Gives the visitor a particular status 
     *
     * @param {integer|null} statusid    new status to set. null to remove existing status.
     * @param {object} [opt]            object of options 
     * @param {Date} [opt.until]        date object of when the status expires, or # of milliseconds from
     *                                  now to expire status. default = null (never)
     * @param {string} [opt.reason]     string reason
     */
    Visitor.prototype.setStatusId = function(statusid, opt){
        opt = opt || {};

        lo.defaults(opt,{
            until: null,
            reason: null
        });
        this.status_id = statusid; 
        this.status_set = moment.utc().toDate(); 
        this.status_reason = opt.reason;
        if (opt.until){
            if(! (opt.until instanceof Date)){
                opt.until = moment.utc().add(parseInt(opt.until), 'milliseconds').toDate();
            }
        }
        else opt.until = null;
        this.status_expires = opt.until;
    };

    /**
     * Returns the visitor's status_id with respect to it's status_expires timestamp 
     * 
     * @function
     * @return {string|null} 
     */
    Visitor.prototype.getStatusId = function(){
        return this.hasStatusExpired() ? null : this.status_id;
    }

    /**
     * Determines if the visitor's current status has expired 
     * 
     * @return {boolean}
     */
    Visitor.prototype.hasStatusExpired = function(){
        if (this.status_expires && 
            moment.isDate(this.status_expires) &&
            (moment.utc().isAfter(moment(this.status_expires).utc()))){
            return true;
        }
        return false;
    }

    /**
     * Gets a visitor's pending payment record, or optionally creates one if it doesn't exist.
     * Uses a transaction to ensure there is only 1 payment record with the same
     * method + network + status_id = PENDING per visitor.
     * 
     * @param {object} opt
     * @param {number} opt.method_id    integer payment method id
     * @param {number} opt.network_id   integer network_id
     * @param {boolean} [opt.create]    flag to create a new pending payment if one does not currently exist, 
     *                                  default = true
     * @param {object} [opt.paymentProps] properties for the new payment object. don't include the amount_owed value,
     *                                  pass it separately in the amountOwed option
     * @param {string|number} [opt.amountOwed] decimal value to be set and converted to an integer in the new
     * @param {number} [opt.deriveIndexStart] starting index for bip32 address generation
     * @param {bool} [opt.reuseExpiredPayment] reuse an expired payment address if possible
     *                                  payment object's amount_owed property. 
     * @return {object}                 promise object, resolves with payment object 
     */
    Visitor.prototype.getPendingPayment = function(opt){
        var that = this,
            ps;

        opt = opt || {};
        lo.defaults(opt, {
            create: true,
            method_id: undefined, 
            network_id: undefined,
            deriveIndexStart: undefined,
            reuseExpiredPayment: false,
            paymentProps: {}
        });

        if (! that.id) return Q.reject(new Error("Can't get pending payment for visitor object that has no id"));

        ps = Payment.getStatuses(); 
        var pay;

        return Q.ninvoke(schema.client, 'beginTransaction')
        .then(function(trx){

            // clone Payment to use the transactional client without other async queries interferring
            var Payment2 = schema.cloneModelForTransaction(Payment, trx);
            return Q.ninvoke(Payment2, 'find', {
                where: {
                    visitor_id: that.id,
                    method_id: opt.method_id,
                    network_id: opt.network_id,
                    status_id: ps.PENDING
                },
                limit: 1,
                order: 'created DESC'
            })
            .then(function(r){
                // already exists, or don't create
                if (r && r[0]){
                    pay = r[0];
                }
                if (pay || ! opt.create) return pay;

                lo.merge(opt.paymentProps, {
                    visitor_id: that.id,
                    status_id: ps.PENDING,
                    amount_rcvd: 0
                });

                opt.paymentProps.method_id = opt.paymentProps.method_id || opt.method_id;

                var pay2 = new Payment2(opt.paymentProps),
                    p = Q.resolve();
                pay2.setAmountFromDecimal(opt.amountOwed, 'amount_owed');

                // calling reuseExpiredPayment/generateAddress manually manually so we can validate 
                // payment object prior to saving
                // TODO: doesn't pay.save already auto validate?  seems like next 20 lines could be nix'd
                if (opt.reuseExpiredPayment){
                    p = p.then(function(){
                        return pay2.reuseExpired();
                    });
                }

                return p.then(function(){
                    if (! pay2.address){
                        return pay2.generateAddress({
                            deriveIndexStart: opt.deriveIndexStart
                        });
                    }
                })
                // validate
                .then(function(){
                    var def = Q.defer();
                    pay2.isValid(function(valid){
                        return valid ? def.resolve() : def.reject(
                            new Error("Payment validation errors: " + JSON.stringify(pay2.errors))
                        );
                    });
                    return def.promise;
                })
                // save
                .then(function(){
                    var def = Q.defer();
                    pay2.save({trx: trx, generateAddress: false, reuseExpiredPayment: false}, function(err, p){
                        if (err) return def.reject(err); 
                        pay = p;
                        def.resolve();
                    });
                    return def.promise; 
                });
            })
            .then(function(){
                return Q.ninvoke(trx, 'commit');
            })
            .then(function(){
                // switch payment instance back to regular payment instance
                if (typeof(pay) === 'object' && (pay instanceof Payment2)){
                    pay = new Payment(pay.toObject());
                }

                return Q.resolve(pay);
            })
            .fail(function(err){
                var def = Q.defer();
                trx.rollback(function(e){
                    def.reject(err);
                });
                return def.promise;
            });
        });
    }

    /**
     * Parses an express request and sets property values 
     * 
     * @param {object} req          express request object 
     */
    Request.prototype.fromExpressRequest = function(req, opt){
        opt = opt || {};
        lo.defaults(opt, {
            headers: ['user-agent']
        });

        this.method = req.method; 
        this.protocol = req.protocol; 
        this.hostname = req.get('host');
        this.path = req.path;
        this.query = req.query;
        this.headers = opt.headers && (opt.headers instanceof Array) && opt.headers.length ? 
            lo.pick(req.headers, opt.headers) : lo.cloneDeep(req.headers);
        this.normalize();
    }

    /**
     * Returns an object of property definitions 
     * 
     * @function
     * @return {object} 
     */
    Request.getPropsDefs = function(){
       return requestProps;
    }

    Request.afterInitialize = function(){
        var that = this;

        // convert date milliseconds -> date objects
        lo.forOwn(Request.getPropsDefs(), function(prop, k){
            if (prop.type && 
                prop.type.toString().indexOf('function Date()') === 0 &&
                (typeof(that[k]) === 'string' || typeof(that[k]) === 'number')){
                that[k] = new Date(that[k]); 
            }
        });
    };

    /**
     * Normalizes current property values. 
     * 
     * @return {void}
     */
    Request.prototype.normalize = function(){
        var props = Request.getPropsDefs(),
            that = this;

        lo.forOwn(props, function(def, k){
            // nullify
            if (typeof(that[k]) === 'undefined' || that[k] === false || that[k] === null){
                that[k] = null;
                return;
            }

            switch(k){
                case 'method':
                case 'protocol':
                case 'hostname':
                    if (typeof(that[k]) === 'string') that[k] = that[k].toLowerCase();
                    break;

                case 'query':
                case 'headers':
                    if (typeof(that[k]) === 'object' && ! Object.keys(that[k]).length) that[k] = null;
                    break;

                default:
                    // omitted intentionally 
                    break;
            } 
        });
    }

    /**
     * Gets the request's user agent string. 
     * 
     * @return {string|null} 
     */
    Request.prototype.getUserAgent = function(){
        return this.headers && ('user-agent' in this.headers) ? this.headers['user-agent'] : '';
    }

    Request.prototype.getUrl = function(){
        return Url.format({
            protocol: this.protocol,
            hostname: this.hostname,
            pathname: this.path,
            query: this.query
        });
    }

    return {
        Schema: schema,
        Visitor: Visitor,
        Request: Request,
        Payment: Payment,
        Meta: Meta
    };
}
