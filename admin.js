'use strict';

/*  script for admin ops */
// DBINCOMPAT

var Q = require('q'),
    argv = require('minimist')(process.argv.slice(2)),
    fs = require('fs'),
    filesize = require('filesize'),
    lo = require('lodash'),
    Table = require('cli-table2'),
    BotBouncer = require('./index'),
    botbouncer = new BotBouncer(),
    cmds = {
        'prune': {

        },
        'check-payments': {

        },
        'report': {
            opt: {
                'ip': {
                    ex: 'X.X.X.X',
                    desc: 'IP address of visitor to get report on. When omitted, a report of the database is generated instead.',
                }
            }
        },
        'set-status': {
            opt: {
                'ip': {
                    ex: 'X.X.X.X', 
                    desc: 'IP address of visitor. Required.', 
                },
                'status': {
                    ex: ['ALLOWED', 'NULL'], 
                    desc: 'status to set in the db for the visitor. Only "ALLOWED" and "NULL" is currently supported. Required.'
                }
            }
        },
    },
    usage = function(errstr){
        var u = []; 
        if (errstr) u.push(errstr);
        u.push('');
        u.push('USAGE:');
        u.push('');
        u.push('  node admin.js [COMMAND] [OPTIONS] --db /path/to/botbouncer.db');
        u.push('');
        u.push('COMMANDS:');
        u.push('');
        lo.forEach(cmds, function(v, k){
            var str = k;
            if (v.opt){
                str += "\n    OPTIONS:";
                lo.forOwn(v.opt, function(v, k){
                    str += "\n    --" + k + "\t" + v.desc;
                    str += " (" + (v.ex instanceof Array ? v.ex.join('|') : v.ex) + ')';
                });
            }
            u.push("  " + str);
        });
        u.push('');
        console.log(u.join("\n"));
    },
    config = {
        debug: true,
        payment:{
            enabled: false
        },
        prune: {
            frequency: 0
        }
    },
    dbpath = argv.db,
    cmd = argv._[0],
    errcode = false; 

// 1 = bad args 
// 2 = some other error

Q().then(function(){

    try {
        fs.statSync(dbpath).isFile();
    }
    catch (e) {
        usage('ERROR: --db argument missing or file path does not exist');
        errcode = 1;
        return Q.reject();
    }

    config.dbConfig = {
        driver: 'sqlite3',
        database: dbpath
    };
})
.then(function(){
    return botbouncer.init(config);
})
.then(function(){
    var p = Q.resolve();
    if (typeof(cmd) === 'string') cmd = cmd.toLowerCase();

    switch(cmd){
        case 'prune':
            p = p.then(function(){
                return botbouncer.prune();
            });
            break;

        case 'check-payments':
            p = p.then(function(){
                return botbouncer.checkPayments();
            });

            break;

        case 'report':
            p = p.then(function(){
                return botbouncer.getReport({
                    subject: argv.ip ? 'visitor' : 'db',
                    ip: argv.ip, 
                    format: argv.format === 'json' ? 'object' : argv.format
                })
                .then(function(r){
                    if (argv.format === 'json'){
                        r = JSON.stringify(r, null, 4); 
                    }
                    console.log(r);
                });
            }); 
            break;

        case 'set-status':
            var where = {ip: argv['ip']},
                Visitor = botbouncer.getModelVisitor(),
                Payment = botbouncer.getModelPayment(),
                vs = Visitor.getStatuses(),
                ps = Payment.getStatuses(),
                status = argv.status; 

            if (typeof(status) !== 'string' || ! lo.includes(cmds['set-status'].opt.status.ex, status.toUpperCase())){
                usage('ERROR: invalid visitor --status argument');
                return Q.reject();
            };
            status = status.toUpperCase();
            status = status === 'NULL' ? null : status;


            // get visitor
            p = p.then(function(){
                return Q.ninvoke(Visitor, 'find', {where: where, limit: 1})
                .then(function(r){
                    if (! r || ! r.length || ! (r[0] instanceof Visitor)){
                        return Q.reject('No visitor record found matching ip: ' + where.ip);
                    }
                    var visitor = r[0];

                    botbouncer.debug('Found visitor matching ip', visitor);

                    visitor.setStatusId(vs[status], {
                        until: botbouncer.opt.allowedDuration,
                        reason: 'admin' 
                    }); 

                    return Q.ninvoke(visitor, 'save') 
                    .then(function(v){
                        visitor = v;
                        
                        // set their pending payment to expired
                        if (! visitor.status_id === null || 
                            lo.includes([ps.WHITELISTED, ps.ALLOWED], visitor.status_id)){
                            return Q.ninvoke(
                                Payment, 
                                'update', 
                                {visitor_id: visitor.id, status_id: ps.PENDING, updated: moment.utc().toDate()}, 
                                {status_id: ps.EXPIRED}
                            );
                        }
                    })
                    .then(function(){
                        botbouncer.debug('Visitor status updated', visitor);
                    });
                });
            });
            break;

        default:
            usage('ERROR: no COMMAND provided'); 
            errcode = 1;
            return Q.reject();
    }

    return p;
})
.fail(function(err){
    if (err) console.error(err.stack || err);
    errcode = 2;
})
.done(function(){
    process.exit(errcode ? errcode : 0); 
});
