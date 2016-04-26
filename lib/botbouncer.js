'use strict';

var DB_VERSION = 1,
    fs = require('fs'),
    dnscache = require('dnscache')({enable: true}), 
    lo = require('lodash'),
    Q = require('q'),
    ipaddr = require('ipaddr.js'),
    moment = require('moment'),
    events = require('events'),
    ejs = require('ejs'),
    Url = require('url'), 
    util = require('./utility'),
    httpRequest = require('request'),
    filesize = require('filesize'),
    Table = require('cli-table2'),
    Detectors = {
        'ua-bot': require('./detectors/ua-bot'),
        'ua-impostor': require('./detectors/ua-impostor'),
        'ua-version': require('./detectors/ua-version'),
        'ua-switching': require('./detectors/ua-switching'),
        'rate-limit': require('./detectors/rate-limit'),
    };
    lo.mergeDefaults = require('merge-defaults');
   
var BotBouncer = function(){
    var that = this,
        pruneint,                       // prune interval object
        cpint = {},                     // checkPayments interval objects, keyed by lc'd payment method name
        schema,
        Schema,
        Visitor, 
        Request,
        Payment,
        Meta,
        vs,                             // visitor statuses
        ps;                             // payment statuses

    that.emitter = new events.EventEmitter();
    that.opt = {};
    that.optDefault = {
        debug: false, 
        bounce:{
            enabled: true,              // flag to display the banned response for banned/blacklisted visitors.
                                        // disable for dry run: visitors will still be saved to db, but
                                        // bounce response won't be displayed, requests continue normally.
            contentType: 'text/html',
            statusCode: 402,
            body: {
                banned: __dirname + '/../content/en/body/banned-payment-request.txt', 
                blacklisted: __dirname + '/../content/en/body/banned-payment-request.txt', 
                shitlisted: __dirname + '/../content/en/body/shitlisted.txt', 
                                        // filepath or function to render the response message.
                                        // Function gets passed: req, res, visitor, done. done is a callback that 
                                        // must be passed the content to display.
            },
            adminEmail: undefined,      // email address to display in the payment request body text
        }, 
        includePath: [],                // array of strings/regexp to only work on. cant combine with excludePath.
        excludePath: [],                // array of strings/regexp to ignore. cant combine with includePath.
        whitelistIp:[                   // private+local hosts: https://en.wikipedia.org/wiki/Reserved_IP_addresses
            '10.0.0.0/8',               // NOTE: visitors with matching ip's are not stored in the DB
            '127.0.0.0/8',
            '100.64.0.0/10',
            '172.16.0.0/12',
            '192.0.0.0/24',
            '192.168.0.0/16',
            '198.18.0.0/15',
            // ipv6
            '::1/128',
            'fc00::/7'
        ],
        //blacklistIp: [],              // TODO: always bounce these ip's with a payment request
        //shitlistIp: [],               // TODO: like blacklist, except never accept payments from them, they
                                        // are always bounced
        allowedDuration: 30 * 86400 * 1000, // # of milliseconds an allowed user should stay allowed for.
                                        // Once the allowed status expires, the visitor will be detected again. 
                                        // default = 30 days, 0 to always allow indefinitely.
        banDuration: 30 * 86400 * 1000, // # of milliseconds a banned user should stay banned for.
                                        // Once the banned status expires, the visitor will be detected again.
                                        // default = 30 days, 0 to ban indefinitely.
        detectFrequency: 1000,          // only run the detectors after a visitor's request 
                                        // if it's been this many milliseconds since the visitor's last request,
                                        // or it's their first request, 0 to disable
        lookupHostname: true,           // flag to do a reverse dns lookup on the visitor's ip address
                                        // before the visitor record is saved to the database
        getIpMethod: null,              // how to get the IP address from the express request. 
                                        // if falsey, use req.ip
                                        // if string, use req.headers[string] (case insensitive)
                                        // if function, use function's return (passed request object)
        detectors:{
            'ua-bot': {
                enabled: true,
                order: 0, 
                allowOnPass: false,
                banOnFail: true,
                exclude: [
                    'google',
                    'bingbot', 
                    'yandex', 
                    'yahoo',
                    'baidu',
                    'uptimerobot'
                ]
            },
            'ua-version': {
                enabled: true,
                order: 1, 
                allowOnPass: false,
                banOnFail: true,
                version: {
                    'ie': '<=7.0.0',
                    'firefox': '<=30.0.0',
                    'chrome': '<=32.0.0',
                    'safari': '<=5.1.9'
                }
            },
            'ua-impostor': {
                enabled: true,
                order: 2, 
                allowOnPass: true,
                banOnFail: true
            },
            'ua-switching': {
                enabled: true,
                order: 3, 
                allowOnPass: false, 
                banOnFail: true,
                minRequests: 5,
                maxRequests: 20,
                timeframe: 5 * 60 * 1000
            },
            'rate-limit': {
                enabled: true,
                order: 4, 
                allowOnPass: false, 
                banOnFail: true,
                limit: [{
                    total: 50,
                    timeframe: 15 * 60 * 1000
                }]
            }
        },
        payment: {
            enabled: true,
            methods: ['bitcoin'],               // payment methods accepted. only bitcoin right now.
            allowedDuration: 30 * 86400 * 1000, // how long a settled payment unbans a visitor for
                                                // milliseconds, determine that its failed and reset 
            bitcoin: {
                addressMethod: 'hdpubkey',      // new address generation method:
                                                // hdpubkey (bip32 master private key)
                amount: .05,                    // payment request invoice amount
                //amountCurrency: 'BTC',          // TODO: currency conversion, ie USD -> BTC
                masterPublicKey: undefined,     // hdpubkey
                deriveIndexStart: 0,            // hdpubkey addressMethod: beginning index for hdpubkey address derivation
                network: 'livenet',             // livenet/testnet
                //address: undefined,             // genprivkey: TODO
                confirmations: 1,               // # of confirmations to consider payment settled, max = 15 b/c blockr
                expirePaymentsAfter: 3 * 86400 * 1000, // # of milliseconds to stop checking for a visitor's payment
                                                // and expire the payment record
                reuseExpiredPayment: false,     // use expired payment addresses if possible
                                                // instead of generating a new payment request
                requestOpt: {},                 // options to pass to the request module when making API calls.
                qrCode: true,                   // flag to display a payment QR code URL from
                                                // chart.googleapis.com in the payment request body text
                checkFrequency: 15 * 60 * 1000, // how often to check for settled payments, 0 to disable
                checkTimeout: 15 * 60 * 1000,   // if checkPayments lock has been on for longer that this many
                                                // milliseconds, consider it timed out and allow checkPayments to
                                                // run again
            }
        },
        prune:{                             // database pruning
            frequency: 86400 * 1000,        // how often, in milliseconds, to prune old records from the database
                                            // dont set this higher than 2147483647 (25 days). Set to 0 to disable
                                            // periodic automatic pruning.
            olderThan: 3 * 86400 * 1000,    // delete unneeded visitor records (and their related request records)
                                            // older than this many milliseconds, 0 to disable
            timeout: 5 * 60 * 1000,         // if prune lock has been on for longer than this many milliseconds,
                                            // determine that pruning failed/timed out and reset
            vacuum: true                    // for sqlite3, flag to compact database after pruning 
        },
        dbConfig: {
            driver: 'sqlite3',
            database: process.cwd() + '/botbouncer.db',
            busyTimeout: 3000
        },
        wipe: false                     // flag to wipe any existing db data
    };

    /**
     * Initialize botbouncer. Should be called prior to express setup. 
     * 
     * @function
     * @param {object} opt          options object 
     * @param {function} [cb]       callback function called when initialization complete. passed 1 error arg.
     *                              optional, can use the returned promise object instead.
     */
    that.init = function(opt, cb){
        var err = null,
            p = Q.resolve();

        opt = opt || {};
        lo.mergeDefaults(opt, this.optDefault); 

        // get sorted list of enabled detectors based on passed order values 
        opt.detectorsOrder = Object.keys(lo.pickBy(opt.detectors, function(v, k){
            return v.enabled;
        }))
        .sort(function(a,b){
            return opt.detectors[a].order - opt.detectors[b].order; 
        }); 

        this.opt = opt;

        try{
            schema = require('./schema')(this.opt);
            Schema = schema.Schema;
            Visitor = schema.Visitor;
            Request = schema.Request;
            Payment = schema.Payment;
            Meta = schema.Meta;
            vs = Visitor.getStatuses(); 
            ps = Payment.getStatuses();
        }   
        catch(e){
            p = Q.reject(e);
        }

        return p.then(function(){
            return Schema.onConnected();
        })
        .then(function(){
            if (opt.wipe) return that.wipe();
        })
        .then(function(){ return that.upgradeDb(); })
        .then(function(){
            that.initCheckPayments();
            that.initPruning();
            return Q.resolve();
        })
        // reject promise on error and pass error to callback
        .fail(function(e){
            err = e;
            return Q.reject(e);
        })
        .fin(function(){
            if (err) that.handleError(err);
            if (typeof(cb) === 'function') cb(err);
        });
    };
    /**
     * Sets the current db_version (if necessary) and upgrades db schema (if necessary) 
     * 
     * @return {object}     promise object
     */
    that.upgradeDb = function(){
        return Meta.getAndSet('db_version', function(version){
            if (! util.isPositiveInteger(version)) return DB_VERSION; 

            // handle upgrades here, set new version
            
            return; 
        }); 
    };
    /**
     * express middleware request handling function
     * 
     * @param {object} exreq        express request object 
     * @param {object} exres        express response object 
     * @param {function} next       express next function 
     * @return {object}             promise object 
     */
    that.handleRequest = function (exreq, exres, next) {
        var debugid = '[handleRequest]',
            abort = false,
            bounced = false,
            start = moment.utc(),
            ip = that.getIpFromExpressRequest(exreq);

        that.debug(debugid, 'start', ip);

        exreq._botbouncer = {};
        
        // check if path is excluded
        return Q().then(function(){
            if (abort) return;

            return that.shouldIgnorePath(exreq)
            .then(function(excluded){
                if (excluded) abort = true;
            });
        })
        // check if ip is whitelisted
        .then(function(){
            if (abort) return;

            return that.isIpWhitelisted(exreq)
            .then(function(r){
                if (r) abort = true; 
            });
        })
        // lookup visitor record, if any
        .then(function(){
            if (abort) return;

            var def = Q.defer(),
                start = moment.utc();

            Visitor.find({limit: 1, where: {ip: ip}}, function(err, r){
                that.debug(debugid, 'looked up visitor in ' + moment.utc().diff(start) + 'ms', ip);

                if (err) return def.reject(err);
                var visitor;
                if (r && r.length) visitor = r[0];
                def.resolve(visitor);
            })
            return def.promise;
        })
        // check visitor's existing status, act accordingly
        .then(function(visitor){
            if (abort) return;

            var detect = false,
                p = Q.resolve();

            if (visitor){
                // handle visitors status
                switch(visitor.getStatusId()){
                    case vs.BLACKLISTED:
                    case vs.BANNED:
                        if (that.opt.bounce.enabled){
                            bounced = true;
                            p = p.then(function(){ return that.bounce(exreq, exres, visitor); });
                        }
                        break;

                    case vs.WHITELISTED: 
                    case vs.ALLOWED: 
                        // still whitelisted, do nothing
                        break; 

                    case null:
                    default:
                        // unknown status or status expired
                        detect = true; 
                        break; 
                }
            } 
            else detect = true;

            // setup post response processing
            if (detect && exres){
                exreq._botbouncer.requested = moment.utc().toDate();
                exres.on('finish', that.postResponseProcess.bind(that, exreq, exres));
            }
            return p;
        })
        .fail(function(err){
            that.handleError(err);
            bounced = false; // allow the request to continue (see fin())
        })
        .fin(function(){
            that.debug(debugid, 'end (' + moment.utc().diff(start) + 'ms)', ip, bounced ? 'bounced' : '');
            if (! bounced) next();
        });
    };

    /**
     * Returns the request's ip address. 
     * 
     * @param {object} exreq            express request object 
     * @return {string}                  
     */
    that.getIpFromExpressRequest = function(exreq){
        if (! that.opt.getIpMethod) return exreq.ip;

        // function
        if (typeof(that.opt.getIpMethod) === 'function') return that.opt.getIpMethod(exreq);
    
        // header
        var ip;
        if (typeof(that.opt.getIpMethod) === 'string' &&
            (ip = exreq.header(that.opt.getIpMethod))){
            return ip;
        }

        // fallback
        return exreq.ip; 
    };
    /**
     * Determines if a visitor should be whitelisted based on the whitelistIp option 
     * 
     * @param {object} exreq    express request 
     * @return {object}         promise object, resolves with true if whitelisted, false if not whitelisted 
     */
    that.isIpWhitelisted = function(exreq){
        var reqip = that.getIpFromExpressRequest(exreq), 
            reqipp; // parsed reqip

        return Q().then(function(){
            var excluded = false;
            lo.forEach(that.opt.whitelistIp, function(exip){
                // cidr match? 
                if (exip.indexOf('/') !== -1){
                    if (! reqipp){
                        try{
                            reqipp = ipaddr.parse(reqip);
                        }
                        catch(e){
                            that.debug('failed to parse request ip: ' + reqip + ' because ' + (e.stack || e));
                            excluded = false;
                            return false; 
                        }
                    }
                    var exipSplit = exip.split('/', 2),
                        range = exipSplit[0],
                        subnet = exipSplit[1], 
                        rangep;

                    if (! ipaddr.isValid(range)){
                        that.debug('invalid exclude CIDR passed: ' + exip); 
                        return;
                    }

                    try{
                        rangep = ipaddr.parse(range);
                    }
                    catch(e){
                        that.debug('failed to parse exclude CIDR ip: ' + range + ' because ' + (e.stack || e));
                        return;
                    }

                    if (reqipp.kind() === rangep.kind() && reqipp.match(rangep, subnet)){
                        excluded = true;
                        return false;
                    }
                }
                else if (exip === reqip){
                    excluded = true; 
                    return false;
                }
            });
            return excluded;
        });
    };
    /**
     * Determines if the request should be ignored based on the excludePath or includePath option
     * 
     * @param {object} exreq    express request
     * @return {object}         promise object, resolves with true if request should be ignored,
     *                          otherwise false 
     */
    that.shouldIgnorePath = function(exreq){
        var purl = Url.parse(exreq.originalUrl, false),
            reqpath = purl.path;

        return Q().then(function(){
            // custom include function
            if (typeof(that.opt.includePath) === 'function'){
                var def = Q.defer();
                that.opt.includePath(exreq, function(include){
                    def.resolve(!include);
                }); 
                return def.promise;
            }

            // custom exclude function
            if (typeof(that.opt.excludePath) === 'function'){
                var def = Q.defer();
                that.opt.excludePath(exreq, function(exclude){
                    def.resolve(!!exclude);
                }); 
                return def.promise;
            }

            // array of regex and string
            var excluded = false;
            lo.forEach(['includePath', 'excludePath'], function(key){
                if (typeof(that.opt[key]) !== 'object' || ! that.opt[key].length) return;

                excluded = key === 'excludePath' ? false : true;

                lo.forEach(that.opt[key], function(path){
                    // partial match of string, or regex match
                    if ((typeof(path) === 'string' && reqpath.indexOf(path) !== -1) ||
                        (path instanceof RegExp) && path.test(reqpath)){
                        excluded = ! excluded;
                        return false;
                    }
                });
            });
            return excluded;
        });
    };
    /**
     * Bounce the visitor. Send the specified status code and show a banned message.
     * 
     * @param {object} exreq            express request object 
     * @param {object} exres            express response object 
     * @param {object} visitor          Visitor object
     * @return {object}                 promise object
     */
    that.bounce = function(exreq, exres, visitor){
        var that = this,
            payments = {},
            pm = Payment.getPaymentMethods(),
            pmflipped = lo.invert(pm), 
            am = Payment.getAddressMethods(),
            networks = Payment.getNetworks();

        // get or generate a payment request for each payment method 
        return Q().then(function(){
            // necessary to do payments?
            if (! that.opt.payment.enabled ||
                ! lo.includes([vs.BANNED, vs.BLACKLISTED], visitor.status_id)){ 
                return;
            }

            var p = Q.resolve();

            lo.forEach(that.opt.payment.methods, function(lcMethodName){
                var ucMethodName = lcMethodName.toUpperCase();
                if (! (ucMethodName in pm)){
                    that.handleError(
                        new Error("Can't generate payment request, payment method '" + lcMethodName + "' is invalid")
                    );
                    return;
                }

                var methodopt = that.opt.payment[lcMethodName],
                    ucAddyMethodName = methodopt.addressMethod.toUpperCase(),
                    ucNetworkName = methodopt.network.toUpperCase();

                if (! (ucAddyMethodName in am)){
                    that.handleError(
                        new Error("Can't generate payment request, address method '" + 
                        methodopt.addressMethod +  
                        "' is invalid")
                    );
                    return;
                }

                if (! (ucMethodName in networks) && ! (ucNetworkName in networks[ucMethodName])){
                    that.handleError(
                        new Error("Can't generate payment request, network '" + 
                        methodopt.network +  
                        "' is invalid for method '" + lcMethodName + "'")
                    );
                    return;

                }

                p = p.then(function(){
                    return visitor.getPendingPayment({
                        create: true,
                        method_id: pm[ucMethodName],
                        network_id: networks[ucMethodName][ucNetworkName], 
                        deriveIndexStart: methodopt.deriveIndexStart, 
                        reuseExpiredPayment: methodopt.reuseExpiredPayment,
                        paymentProps: {
                            method_id: pm[ucMethodName],
                            address_method_id: am[ucAddyMethodName],
                            hdpubkey: am[ucAddyMethodName] === am.HDPUBKEY ? methodopt.masterPublicKey : undefined,
                            network_id: networks[ucMethodName][ucNetworkName], 
                            expires: methodopt.expirePaymentsAfter ? 
                                moment.utc().add(methodopt.expirePaymentsAfter, 'milliseconds').toDate() : undefined 
                        },
                        amountOwed: methodopt.amount 
                    });
                })
                .catch(function(err){
                    that.handleError(err);
                    return Q.resolve();
                })
                // set the payment in the final payments object keyed by method
                .then(function(pay){
                    if (pay && (pay instanceof schema.Payment)){
                        var lcMethodName = pmflipped[pay.method_id].toLowerCase(),
                            payMethod = Payment.getPaymentMethodById(pay.method_id),
                            qrCodeUrl = '';

                        if (methodopt.qrCode){
                            try{ qrCodeUrl = pay.getQrCodeUrl(); }
                            catch(e){
                                that.handleError(e);
                            }
                        }

                        payments[lcMethodName] = {
                            address: pay.address,
                            amountOwed: pay.getAmountToDecimal('amount_owed'), 
                            amountRcvd: pay.getAmountToDecimal('amount_rcvd'), 
                            amountCurrencyCode: payMethod.currencyCode,
                            amountCurrencyUnit: payMethod.currencyCode,
                            expires: moment(pay.expires).utc().fromNow(true),
                            confirmationsReq: methodopt.confirmations,
                            qrCodeUrl: qrCodeUrl,
                            payment: pay
                        };
                    }
                });
            });

            return p.then(function(){
                if (! Object.keys(payments).length){
                    that.handleError(new Error('Failed to get or generate any payment requests for bounced visitor'));
                }
            });
        })
        // generate bounce message to display
        .then(function(){
            return that.renderResponseBody(exreq, exres, visitor, payments);
        })
        .then(function(o){
            if (! o.body){
                that.handleError(new Error("Failed to render any response body"));
                return;
            }

            exres.type(that.opt.bounce.contentType).status(that.opt.bounce.statusCode);
            that.setResponseHeaders(o);
            that.emitter.emit('bouncePre', o);
            exres.send(o.body);
            that.emitter.emit('bouncePost', o);
        });
    };

    /**
     * Sets (payment request) response headers in the express response object 
     * 
     * @param {object} o            object of data 
     * @param {object} o.res        express response object
     * @param {object} o.payments   object of payments data key by lower cased payment method name
     */
    that.setResponseHeaders = function(o){
        if (!o.data || ! o.data.payments || ! Object.keys(o.data.payments).length) return;

        var methodnames = [],
            headers = {},
            methodHeaderPrefix = [
            'X-Payment-Address',
            'X-Payment-Amount',
            'X-Payment-Amount-Unit'
            ];

        lo.forOwn(o.data.payments, function(paymentdata, methodname){
            // uppercase first letter
            var ucMethodName = methodname.charAt(0).toUpperCase() + methodname.slice(1);
            methodnames.push(ucMethodName);

            lo.forEach(methodHeaderPrefix, function(mhp){
                var mh = mhp + '-' + ucMethodName,
                    val;

                switch(mhp){
                    case 'X-Payment-Address':
                        val = paymentdata.address;
                        break;

                    case 'X-Payment-Amount':
                        val = paymentdata.amountOwed;
                        break;
            
                    case 'X-Payment-Amount-Unit':
                        val = paymentdata.amountCurrencyUnit;
                        break;

                    default:
                        return;
                }

                headers[mh] = val; 
            });
        });
        headers['X-Payment-Types-Accepted'] = methodnames.join(',');
        o.data.res.set(headers);
    }

    /**
     * Renders the appropriate file (or calls a custom rendering function) based on the visitor's status 
     * 
     * @param {object} visitor              visitor object 
     * @param {object} payments             key/vals of generated payment requests. keys = payment method id, 
     *                                      vals = payment objects
     * 
     * @return {object}                     promise object, resolves with object containing:
     *                                      body: rendered string content 
     *                                      data: data used to render the string content
     */
    that.renderResponseBody = function(exreq, exres, visitor, payments){
        var that = this, o = {}; 

        return Q().then(function(){
            var path; 

            switch(visitor.status_id){
                case vs.BLACKLISTED:
                    path = that.opt.bounce.body.blacklisted;
                    break;

                case vs.SHITLISTED:
                    path = that.opt.bounce.body.shitlisted;
                    break;

                case vs.BANNED:
                    path = that.opt.bounce.body.banned;
                    break;

                default:
                    that.handleError(new Error('Visitor status_id ' + String(visitor.status_id) + 
                        ' does not have a defined response body')); 
                    break;
            }

            o.data = {
                req: exreq, 
                res: exres, 
                visitor: visitor,
                payments: payments,
                adminEmail: that.opt.bounce.adminEmail,
                allowedFor: moment.duration(that.opt.payment.allowedDuration).humanize(),
                ip: visitor.ip
            };

            // custom function
            if (typeof(path) === 'function'){
                var def = Q.defer();
                try{
                    path(o.data, def.resolve);
                }
                catch(e){
                    that.handleError(e);
                    return;
                }
                return def.promise;
            }

            // render response body fle, let ejs handle the caching
            try{
                return Q.nfcall(ejs.renderFile, path, o.data);
            }
            catch(e){
                that.handleError(err);
                return;
            }
        })
        .then(function(body){
            o.body = body;
            return o;
        });
    };

    /**
     * Performs reverse dns lookup of visitor's ip, sets the hostname in the visitor object if found.
     * 
     * @param {object} visitor 
     * @param {object} [opt]            object of options
     * @param {boolean} [opt.save]      flag to save the visitor object if a hostname is found. if true, visitor object
     *                                  must have an id set. default = false
     * @return {object}                 promise object, resolves with updated visitor object
     */
    that.lookupHostname = function(visitor, opt){
        opt = opt || {};
        lo.defaults(opt, {
            save: false
        });

        var hostnames = [], 
            p = Q.resolve();

        try{
            var def = Q.defer();
            dnscache.reverse(visitor.ip, function(err, res){
                hostnames = res;
                return def.resolve(err);
            });
            p = p.then(function(){ return def.promise });
        }
        catch(e){
            p = p.then(function(){ return e; });
        }

        return p.then(function(err){
            // ignoring errors
            if (! hostnames || ! hostnames.length) return visitor;

            visitor.hostname = hostnames[0];
            if (! opt.save) return visitor;

            return Q().then(function(){
                // validate
                var def = Q.defer();

                visitor.isValid(function(valid){
                    if (valid) return def.resolve();
                    def.reject(visitor.errors);
                });
                return def.promise;
            })
            // save
            .then(function(){
                if (! visitor.id){
                    return Q.reject(new Error('visitor object does not have an id set'));
                }

                var def = Q.defer();
                // update single field instead of save, its more atomic
                Visitor.update({id: visitor.id}, {hostname: visitor.hostname}, function(err, affected){
                    if (err) return def.reject(err);
                    def.resolve(visitor);
                });
                return def.promise;
            });
        })
        .fail(function(err){
            that.handleError(err);
            return Q.reject(err);
        });
    };
    /**
     * Processes the request once the response has been completed:
     * 1. runs detectors on the visitor/request.
     * 2. looks up ip's hostname, if applicable 
     * 
     * @param {object} exreq 
     * @param {object} exres 
     * @return {object}         promise object
     */
    that.postResponseProcess = function(exreq, exres){
        return that.detectVisitor(exreq, exres)
        .then(function(r){
            var visitor = r.visitor;

            // do we need to lookup the hostname
            if (! that.opt.lookupHostname || (visitor && (visitor.hostname || visitor._lookedupHostname))) return;
            return that.lookupHostname(visitor, {save: true});
        });
    };
    /**
     * Analyzes a request by running detectors, and saves visitor's status_id to db.
     * Meant to be run on the express request's 'finish' event.
     * Ignores the visitors current status_id, i.e. will run detectors even if visitor is whitelisted.
     * 
     * @function
     * @param {object} exreq 
     * @param {object} exres 
     * @return {object}             promise, resolves with object containing key/vals:
     *                              passed: true = passed all detectors
     *                                      false = failed one or more detectors
     *                                      null = uknown result (or no detectors were run, see aborted) 
     *                              aborted: true = no detectors were run
     *                                      false = at least 1 detector was run
     *                              visitor: Visitor object
     */
    that.detectVisitor = function(exreq, exres){
        var debugid = '[detectVisitor]',
            visitor,
            requests,
            quit = false,
            ret = {
                aborted: true,
                passed: null
            };

        // initial save
        return that.saveVisitorRequest(exreq)
        // load up most recent requests
        .then(function(v){
            visitor = v;
            var def = Q.defer();
            visitor.requests({limit: that.opt.maxRequestPerVisitor, order: 'requested DESC'}, function(err, res){
                if (err) return Q.reject(err);
                requests = res;
                def.resolve();
            });
            return def.promise;
        })
        .then(function(){
            // only run detectors if last detected request was X milliseconds ago
            if (that.opt.detectFrequency && requests.length > 1){
                var thisreq = moment(requests[0].requested).utc(),
                    // use the visitor's last detection timestamp, or if not available use the very first request 
                    // (b/c detectors might still be running from 1st seen request)
                    priorreq = moment(
                    visitor.status_set ? visitor.status_set : requests[requests.length - 1].requested
                    ).utc();

                if (thisreq.isBefore(priorreq.add(that.opt.detectFrequency, 'milliseconds'))){ 
                    quit = true;
                    return;
                }
            }
        })
        // run detectors
        .then(function(){
            if (quit) return;

            that.emitter.emit('detectVisitorStart', visitor);

            var p = Q.resolve();

            ret.aborted = false;
            lo.forEach(that.opt.detectorsOrder, function(detectorName){
                var detectorOpt = that.opt.detectors[detectorName];

                if (! lo.includes(Object.keys(Detectors), detectorName)){
                    return Q.reject(new Error('invalid detector name passed: ' + detectorName));
                }

                p = p.then(function(){
                    if (quit) return;

                    var opt = lo.cloneDeep(detectorOpt);
                    lo.merge(opt, {
                        visitor: visitor, 
                        requests: requests,
                        botbouncer: that, 
                        debug: that.opt.debug
                    });

                    return Detectors[detectorName].pass(opt)
                    .then(function(pass){

                        switch(pass){
                            // ok
                            case true:
                                if (detectorOpt.allowOnPass){
                                    visitor.setStatusId(vs.ALLOWED, {
                                        until: that.opt.allowedDuration,
                                        reason: detectorName
                                    });
                                    quit = true;
                                }
                                ret.passed = true;
                                that.debug(debugid, 'passed bot detector', detectorName, visitor.ip);
                                break;

                            // detected
                            case false:
                                if (detectorOpt.banOnFail){
                                    visitor.setStatusId(vs.BANNED, {
                                        until: that.opt.banDuration,
                                        reason: detectorName
                                    });
                                    quit = true;
                                } 
                                that.debug(debugid, 'failed bot detector', detectorName, visitor.ip);
                                ret.passed = false;
                                break;

                            // don't know
                            case null:
                            default:
                                visitor.setStatusId(null, {until: null, reason: null}); 
                                that.debug(debugid, 'bot detector was inconclusive', detectorName, visitor.ip);
                                break;
                        }
                    })
                    .catch(function(err){
                        that.debug('detector error', detector, err.stack || err);
                    });
                }); 
            });

            // save visitor status
            return p.then(function(){
                var def = Q.defer();
                visitor.save(function(err, v){
                    if (err) return def.reject(err);
                    visitor = v;
                    def.resolve();
                });
                return def.promise;
            });
        })
        .then(function(){
            ret.visitor = visitor;
            that.emitter.emit('detectVisitorEnd', visitor);
            return ret;
        })
        .fail(function(err){
            that.handleError(err);
            return Q.reject(err);
        });
    };
    /**
     * Creates or gets a visitor object in the db for the request.
     * Adds a request object in the db for the request.
     * 
     * @param {object} exreq      express request object 
     * @return {object}         promise object, resolves with visitor object  
     */
    that.saveVisitorRequest = function(exreq){
        var ip = that.getIpFromExpressRequest(exreq);

        return Q().then(function(){
            // validate
            var def = Q.defer(),
                visitor = new Visitor({ip: ip});

            visitor.isValid(function(valid){
                if (valid) return def.resolve(visitor);
                def.reject(visitor.errors);
            });
            return def.promise;
        })
        // create new visitor 
        .then(function(visitor){ 
            return Q.ninvoke(Visitor, 'create', visitor)
            .catch(function(err){
                if (! Schema.isUniqueConstraintError(err)) return Q.reject(err);

                var def = Q.defer();
                // duplicate record ok, lookup existing record
                Visitor.find({limit: 1, where: {ip: visitor.ip}}, function(err, res){
                    if (err) return def.reject(err);
                    if (! res.length || typeof(res[0]) !== 'object'){
                        return def.reject(new Error("Failed to lookup request visitor for ip: " + ip));
                    }
                    visitor = res[0];
                    def.resolve(visitor);
                });
                return def.promise;
            })
            .then(function(visitor){
                if (typeof(visitor) !== 'object'){
                    return Q.reject(new Error("Unknown error creating visitor object for ip: " + ip));
                }
                return visitor;
            });
        })
        // add request record
        .then(function(visitor){
            var def = Q.defer(),
                r = new Request();
            r.fromExpressRequest(exreq);
            r.visitor_id = visitor.id;

            // get timestamp from when request was originally seen
            if (exreq._botbouncer && exreq._botbouncer.requested && (exreq._botbouncer.requested instanceof Date)){
                r.requested = exreq._botbouncer.requested;
            }

            r.isValid(function(valid){
                if (! valid) return def.reject(r.errors);

                visitor.requests.create(r, function(err, rnew){
                    if (err) return def.reject(err);
                    return def.resolve(visitor);
                });
            });
            return def.promise;
        })
        .then(function(visitor){
            return visitor;
        })
        .fail(function(err){
            that.handleError(err);
            return Q.reject(err);
        });
    };
    /**
     * Starts the repeating prune interval 
     */
    that.initPruning = function(){
        var debugid = '[prune]';
        if (! that.opt.prune.frequency){
            that.debug(debugid, 'wont start database pruning interval, prune frequency is falsey'); 
            return;
        }
        if (pruneint) that.killPruneInterval();
        pruneint = setInterval(that.prune.bind(that), that.opt.prune.frequency);
    };
    /**
     * Disables the repeating prune interval calls. 
     * 
     */
    that.killPruneInterval = function(){
        clearInterval(pruneint);
        pruneint = undefined;
    }; 
    /**
     * Checks if we're currently pruning the database. Optionally sets the prune_started timestamp in Meta table. 
     * 
     * @param {object} [opt]            options
     * @param {object} [opt.set]        flag to set the prune_started value to now if not currently pruning. 
     * @return {object}                 promise object. resolves true/false, or if opt.set = true
     *                                  the new prune_started value
     */
    that.isPruning = function(opt){
        var pruning = false;

        opt = opt || {};
        lo.defaults(opt, {
            set: false
        });

        return Meta.getAndSet('prune_started', function(val){
            var lastprune,
                now = moment.utc(),
                ret;

            if (util.isPositiveInteger(val)){
                lastprune = moment(new Date(parseInt(val))).utc();

                // timed out or pruned long ago
                if (lastprune.clone().add(that.opt.prune.timeout, 'milliseconds').isSameOrAfter(now)){
                    pruning = true;
                }
            }

            if (! pruning && opt.set) ret = now.format('x');
            return ret;
        })
        .then(function(){
            return pruning;
        });
    };

    /**
     * Updates the prune_started value to null in db
     * 
     * @param {string} methodName 
     * @return {object}             promise object
     */
    that.donePruning = function(methodName){
        return Q.ninvoke(Meta, 'update', {key: 'prune_started'}, {val: null});
    }

    /**
     * prunes old records from the database 
     */
    that.prune = function(){
        var that = this,
            debugid = '[prune]', 
            start = moment.utc(),
            abort = false;

        // DBINCOMPAT 
        if (that.opt.dbConfig.driver !== 'sqlite3'){
            that.debug(debugid, 'wont prune ' + that.opt.dbConfig.driver + ' database, only sqlite3 is supported');
            return false;
        }

        // check prune lock
        return that.isPruning({set: true}) 
        .then(function(inprog){
            if (inprog){ 
                that.debug(debugid, 'cant prune database, prune currently in progress');
                abort = true;
                return; 
            }

            // begin prune
            that.emitter.emit('pruneStart');
            that.debug(debugid, 'starting database prune');

            return Q().then(function(){
                if (! that.opt.prune.olderThan) return;

                // caminte does not currently support sqlite3 foreign keys/cascading deletes,
                // so delete old visitors and their related requests in 2 statements
                // TODO: should be done as transaction
                return Q().then(function(){
                    var cutoff = moment.utc().subtract(that.opt.prune.olderThan, 'milliseconds').toDate(), 
                        def = Q.defer();

                    Visitor.remove({where: {status_id: null, created: {lt: cutoff}}}, function(err){
                        if (err) return def.reject(err);
                        def.resolve();
                    });
                    return def.promise;
                })
                .then(function(){
                    var sql = 'DELETE FROM ' + Schema.adapter.tableEscaped(Request.modelName) + ' ' +
                        'WHERE `' + Request.relations.visitor.keyFrom  + '` ' + 
                        'NOT IN (SELECT id FROM ' + Schema.adapter.tableEscaped(Visitor.modelName) + ')',
                        def = Q.defer();

                    Schema.adapter.command(sql, function(err, aff){
                        if (err) return def.reject(err);
                        def.resolve();
                    });

                    return def.promise; 
                });
            })
            .then(function(){
                if (! that.opt.prune.vacuum) return;

                var def = Q.defer();

                Schema.adapter.command('VACUUM', function(err, aff){
                    if (err) return def.reject(err);
                    def.resolve();
                });
                
                return def.promise; 
            })
            .then(function(){
                return that.donePruning();
            });
        })
        .fail(function(err){
            that.debug(debugid, 'pruning error: ' + (err.stack || err));
            return Q.reject(err);
        })
        .fin(function(){
            if (! abort) that.emitter.emit('pruneEnd');
            that.debug(debugid, 'end database prune (' + moment.utc().diff(start) + 'ms)');
        });
    };
    /**
     * Starts the repeating checkPayments interval for each known payment method 
     */
    that.initCheckPayments = function(){
        var debugid = '[initCheckPayments]',
            networks = Payment.getNetworks();

        if (! that.opt.payment.enabled){
             that.debug(debugid, 'wont start any payment checking intervals, payments disabled');
             return;
        }

        lo.forEach(that.opt.payment.methods, function(methodName){
            var lcMethodName = methodName.toLowerCase(),
                methodOpt = that.opt.payment[lcMethodName];


            if (! methodOpt.checkFrequency){
                that.debug(debugid, 'wont start ' + lcMethodName + 
                 ' payment checking interval, payments disabled or checkFrequency is falsey');
                return;
            }

            if (cpint[lcMethodName]) that.killCheckPaymentsInterval(lcMethodName);
            that.debug(debugid, 'starting checkPayments interval for ' + methodName, methodOpt.checkFrequency);
            cpint[lcMethodName] = setInterval(
                that.checkPayments.bind(that, {method: methodName}), 
                methodOpt.checkFrequency
            );
        });
    };
    /**
     * Disables the repeating checkPayments interval calls. 
     * 
     */
    that.killCheckPaymentsInterval = function(methodName){
        var debugid = '[killCheckPaymentsInterva]',
            lcMethodName = methodName.toLowerCase();

        if (! (lcMethodName in cpint)){
            throw new Error('cant kill checkPayments interval, ' + methodName + ' isnt a valid payment method'); 
        }

        if (cpint[lcMethodName]){
            that.debug(debugid, 'killing interval for ' + methodName);
            clearInterval(cpint[lcMethodName]);
            cpint[lcMethodName] = undefined;
        }
    }; 
    /**
     * Checks if we're currently running the checkPayments routine for a particular method id. 
     * If checkPayments has timed out
     * 
     * @throws
     * @param {string} methodName       method name, upper or lower case 
     * @param {object} [opt]            options
     * @param {object} [opt.set]        flag to set the check_payments_started_[method]
     *                                  value to now if not currently checking payments. 
     * @return {boolean} 
     */
    that.isCheckingPayments = function(methodName, opt){
        var debugid = '[isCheckingPayments]',
            checking = false;

        methodName = methodName.toLowerCase();

        if (! lo.includes(that.opt.payment.methods, methodName) || ! (methodName in that.opt.payment)){
            throw new Error("Invalid payment method name '" + methodName + "'");
        }

        opt = opt || {};
        lo.defaults(opt, {
            set: false
        });

        var key = 'check_payments_started_' + methodName,
            methodOpt = that.opt.payment[methodName];

        return Meta.getAndSet(key, function(val){
            var lastcheck,
                now = moment.utc(),
                ret;

            if (util.isPositiveInteger(val)){
                lastcheck = moment(new Date(parseInt(val))).utc();

                // timed out
                if (lastcheck.clone().add(methodOpt.checkTimeout, 'milliseconds').isSameOrAfter(now)){
                    checking = true;
                }
            }

            if (! checking && opt.set) ret = now.format('x');
            return ret;
        })
        .then(function(){
            return checking;
        });
    };

    /**
     * Updates the check_payments_started_[method] value to null in db for methodName
     * 
     * @param {string} methodName 
     * @return {object}             promise object
     */
    that.doneCheckingPayments = function(methodName){
        methodName = methodName.toLowerCase();
        if (! lo.includes(that.opt.payment.methods, methodName) || ! (methodName in that.opt.payment)){
            throw new Error("Invalid payment method name '" + methodName + "'");
        }

        var key = 'check_payments_started_' + methodName;

        return Q.ninvoke(Meta, 'update', {key: key}, {val: null});
    }

    /**
     * Checks a payment method's pending payment records for balances, updates payment records' data accordingly.
     * 
     * @param {object} opt                      object of options
     *                                      
     * @param {string} opt.method               payment method string name, uppercase or lowercase 
     * @param {string} [opt.network]            payment method's network name, upper or lowercase. default = what's 
     *                                          set in botbouncer option object payment opt for the payment method 
     * @param {object} [opt.requestOpt]         options to pass to the request module, default = what's set in
     *                                          botbouncer option object payment opt for the payment method 
     * @param {number} [opt.confirmations]      # of required confirmations, default = what's set in
     *                                          botbouncer option object payment opt for the payment method 
     * @param {boolean} [opt.expirePayments]    flag to expire dead pending payments afterwards, default = true
     * @return {object}                         promise object, resolves with an object containing:
     *                                          errors = array of errors if any 
     *                                          total = integer of total count of payment records checked
     *                                          settled = integer of total payment records settled
     */
    that.checkPayments = function(opt){
        that.emitter.emit('checkPaymentsPre');

        // TODO: clean this mess up
        var debugid = '[checkPayments]',
            paymentMethod = Payment.getPaymentMethods(), 
            service = Payment.getServices(),
            network = Payment.getNetworks(),
            ucMethodName,
            lcMethodName,
            ucNetworkName,
            methodOpt,
            methodId,
            networkId,
            abort = false,
            start = moment.utc();

        opt = opt || {};
        lo.defaults(opt, {
            method: that.opt.payment.methods[0], 
            network: undefined,
            requestOpt: undefined,
            confirmations: undefined,
            expirePayments: true
        });

        ucMethodName = opt.method.toUpperCase();
        lcMethodName = opt.method.toLowerCase();
        methodOpt = that.opt.payment[lcMethodName];
        methodId = paymentMethod[ucMethodName];

        // set defaults from that.opt.payment
        lo.forEach(['network', 'requestOpt', 'confirmations'], function(k){
            if (typeof(opt[k]) !== 'undefined') return;

            if (k === 'network'){
                opt.network = methodOpt.network; 
                return;
            }
            opt[k] = methodOpt[k]; 
        }); 

        ucNetworkName = opt.network ? opt.network.toUpperCase() : undefined;
        methodId = paymentMethod[ucMethodName];
        networkId = network[ucMethodName][ucNetworkName];

        var ret = {
                errors: [],
                total: 0,
                settled: 0
            },
            query = {
                where: {
                    method_id: methodId,
                    network_id: networkId,
                    status_id: ps.PENDING
                }
            },
            maxid,
            methodInfo = Payment.getPaymentMethodById(methodId),
            methodSource = service[methodInfo.service];

        return that.isCheckingPayments(lcMethodName, {set: true})        
        .then(function(inprog){
            if (inprog){ 
                that.debug(debugid, 'aborting, checkPayments for method '+
                    lcMethodName + ' already in progress');
                abort = true; 
                return; 
            }
            that.emitter.emit('checkPaymentsStart');
        })
        // get max id so we can keep the total group of records we're operating on static on 
        // even if new records are concurrently added somewhere else 
        // DBINCOMPAT: (other db's might not use autoincrementing primary key id)
        .then(function(){
            if (abort) return;
            var q = lo.cloneDeep(query); 
            q.limit = 1;
            q.order = 'id DESC';
            return Q.ninvoke(Payment, 'find', q);
        })
        .then(function(r){
            if (abort) return;
            if (r && r[0] && util.isPositiveInteger(r[0].id)) maxid = r[0].id;
        })
        // get count of total addresses to query 
        .then(function(){
            if (abort || ! maxid) return;

            var q = lo.cloneDeep(query);
            q.where.id = {lte: maxid};

            return Q.ninvoke(Payment, 'count', q);
        })
        .then(function(total){
            if (abort) return;
            if (! total){
                that.debug(debugid, 'no pending payments to check');
                return;
            }
            var q = lo.cloneDeep(query);
            q.limit = methodSource.address.maxAddressCount;
            q.where.id = {lte: maxid};

            // order by an immutable value, we'll be updating record data as we go because this could
            // take a long time if there are a lot of pending payments. higher id values *should* 
            // mean newer records get checked first.
            // DBINCOMPAT: (db's might not use autoincrementing primary key id)
            q.order = 'id DESC';

            // TODO: move this giant sub func into is own Payment.checkPaymentsBlockr or something
            var sets = Math.ceil(total / q.limit) || 1,
                baseUrl = methodSource.baseUrl[networkId] + methodSource.address.info,
                p = Q.resolve();

            that.debug(
                debugid,
                'checking balances of ' + total + ' addresses in ' + sets + ' sets of ' + q.limit
            );

            for(var i = 1; i <= sets; i++)(function(i){
                var process = true, 
                    pays = []; 

                return p = p.then(function(){
                    q.skip = (i * q.limit) - q.limit; 
                    return Q.ninvoke(Payment, 'find', q);
                })
                // query service api
                .then(function(r){
                    var addies = r.map(function(pay){ 
                            return pay.address; 
                        }),
                        url = baseUrl + addies.join(',') + '?confirmations=' + opt.confirmations, 
                        reqopt = lo.cloneDeep(opt.requestOpt);

                    pays = r;

                    that.debug(debugid, 'checking ' + addies.length + ' addresses in set ' + i + '/' + sets);
                    lo.merge(reqopt, {
                        method: 'GET',
                        url: url
                    });

                    var def = Q.defer();
                    httpRequest(reqopt, function(err, response, body){
                        if (err) return def.reject(err);
                        def.resolve(response);
                    });
                    return def.promise;
                })
                .catch(function(err){
                    ret.errors.push(err);
                    process = false; 
                })
                // process response
                .then(function(response){
                    if (! process) return;

                    if (! response ||
                        response.statusCode !== 200 ||
                        ! response.body ||
                        typeof(response.body) !== 'string'){
                        var err = new Error(
                            'Got an invalid response statusCode or body from ' +
                            methodInfo.service + ' on set #' + i
                        );
                        that.handleError(err);
                        ret.errors.push(err);
                        return;
                    }

                    var r, jsonerr;
                    try{ r = JSON.parse(response.body);} catch(e){ jsonerr = e; };
                    if (jsonerr){
                        var err = new Error('Failed to parse json response from ' + methodInfo.service +
                            ' on set #' + i + ', response: ' + response.body)
                        ret.errors.push(err);
                        that.handleError(err);
                        return;
                    }

                    if (! r || typeof(r.data) !== 'object' || 
                        (pays.length > 1 && ! (r.data instanceof Array))){
                        var err = new Error('Got invalid data object in json response from ' + methodInfo.service +
                            ' on set #' + i + ', data: ' + JSON.stringify(r));
                        ret.errors.push(err);
                        that.handleError(err);
                        return;
                    }

                    if (pays.length === 1) r.data = [r.data];
                    if (r.data.length !== pays.length){
                        // non-fatal
                        var err = new Error('Got ' + r.data.length + ' results from ' + methodInfo.service +
                            ', expected ' + pays.length +
                            ' on set #' + i);
                        ret.errors.push(err);
                        that.handleError(err);
                    }

                    var x = Q.resolve();
                    lo.forEach(pays, function(pay, i2){
                        var res = lo.find(r.data, {address: pay.address});
                        if (! util.isNumeric(res.totalreceived)){
                            var err = new Error(methodInfo.service + ' did not return a valid totalreceived ' +
                                'for address ' + pay.address + ' on set #' + i);
                            ret.errors.push(err);
                            that.handleError(err);
                            return;
                        }

                        // use totalreceived field in case the user has already swept the address.  
                        // but when using 0 conf, blockr will report a balance but not a totalreceived,
                        // so use balance instead
                        var key = ! opt.confirmations ? 'balance' : 'totalreceived';

                        if (! util.isNumeric(res[key])){
                            var err = new Error(methodInfo.service + ' did not return a valid ' + key +
                                ' value for address ' + pay.address + ' on set #' + i);
                            ret.errors.push(err);
                            that.handleError(err);
                            return;
                        }

                        pay.setAmountFromDecimal(res[key], 'amount_rcvd');
                        ret.total++;

                        x = x.then(function(){
                            return that.saveVisitorPayment({
                                payment: pay
                            })
                            .catch(function(err){
                                that.debug(debugid, 'error saving updated visitor/payment record', err);
                                ret.errors.push(err);
                            })
                            .then(function(r){
                                if (r &&
                                    r.payment && 
                                    (r.payment instanceof Payment) && 
                                    r.payment.status_id === ps.SETTLED){
                                    ret.settled++;
                                }
                            })
                        });
                    });
                    return x;
                });
            })(i);

            return p;
        })
        .then(function(){
            if (abort) return;
            return that.doneCheckingPayments(lcMethodName);
        })
        .then(function(){
            if (opt.expirePayments) return Payment.expirePayments();
        })
        .then(function(){
            return Q.resolve(ret);
        })
        .fail(function(err){
            that.handleError(err);
            ret.errors.push(err);
            return Q.resolve(ret);
        })
        .fin(function(){
            that.debug(debugid, 'end checkPayments (' + moment.utc().diff(start) + 'ms)', ret);
            if (! abort) that.emitter.emit('checkPaymentsEnd', ret);
        });
    };
    /**
     * Updates a visitor record, and if necessary the associated payment record in the db using a transaction.
     * 1. If a payment is considered to be paid, it's status will be changed to SETTLED, and the visitor's
     *    status will be changed to ALLOWED.
     * 2. Sets the payment's updated timestamp.
     *
     * TODO: make this the defacto function for changing a visitor's status and associated payment even if a 
     * payment object has not been supplied, or is not a Payment instance.
     * 
     * @param {object} opt                      options
     * @param {object} opt.payment              payment object
     * @return {object}                         promise object, resolves with object containing: 
     *                                          visitor: visitor object, if any
     *                                          payment: payment object, if any
     */
    that.saveVisitorPayment = function(opt){
        opt = opt || {};
        lo.defaults(opt, {
            visitor: {},
            visitorWhere: {},
            payment: {},
            paymentWhere: {}
        });

        var debugid = '[saveVisitorPayment]',
            now = moment.utc(),
            p, 
            pay; // final returned payment object

        // TEMP for now
        if (typeof(opt.payment) !== 'object' || ! (opt.payment instanceof Payment)){
            return Q.reject('payment object is required');
        } 
        
        // TEMP for now
        if (! util.isPositiveInteger(opt.payment.visitor_id)){
            return Q.reject('payment object does not have a valid visitor_id');
        }
        opt.visitorWhere.id = opt.payment.visitor_id;

        if (opt.payment.isPaid()){
            opt.payment.status_id = ps.SETTLED;
            // reuse the setStatusId stuff without having an actual visitor object so that other properties aren't set
            Visitor.prototype.setStatusId.call(opt.visitor, vs.ALLOWED,{
                reason: 'paid',
                until: now.clone().add(that.opt.payment.allowedDuration, 'milliseconds').toDate()
            });

            that.debug(debugid, 'confirmed full payment of ' + opt.payment.amount_rcvd + 
                ' for address ' + opt.payment.address);
        }
        else if (opt.payment.isPaidPartial()){
            that.debug(debugid, 'confirmed partial payment of ' + opt.payment.amount_rcvd + 
                ' for address ' + opt.payment.address);
        }
        opt.payment.updated = moment.utc().toDate();

        // save payment object + events
        var savePayment = function(payment, trx){
            var def = Q.defer();
            
            payment.save({trx: trx}, function(err, paynew){
                if (err){
                    that.debug(debugid, 'error saving payment record', err);
                    return def.reject(err);
                }
                // events
                if (paynew.status_id === ps.SETTLED){
                    that.emitter.emit('paymentSettled', paynew);
                }
                else if (paynew.isPaidPartial()){
                    that.emitter.emit('paymentPartial', paynew);
                }
                return def.resolve(paynew);
            }); 

            return def.promise;
        };

        // just save the payment object, no need to do a transaction because there's no visitor object
        if (! opt.visitor || ! Object.keys(opt.visitor).length){
            p = savePayment(opt.payment).then(function(paynew){
                pay = paynew;
            });
        }
        // transaction
        else { 
            p = Q.ninvoke(Schema.client, 'beginTransaction')
                .then(function(trx){
                    that.debug(debugid, 'begin transaction for visitor_id = ' + opt.visitorWhere.id);
                    var Visitor2 = Schema.cloneModelForTransaction(Visitor, trx);

                    pay = Schema.cloneInstanceForTransaction(opt.payment, Payment, trx); 

                    // update payment
                    return savePayment(pay, trx)
                    // update visitor
                    .then(function(paynew){
                        pay = paynew;

                        var def = Q.defer();
                        if (! Object.keys(opt.visitor).length) return;

                        Visitor2.update(opt.visitorWhere, opt.visitor, function(err, affected){
                            if (err){
                                that.debug(debugid, 'error updating visitor record', err);
                                return def.reject(err);
                            }
                            def.resolve();
                        });
                        return def.promise;
                    })
                    // commit
                    .then(function(){
                        that.debug(debugid, 'commit transaction for visitor_id = ' + opt.visitorWhere.id); 
                        return Q.ninvoke(trx, 'commit');
                    })
                    .then(function(){
                        // switch payment instance back to regular payment instance
                        pay = new Payment(pay.toObject());
                    })
                    // rollback
                    .fail(function(err){
                        that.debug(debugid, 'transaction failed for visitor_id = ' + opt.visitorWhere.id +
                            ', rolling back', err);
                        var def = Q.defer();
                        try{
                            trx.rollback(function(e){
                                def.reject(err);
                            });
                        }
                        catch(e){
                            def.reject(e);
                        }
                        return def.promise;
                    });
                });
        }

        // final return object
        return p.then(function(){
            return {
                payment: pay
            }; 
        });
    };
    that.handleError = function(err){
        that.emitter.emit('error', err);
        that.debug('error', err.stack || err);
    };
    that.debug = function(){
        if (! that.opt.debug) return;
        var args = Array.prototype.slice.call(arguments); 
        args.unshift('[botbouncer]'); 
        return console.log.apply(this, args);
    };
    /**
     * Deletes all data in the database. 
     * 
     * @return {object} 
     */
    that.wipe = function(){
        return Q.ninvoke(Schema, 'automigrate');
    };
    // utility funcs
    /**
     * Returns an array of existing db file path(s) 
     * 
     * @return {object}         array of strings
     */
    that.getDbFilePaths = function(){
        var files = [],
            opt = that.getOpt();

        switch(opt.dbConfig.driver){
            case 'sqlite3':
            default:
                var pfiles = [
                    opt.dbConfig.database,
                    opt.dbConfig.database + '-journal',
                    opt.dbConfig.database + '-shm',
                    opt.dbConfig.database + '-wal',
                ];

                lo.forEach(pfiles, function(file){
                    try {
                        fs.statSync(file).isFile();
                    }
                    catch (e) {
                        return;
                    }
                    files.push(file);
                });
                break;
        }

        return files;
    };

    /**
     * Gets an overview report of botbouncer. TODO: overview report of a specific visitor. 
     *
     * @param {object} opt 
     * @param {string} opt.subject          'db' - overview of botbouncer database with file sizes and
     *                                      record counts. default. 
     *                                      'visitor' - overview of a visitor: visitor/payment/request records. 
     *                                      requires ip argument. 
     * @param {string} opt.format           'table' or 'object', default = 'table' 
     * @param {bool} opt.truncate           flag to remove some db fields for the visitor report to improve 
     *                                      readability, default = true
     * @return {object}                     promise object, resolves with
     *                                      string for table format, object for json format 
     */
    that.getReport = function(opt){
        var formats = ['table', 'object'];

        opt = opt || {};
        lo.defaults(opt, {
            subject: 'db',
            format: 'table',
            ip: null,
            truncate: true 
        });
        if (! lo.includes(formats, opt.format)) opt.format = 'table';
        var p, 
            report = {},
            models = {
                Visitor: Visitor,
                Payment: Payment,
                Request: Request
            };

        switch(opt.subject){
            case 'visitor':
                report = {
                    visitor: {
                        head: ['visitor', ''],
                        body: {}
                    },
                    request: {
                        head: ['request', ''],
                        body: [] 
                    },
                    payment: {
                        head: ['payment'],
                        body: []
                    }
                };

                var visitor,
                    stringify = function(v, truncate){
                        if (v === null) return 'null';
                        if (typeof(v) === 'undefined') return 'undefined';

                        var str; 
                        if (moment.isDate(v)) str = moment(v).format('YYYY-MM-DDTHH:mm:ss');
                        else if (typeof(v) === 'object') str = JSON.stringify(v);
                        else str = v.toString();

                        if (opt.truncate){
                            var cutoff = 60;
                            if (str.length > cutoff){
                                str = str.substr(0, cutoff) + '…'; 
                            } 
                        }
                        return str;
                    };

                p = Q.ninvoke(Visitor, 'find' , {where: {ip: opt.ip}, limit: 1})
                // visitor
                .then(function(r){
                    if (! r || ! r.length || ! (r[0] instanceof Visitor)){
                        return Q.reject('No visitor record found matching ip: ' + where.ip);
                    }

                    visitor = r[0];
                    var vsinv = lo.invert(Visitor.getStatuses());
                    lo.forOwn(visitor.toObject(), function(v, k){
                        if (opt.truncate){
                            if (k === 'status_id'){
                                k = 'status';
                                v = vsinv[v];
                            }
                        }
                        report.visitor.body[k] = stringify(v, opt.truncate); 
                    });
                }) 
                // request
                .then(function(){
                    return Q.ninvoke(Request, 'find', {where: {visitor_id: visitor.id}})
                    .then(function(r){ 
                        if (!r || ! (r instanceof Array)) return;
                        var propsdefs = Request.getPropsDefs();

                        // remove some columns to make report more readable
                        if (opt.truncate){
                            propsdefs = ['visitor_id', 'method', 'url', 'user-agent', 'requested', 'id']; 
                        }
                        else propsdefs = lo.keys(propsdefs);

                        report.request.body.push(propsdefs);

                        lo.forEach(r, function(req){
                            var vals = [];

                            lo.forEach(propsdefs, function(prop){
                                switch(prop){
                                    case 'url':
                                        vals.push(stringify(req.getUrl(), opt.truncate));
                                        break;
                                    case 'user-agent':
                                        vals.push(stringify(req.getUserAgent(), opt.truncate));
                                        break;
                                    default:
                                        vals.push(stringify(req[prop], opt.truncate));
                                        break;
                                }
                            });
                            
                            report.request.body.push(vals);
                        });
                    });
                })
                // payment
                .then(function(){
                    return Q.ninvoke(Payment, 'find', {where: {visitor_id: visitor.id}})
                    .then(function(r){
                        if (!r || ! (r instanceof Array)) return;
                        var propsdefs = Payment.getPropsDefs(),
                            psinv = lo.invert(Payment.getStatuses());

                        // remove some columns to make report more readable
                        if (opt.truncate){
                            delete(propsdefs.hdpubkey);
                            delete(propsdefs.detail);
                            delete(propsdefs.network_id);
                            delete(propsdefs.derive_index);
                            delete(propsdefs.address_method_id);
                            delete(propsdefs.method_id);
                        }

                        propsdefs = lo.keys(propsdefs);

                        report.payment.body.push(propsdefs);

                        lo.forEach(r, function(pay){
                            var vals = []; 

                            lo.forEach(propsdefs, function(prop){
                                switch(prop){
                                    case 'status_id':
                                        vals.push(stringify(psinv[pay[prop]], opt.truncate));
                                        break;
                                    default:
                                        vals.push(stringify(pay[prop], opt.truncate)); 
                                        break;
                                }
                            });

                            report.payment.body.push(vals);
                        });
                    });
                });
                break;

            case 'db':
                report = {
                    dbsize: {
                        head: [
                            'database files',
                            'size'
                        ],
                        body: {} 
                    }
                };

                p = Q().then(function(){
                    var x = Q.resolve();
                        
                    lo.forOwn(models, function(model, k){
                        k = k.toLowerCase(); 

                        if (! (k in report)){
                            report[k] = {
                                head: [k, 'count'],
                                body: {}
                            };
                        }

                        x = x.then(function(){
                            // get model row counts grouped by status  
                            return Q().then(function(){
                                if (typeof(model.getPropsDefs) !== 'function') return;
                                var props = model.getPropsDefs();
                                if (! props.status_id) return;

                                return Q().then(function(){
                                    var sql = 'SELECT status_id, count(*) as c ' +
                                        'FROM ' + Schema.adapter.tableEscaped(model.modelName) + ' ' +
                                         Schema.adapter.buildGroupBy('status_id');

                                    return Q.ninvoke(Schema.adapter, 'queryAll', sql);
                                })
                                .then(function(rows){
                                    var s = lo.invert(model.getStatuses());

                                    lo.forEach(rows, function(row){
                                        var status = row.status_id in s ? s[row.status_id].toLowerCase() : 'no status'; 
                                        report[k].body[status] = row.c;
                                    });
                                })
                                // get visitor banned reason counts
                                .then(function(){
                                    if (k !== 'visitor') return;
                                    var key = 'visitor-banned-reason';
                                    report[key] = {
                                        head: [key.replace(/-/g, ' '), 'count'],
                                        body: {}
                                    };

                                    var sql = 'SELECT status_reason, count(*) as c ' +
                                        'FROM ' + Schema.adapter.tableEscaped(model.modelName) + ' ' +
                                        Schema.adapter.buildWhere(
                                            {status_id: vs.BANNED},   
                                            Schema.adapter,
                                            k 
                                        ) + ' ' +
                                        Schema.adapter.buildGroupBy('status_reason')

                                    return Q.ninvoke(Schema.adapter, 'queryAll', sql)
                                    .then(function(rows){
                                        lo.forEach(rows, function(row){
                                            var reason = row.status_reason ? row.status_reason : 'no reason'; 
                                            report[key].body[reason] = row.c;
                                        });
                                    });
                                });
                            })
                            // get model total row counts
                            .then(function(){
                                return Q.ninvoke(model, 'count')
                                .then(function(c){
                                    report[k].body.total = c;
                                });
                            });
                        });
                    });

                    return x;
                })
                .then(function(){
                    // get db size
                    var total = 0;
                    lo.forEach(that.getDbFilePaths(), function(path){
                        try {
                            var stat = fs.statSync(path);
                            report.dbsize.body[path] = opt.format === 'table' ?
                                filesize(stat.size, {unix: true }) : stat.size;
                            total += stat.size;
                        }
                        catch (e) {
                            report.dbsize.body[path] = e.toString();
                        }
                    });

                    report.dbsize.body.total = opt.format === 'table' ?
                        filesize(total, {unix: true }) : total;
                });
                break;
        }

        return p.then(function(){
            var ret;

            switch(opt.format){
                case 'object':
                    // set each report section's body as the data 
                    lo.forOwn(report, function(section, label){
                        report[label] = section.body;
                    });
                    ret = report;
                    break;

                case 'table':
                default:
                    ret = [];
                    lo.forOwn(report, function(section){
                        var table = new Table({
                            head: section.head,
                            //colWidths: [70, 40]
                        });

                        lo.forEach(section.body, function(v, k){
                            if (section.body instanceof Array){
                                table.push(v);
                            }
                            else{
                                table.push([k, v]);
                            }
                        });

                        ret.push(table.toString());
                    });
                    ret = ret.join("\n");
                    break;
            }

            return ret;
        });
    }; 

    // expose schema/model classes
    that.getModelVisitor = function(){
        return Visitor;
    };
    that.getModelRequest = function(){
        return Request; 
    };
    that.getModelMeta = function(){
        return Meta; 
    };
    that.getModelPayment= function(){
        return Payment;
    };
    that.getSchema = function(){
        return Schema;
    };
    that.getOpt = function(){
        return that.opt;
    }
};

module.exports = function(){
    if (this instanceof BotBouncer) return this;
    return new BotBouncer();
} 
