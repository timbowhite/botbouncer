'use strict';

var Q = require('q'),
    lo = require('lodash'),
    moment = require('moment'),
    bitcorelib = require('bitcore-lib'),
    BigNumber = require('bignumber.js'),
    request = require('request'),
    qs = require('querystring'),
    util = require('./utility'),
    schema,
    Visitor, 
    initPayment = function(){
        var addressMethod = {   // how addresses are generated
            HDPUBKEY: 1,    // derived from BIP32 HD public key
            GENPRIVKEY: 2   // TODO
        },
        paymentStatus = {
            SETTLED: 1,     // confirmed full payment
            PENDING: 2,     // waiting for a (full) payment to be made + confirmed
            EXPIRED: 3      // no or partial payment made, and expires date has passed
        },
        paymentMethod = {
            BITCOIN: {
                id: 1,
                decimals: 8,
                currencyCode: 'BTC',
                network: {
                    LIVENET: 1,
                    TESTNET: 2
                },
                service: 'blockr-btc'
            }
        },
        service = {
            'blockr-btc':{
                baseUrl: {
                    1: 'http://btc.blockr.io/api/v1/',  // livenet
                    2: 'http://tbtc.blockr.io/api/v1/', // testnet 
                },
                address:{
                    info: 'address/info/',
                    maxAddressCount: 20 // blockr.io API address lookup limit
                }
            }
        },
        qrCode = {
            baseUrl: 'https://chart.googleapis.com/chart?cht=qr&chs=300x300&chld=L|2&chl='
        },
        paymentProps = {
            // id: { type: schema.Integer}, caminte creates this column automatically
            visitor_id: { type: schema.Integer, 'null': false},
            method_id: {type: schema.Integer, 'null': false},               // payment method
            status_id: { type: schema.Integer, default: paymentStatus.PENDING}, // payment status
            address: {type: schema.String, limit: 255, 'null': false},  // payment receiving endpoint
            address_method_id: {type: schema.Integer, 'null': false},       // method for generating new address
            amount_owed: {type: schema.Integer, 'null': false, money: true}, // integer units
            amount_rcvd: {type: schema.Integer, 'null': false, money: true}, // integer units
            hdpubkey: {type: schema.String, limit: 111, 'null': true},  // master public key
            derive_index: {type: schema.Integer, 'null': true},         // hdpubkey address index
            network_id: {type: schema.Integer, 'null': false},               // testnet/livenet
            detail: { type: schema.JSON, 'null': false},                // additional payment data
            expires: {type: schema.Date, default: null, 'null': true},  // when to stop monitoring for payments
            created: {type: schema.Date, default: Date.now, 'null': false},
            updated: {type: schema.Date, default: null, 'null': true}
        },
        paymentIdx = {
            // primaryKeys: ['id'], caminte does this automatically
            indexes: {
                visitor_id:{
                    columns: 'visitor_id'
                },
                method_id_address: {
                    columns: 'method_id address',
                    unique: true
                },
                bip32: {
                    columns: 'network_id hdpubkey derive_index'
                },
                status_id:{
                    columns: 'status_id'
                },
                created: {
                    columns: 'created'
                },
                expires: {
                    columns: 'expires'
                }
            }
        },
        Payment = schema.define('payment', paymentProps, paymentIdx),
        paymentMethodFlat = {},     // names => id's 
        networkFlat = {},           // names => network names => constants
        BN = {};                    // id's => BN objects

        // init bignumber constructors, flatten payment stuff 
        lo.forOwn(paymentMethod, function(v, k){
            paymentMethodFlat[k] = v.id;
            networkFlat[k] = v.network;
            BN[v.id] = BigNumber.another({ DECIMAL_PLACES: v.decimals }); 
        });

        // hooks
        Payment.afterInitialize = function(data){
            var that = this;

            // convert date milliseconds -> date objects
            lo.forOwn(Payment.getPropsDefs(), function(prop, k){
                if (prop.type &&
                    prop.type.toString().indexOf('function Date()') === 0 &&
                    (typeof(that[k]) === 'string' || typeof(that[k]) === 'number')){
                    that[k] = new Date(that[k]);
                }
            });

            // ensure detail prop is an object
            that.setDetail();
        };

        Payment.beforeValidation = function(next){
            // set default derive_index
            if (this.address_method_id === addressMethod.HDPUBKEY &&
                (this.derive_index === null || typeof(this.derive_index) === 'undefined')){  
                this.derive_index = 0;
            }

            next();
        };

        // Payment validation
        Payment.validatesNumericalityOf('visitor_id', {int: true});

        Payment.validateAsync('method_id', function(err, done){
                var that = this;
                process.nextTick(function () {
                    var ids = [];
                    lo.forOwn(paymentMethod, function(v, k){
                        ids.push(v.id);
                    });
                    if (typeof(that.method_id) !== 'undefined' && 
                        that.method_id !== null && 
                        ! lo.includes(ids, that.method_id)){
                        err();
                    }
                    done();
                });
            },  
            {message: 'invalid payment method_id'}
        );

        Payment.validateAsync('status_id', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (! lo.includes(lo.values(paymentStatus), that.status_id)){
                        err();
                    }
                    done();
                });
            },
            {message: 'invalid payment status_id'}
        );

        Payment.validateAsync('address', function(err, done){
                var that = this;
                process.nextTick(function () {
                    var error = true;

                    switch(that.method_id){
                        case paymentMethod.BITCOIN.id:
                            var networkName = Payment.getNetworkName({
                                paymentMethodId: that.method_id,
                                networkId: that.network_id
                            });
                            if (bitcorelib.Address.isValid(that.address, networkName)){
                                error = false;
                            }
                            break;

                        default:
                            // intentionally empty 
                            break;
                    }

                    if (error) err();
                    done();
                });
            },  
            {message: 'invalid address'}
        );

        Payment.validateAsync('address_method_id', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (! lo.includes(lo.values(addressMethod), that.address_method_id)){
                        err();
                    }
                    done();
                });
            },
            {message: 'invalid payment address_method_id'}
        );

        Payment.validateAsync('amount_owed', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (! util.isPositiveInteger(that.amount_owed)){
                        err();
                    }
                    done();
                }); 
            },  
            {message: 'invalid amount_owed'}
        );

        Payment.validateAsync('amount_rcvd', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (! util.isPositiveIntegerOrZero(that.amount_rcvd)){
                        err();
                    }   
                    done();
                }); 
            },  
            {message: 'invalid amount_rcvd'}
        );

        Payment.validateAsync('derive_index', function(err, done){
                var that = this;
                process.nextTick(function () {
                    var error = false;
                    if (that.address_method_id === addressMethod.HDPUBKEY){
                        try{
                            var hdpk = bitcorelib.HDPublicKey(that.hdpubkey);
                        }
                        catch(e){
                            error = true;
                        }
                    } 
                    else if (that.hdpubkey !== null && typeof(that.hdpubkey) !== 'undefined'){
                        error = true; 
                    }
                    if (error) err();
                    done();
                });
            },
            {message: 'invalid hdpubkey'}
        );

        Payment.validateAsync('derive_index', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if ((that.address_method_id === addressMethod.HDPUBKEY &&
                        !  util.isPositiveIntegerOrZero(that.derive_index)) ||
                        (that.address_method_id !== addressMethod.HDPUBKEY &&
                        that.derive_index !== null && typeof(that.derive_index) !== 'undefined')){ 
                        err();
                    }
                    done();
                });
            },
            {message: 'invalid derive_index'}
        );
        

        Payment.validateAsync('network_id', function(err, done){
                var that = this;
                process.nextTick(function () {
                    var error = true;

                    switch(that.method_id){
                        case paymentMethod.BITCOIN.id:
                                var pm = lo.findKey(paymentMethod, {id: that.method_id});

                                if (networkFlat[pm] &&
                                    lo.includes(lo.values(networkFlat[pm]), that.network_id)){
                                    error = false;
                                }
                            break;

                        default:
                            // intentionally empty 
                            break;
                    }

                    if (error) err();
                    done();
                });
            },
            {message: 'invalid network_id'}
        );

        Payment.validateAsync('detail', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (that.detail !== null && ! lo.includes(['undefined' ,'object'], typeof(that.detail))){
                        err();
                    }   
                    done();
                }); 
            },  
            {message: 'invalid payment detail'}
        );

        Payment.validateAsync('expires', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (that.expires !== null && ! moment.isDate(that.expires)) err();
                    done();
                });
            },  
            {message: 'invalid expires date'}
        );

        Payment.validateAsync('created', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (! moment.isDate(that.created)) err();
                    done();
                });
            },  
            {message: 'invalid created date'}
        );

        Payment.validateAsync('updated', function(err, done){
                var that = this;
                process.nextTick(function () {
                    if (that.updated !== null && ! moment.isDate(that.updated)) err();
                    done();
                });
            },  
            {message: 'invalid updated date'}
        );

        // TODO: get rid of these cloneDeep()'s and use Object.defineProperty to make them immutable
        Payment.getStatuses = function(){
            return lo.cloneDeep(paymentStatus);
        };

        Payment.getPaymentMethods = function(){
            return lo.cloneDeep(paymentMethodFlat);
        };

        Payment.getServices = function(){
            return lo.cloneDeep(service);
        };

        Payment.getAddressMethods = function(){
            return lo.cloneDeep(addressMethod);
        };

        Payment.getNetworks = function(){
            return lo.cloneDeep(networkFlat);
        }

        Payment.getPaymentMethodById = function(id){
            return lo.find(paymentMethod, {id: id});
        }

        /**
         * Returns the network string name given a payment method id and network id 
         * 
         * @param {object} opt                      object of options
         * @param {number} opt.paymentMethodId      
         * @param {number} opt.networkId
         * @throws
         * @return {string}
         */
        Payment.getNetworkName = function(opt){
            opt = opt || {};
            lo.defaults(opt, {
                paymentMethodId: undefined,
                networkId: undefined
            });
            if (! util.isPositiveInteger(opt.paymentMethodId)) 
                throw new Error('invalid paymentMethodId option: ' + opt.paymentMethodId); 
            opt.paymentMethodId = parseInt(opt.paymentMethodId);

            if (! util.isPositiveInteger(opt.networkId)) 
                throw new Error('invalid networkId option: ' + opt.networkId); 
            opt.networkId = parseInt(opt.networkId);

            var pm = lo.find(paymentMethod,  {id: opt.paymentMethodId});
            if (! pm || ! pm.network) return;
            var network = lo.findKey(pm.network, function(x){ return x === opt.networkId; });

            return typeof(network) === 'string' ? network.toLowerCase() : undefined; 
        }
        
        /**
         * Returns an object of property definitions 
         * 
         * @function
         * @return {object} 
         */
        Payment.getPropsDefs = function(){
           return paymentProps;
        }

        /**
         * Sets payments' status_id to EXPIRED in the db whose expires date has passed 
         * 
         * @return {object}         promise object
         */
        Payment.expirePayments = function(){
            return Q().then(function(){
                var now = moment.utc().toDate(),
                    def = Q.defer();

                Payment.update({
                        status_id: paymentStatus.PENDING,
                        expires: {
                            lte: now
                        }
                    },{
                        status_id: paymentStatus.EXPIRED,
                        updated: now 
                    }, 
                    function(err){
                    if (err) return def.reject(err);
                    def.resolve();
                });
                return def.promise;
            });
        }

        /**
         * Returns a BigNumber object representation of the passed val 
         * 
         * @param {number|string} val 
         * @param {object} [opt]            object of options 
         * @param {bool} [opt.shift]        flag to right shift the value the appropriate decimal places
         *                                  (ie. convert integer -> decimal).
         *                                  pass true if val came from instance or the db. default = false
         * @return {object}                 BigNumber object 
         */
        Payment.prototype.toBigNumber = function(val, opt){
            opt = opt || {};
            lo.defaults(opt, {shift: false});
            if (! (this.method_id in BN)) 
                throw new Error('method_id ' + this.method_id + ' has no defined BigNumber constructor');

            var bn = new BN[this.method_id](String(val));
            if (opt.shift) bn = bn.shift(-1 * BN[this.method_id].config().DECIMAL_PLACES);
            return bn; 
        };

        /**
         * Returns a string representation of a BigNumber object
         * 
         * @param {object} bn               BigNumber object 
         * @param {object} [opt]            object of options 
         * @param {bool} [opt.shift]        flag to left shift the value the appropriate decimal places
         *                                  (ie. convert decimal -> integer)
         *                                  pass true if val is going to be set in the instance or
         *                                  saved to db. default = false
         * @return {string}
         */
        Payment.prototype.fromBigNumber = function(bn, opt){
            opt = opt || {};
            lo.defaults(opt, {shift: false});
            var decs = BN[this.method_id].config().DECIMAL_PLACES;
            if (! (this.method_id in BN)) 
                throw new Error('method_id ' + this.method_id + ' has no defined BigNumber constructor');

            if (opt.shift) bn = bn.shift(decs);
            return bn.toFixed();
        };

        /**
         * Converts a decimal monetary amount (ie 9.99) to an
         * integer monetary amount (ie. 999) and sets it in the supplied property based on the
         * instance's payment method's decimal count.
         * 
         * @param {number} val
         * @param {string} prop     property to set (ie. 'amount_owed' or 'amount_rcvd') 
         * @param {object} opt
         * @param {boolean} opt.reverse reverse functionality: change integer to decimal 
         */
        Payment.prototype.setAmountFromDecimal = function(val, prop, opt){
            opt = opt || {};
            lo.defaults(opt, {reverse: false});
            var props = Payment.getPropsDefs();
            if (! (prop in props) || ! (props[prop].money)){
                throw new Error(prop + ' is not a a defined monetary property');
            }

            this[prop] = this.fromBigNumber(this.toBigNumber(val, {shift: opt.reverse}), {shift: ! opt.reverse});
        }

        /**
         * Returns a scaled decimal version of an integer monetary amount propert value
         * 
         * @param {string} prop     property whose value to retrieve (ie. 'amount_owed' or 'amount_rcvd') 
         * @return {string} 
         */
        Payment.prototype.getAmountToDecimal = function(prop){
            var props = Payment.getPropsDefs();
            if (! (prop in props) || ! (props[prop].money)){
                throw new Error(prop + ' is not a a defined monetary property');
            }

            return this.fromBigNumber(this.toBigNumber(this[prop], {shift: true}), {shift: false});
        }

        /**
         * Queries an expired payment record's generated address and populates the payment object with the 
         * appropriate properties including id, address, derive_index. Basically hijacks an existing expired
         * payment record. NOTE: this will permanently alter the original expired payment record that belonged to
         * a potientally completely different visitor.
         *
         * NOTE: this should be run within a transaction so that the payment record can later be saved atomically.
         * Use schema.cloneInstanceForTransaction prior to calling this method, and afterwards save it. 
         * 
         * @return {object}                 promise object. Resolves with boolean: true if an appropriate expired 
         *                                  payment record was found and populated into the object, otherwise false
         */
        Payment.prototype.reuseExpired = function(){
            var that = this; 
            
            // get the earliest expired payment
            return Q.ninvoke(that.constructor, 'find', {
                where: {
                    method_id: that.method_id,
                    network_id: that.network_id,
                    status_id: paymentStatus.EXPIRED
                },
                limit: 1,
                order: 'created ASC'
            })
            .then(function(r){
                if (!r || ! r.length) return false;

                // only set specific properties
                var props = ['id', 'address', 'address_method_id', 'hdpubkey', 'derive_index', 'created'];
                lo.forEach(props, function(p){
                    that[p] = r[0][p];
                });

                return true;
            });
        }

        /**
         * Generates a new receiving address
         * 
         * @param {object} [opt] 
         * @param {object} [opt.set]            flag to set the new address at this.address (and if necessary, details
         *                                      such derive_index), default = true
         * @param {number} [opt.deriveIndexStart] starting index for hdpubkey address method_id used to derive addresses,
         *                                      default = 0. If existing generated addresses exist and checkDb = true,
         *                                      the derive index is automatically set to the last index + 1
         * @param {number} [opt.networkId]      network id. default = this.network_id
         * @param {string} [opt.hdpubkey]            master public key base58 encoded. default = this.hdpubkey
         * @param {boolean} [opt.checkDb]       check for existing addresses for the hdpubkey in the database and use 
         *                                      that last index + 1 if they exist, default = true
         * @return {object}                     promise object, resolves with new address
         */
        Payment.prototype.generateAddress = function(opt){
            opt = opt || {};
            lo.defaults(opt, {
                set: true,
                deriveIndexStart: 0, 
                checkDb: true, 
                networkId: undefined,
                hdpubkey: undefined 
            });

            if (! lo.includes(lo.values(paymentMethodFlat), this.method_id) ||
                ! lo.includes(lo.values(addressMethod), this.address_method_id)){
                throw new Error('invalid method_id or address_method_id');
            }

            var that = this, addy, dindex = opt.deriveIndexStart, p = Q.resolve();

            switch(that.method_id){
                case paymentMethodFlat.BITCOIN:
                default:
                    switch(that.address_method_id){
                        case addressMethod.HDPUBKEY:
                            if (! opt.hdpubkey) opt.hdpubkey = that.hdpubkey;
                            if (! opt.networkId) opt.networkId = that.network_id;

                            // get last index. if none, use opt.index.
                            p = p.then(function(){
                                if (! opt.checkDb) return;

                                return Q.ninvoke(that.constructor, 'find', {
                                    where: {
                                        method_id: that.method_id, 
                                        address_method_id: that.address_method_id,
                                        hdpubkey: opt.hdpubkey,
                                        network_id: opt.networkId
                                    },
                                    limit: 1,
                                    order: 'derive_index DESC'
                                })
                                .then(function(r){
                                    if (!r || ! r.length || ! util.isInteger(r[0].derive_index)) return; 
                                    dindex = r[0].derive_index + 1;
                                });
                            })
                            .then(function(){
                                var hdpubkey = bitcorelib.HDPublicKey(opt.hdpubkey),
                                    pubkey = hdpubkey.derive(0).derive(dindex).toObject().publicKey,
                                    networkName = that.constructor.getNetworkName({
                                        paymentMethodId: that.method_id,
                                        networkId: opt.networkId
                                    });

                                addy = new bitcorelib.PublicKey(pubkey).toAddress(networkName).toString();
                                if (opt.set){
                                    that.derive_index = dindex;
                                    that.network_id = opt.networkId;
                                    that.hdpubkey = opt.hdpubkey;
                                }
                            });
                            break;

                        case addressMethod.GENPRIVKEY:
                            // TODO 
                            break;

                    }
                    break;
            }

            return p.then(function(){
                if (addy && opt.set) that.address = addy;
                return addy;
            });
        }

        /**
         * Merges the passed object in to the detail object 
         * 
         * @param {object} [data] 
         */
        Payment.prototype.setDetail = function(data){
            var that = this;
            if (typeof(that.detail) !== 'object' || that.detail === null) that.detail = {}; 
            data = data || {};
            lo.merge(that.detail, data);
        }

        /**
         * Determines if this.amount_rcvd >= this.amount_owed
         * 
         * @return {boolean}
         */
        Payment.prototype.isPaid = function(){
            if (! util.isNumeric(this.amount_owed) || ! util.isNumeric(this.amount_rcvd)) return false;

            var owed = this.toBigNumber(this.amount_owed, {shift: true}), 
                rcvd = this.toBigNumber(this.amount_rcvd, {shift: true});
            
            return owed.gt(0) && rcvd.gte(owed); 
        }

        /**
         * Determines if this.amount_rcvd >= 0 
         * 
         * @return {boolean}
         */
        Payment.prototype.isPaidPartial = function(){
            if (! util.isNumeric(this.amount_owed) || ! util.isNumeric(this.amount_rcvd)) return false;

            var rcvd = this.toBigNumber(this.amount_rcvd, {shift: true});
            
            return rcvd.gt(0); 
        }

        /**
         * Generates a QR code URL for the payment 
         * 
         * @throws
         * @return {string} 
         */
        Payment.prototype.getQrCodeUrl = function(){
            var that = this;
            switch(that.method_id){
                case paymentMethod.BITCOIN.id:
                    var uri = new bitcorelib.URI({
                        address: that.address, 
                        amount : that.amount_owed 
                    });

                    return qrCode.baseUrl + qs.escape(uri.toString()); 
                    break;

                default:
                    throw new Error('Payment method_id ' + that.method + ' does not support QR codes');
                    break;
            }
        }

        /**
            save. adds some extra functionality for new payment records that need an address:

            1. Prevents race condition for bip32 derived addresses. Addresses may be generated
               async using the last known derivedIndex in the db, resulting in non-unique addresses.
               so if an insert/update fails due to unique key constraint 
               (ie. the address already exists in the db), regenerate a new address and retry the save X times
         * 
         * @param {object} opt                      object of options
         * @param {boolean} opt.reuseExpiredPayment flag to first try to reuse an already expired address if the
         *                                          object has no address, default is false
         * @param {boolean} opt.generateAddress     flag to generate an address if no address exists for object, 
         *                                          default is true
         * @param {boolean} [opt.trx]               optional: flag already in a transaction and the instance has 
         *                                          already been cloned for a transaction
         * @param {function} cb 
         */
        Payment.prototype._save_orig = Payment.prototype.save;
        Payment.prototype.save = function(opt, cb){
            var that = this,
                p = Q.resolve(),
                trx;

            if (typeof(opt) === 'function'){
                cb = opt;
                opt = {};
            }
            opt = opt || {};
            lo.defaults(opt, {
                reuseExpiredPayment: false,
                generateAddress: true, 
                trx: undefined
            });

            // DBINCOMPAT
            // begin transaction, if necessary
            if (! opt.trx){
                p = p.then(function(){
                    return Q.ninvoke(schema.client, 'beginTransaction')
                    .then(function(t){
                        trx = t; 
                        that = schema.cloneInstanceForTransaction(that, Payment, trx);
                    });
                });
            }

            // reuse old address?
            return p.then(function(){
                if (! that.address && opt.reuseExpiredPayment){
                    return that.reuseExpired();
                }
            })
            // get new address?
            .then(function(){
                if (! that.address && opt.generateAddress && that.address_method_id === addressMethod.HDPUBKEY){
                    return that.generateAddress({set: true});
                }
            })
            // save
            .then(function(){
                return Q.ninvoke(that, '_save_orig', opt);
            })
            // commit if necessary
            .then(function(inst){
                if (trx){
                    return Q.ninvoke(trx, 'commit')
                    .then(function(){
                        // switch payment instance back to regular payment instance
                        that = new Payment(inst.toObject());
                    });
                }
            })
            // done
            .then(function(){
                return cb(null, that);
            })
            // rollback, if necessary
            .fail(function(err){
                if (! trx) return cb(err, that);

                var def = Q.defer();
                try{
                    trx.rollback(function(e){
                        cb(err, that);
                        def.reject(err);
                    });
                }
                catch(e){
                    def.reject(e);
                }
                return def.promise;
            });
        }

        return Payment;
    };

module.exports = function (opt){
    schema = opt.schema;
    Visitor = opt.Visitor;
    return initPayment(); 
};
