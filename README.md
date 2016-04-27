##botbouncer
botbouncer is node.js/express middleware that performs basic bot detection and bans detected bots until they pay you Bitcoin.

It's intended for use by websites running on a single app server that receive <= 200K hits/day.

**This is experimental software and any usage is at your own risk.**

### Demo
Visit http://botbouncer.xyz and refresh the page a few times to get banned.  Or just run the following from a *nix console:
```
curl -s -S http://botbouncer.xyz && echo '---' && curl -s -S http://botbouncer.xyz
```

Once you've been banned, you'll get a 402 response with a text body that looks something like this:
```
Hello.  Your IP address is making unauthorized automated requests to this website and access has been temporarily banned.

To restore immediate access to this website, make the following Bitcoin payment within the next 3 days:

Bitcoin Address: 1BnVxTxomKYGeZXh79mKaunHqsmjrH7zux
Bitcoin Amount: 0.0005 BTC
QR code: https://chart.googleapis.com/chart?cht=qr&chs=300x300&chld=L|2&chl=bitcoin%3A1BnVxTxomKYGeZXh79mKaunHqsmjrH7zux%3Famount%3D0.05

After your full payment has reached 0 confirmation(s), your IP address will be granted access for a month.
```
If you make the Bitcoin payment then normal access to the demo site should be automatically restored. The demo site is configured to check for payments every 15 seconds or so.

### Requirements
1. node.js express (version >= 4) web app
2. BIP32 HD Bitcoin wallet (see [FAQ](#FAQ) if you don't have one)

### Install and setup
```
npm install botbouncer
```

####Minimal usage example
```
var express = require('express');
var app = express();
var BotBouncer = require('botbouncer');
var botbouncer = new BotBouncer();

return botbouncer.init({
    dbConfig: {
        database: '/path/where/you/want/your/sqlite/database.db'
    },
    payment:{
        bitcoin: {
            masterPublicKey: 'your BIP32 HD master public key'
        }
    }}, function(err){
    
    if (err){
        console.error(err);
        return;
    }
    
    app.use(botbouncer.handleRequest);

    app.get('/', function (req, res) {
        res.send('Hello World!');
    }); 
    
    app.listen(3001, function () {
        console.log('Example app listening on port 3001!');
    });
}); 

```


#### Full usage example: initialized using Q promise library and all options specified
```
var express = require('express');
var BotBouncer = require('botbouncer');
var Q = require('q');
var app = express();
var botbouncer = new BotBouncer();

return botbouncer.init({
    dbConfig: {
        database: '/path/where/you/want/your/sqlite/database.db',
        busyTimeout: 3000
    }, 
    debug: true,
    bounce:{
        enabled: true,
        contentType: 'text/plain; charset=UTF-8',
        statusCode: 402,
        body: {
            banned: '/path/to/ejs-payment-request-template.txt', 
        },
        adminEmail: 'example@example.com' 
    },
    includePath: [],
    excludePath: ['/some/path/all/bots/can/access'],
    whitelistIp: [
        '64.0.0.0/24',
        '::1/128',
        'fc00::/7'
    ],
    allowedDuration: 7 * 86400 * 1000,
    banDuration: 7 * 86400 * 1000,
    detectFrequency: 2000,
    lookupHostname: false,
    getIpMethod: 'X-Real-IP', 
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
        allowedDuration: 30 * 86400 * 1000, 
        bitcoin: {
            amount: .0005,                    
            masterPublicKey: 'your BIP32 HD master public key',
            deriveIndexStart: 666,            
            network: 'livenet',             
            confirmations: 6,               
            expirePaymentsAfter: 3 * 86400 * 1000,
            reuseExpiredPayment: true,     
            requestOpt: {localAddress: '10.8.0.32'},
            qrCode: true,                   
            checkFrequency: 30 * 60 * 1000, 
            checkTimeout: 15 * 60 * 1000,   
        }
    },
    prune:{                             
        frequency: 1 * 86400 * 1000,       
        olderThan: 3 * 86400 * 1000,    
        timeout: 5 * 60 * 1000,         
        vacuum: true
    },
    wipe: false

})
.then(function(){
    botbouncer.emitter.on('error', function(err){
        console.error('botbouncer error', err);
    });

    botbouncer.emitter.on('paymentSettled', function(payment){
        console.log('*ka-ching* payment settled', payment.toObject());
    });

    app.use(botbouncer.handleRequest);

    app.get('/', function (req, res) {
        res.send('Hello World!');
    }); 
    
    app.listen(3001, function () {
        console.log('Example app listening on port 3001!');
    });
})
.fail(function(err){
    console.log('error starting web server', err);
});
```

##How does it work?
botbouncer examines requests sent to the express server. If a request fails one of the bot detection routines, the offending IP address (a.k.a visitor) is banned.  Banned IP addresses are served a custom 402 PAYMENT REQUIRED response with a text body prompting the visitor to pay some Bitcoin for continued access to the site.  This response is served to the banned IP address for all subsequent requests until payment is confirmed.

When a payment is confirmed and settled, the visitor is unbanned, and access is restored by allowing requests from the unbanned IP address to be served normally by the express server.

##How does it work (technically)?
####Bot detection
Bots are detected using a series of basic detector modules.  Each detector inspects the visitor's request(s) for certain properties or behavior.

The detectors are run after the express server's response is sent and the response object emits the "finish" event (as to not cause a slowdown to normal server request/response handling).  If a detector fails the request, the detection routine is ended, and the visitor's status is set to **banned**. The detector modules are described below and run in the following sequence by default:

1. **ua-bot** - uses the [isbot](https://github.com/gorangajic/isbot)  module to check the user agent string for generic bot keywords ("spider", "scrape", etc) and bot specific keywords ("curl", "wxDownload Fast", etc), or if it's simply empty. Common search engine crawlers, such as googlebot and bingbot, are excluded by default.

2. **ua-version** - uses the [useragent](https://github.com/3rd-Eden/useragent)  module to check for user agent strings that indicate severly outdated browser versions.

3. **ua-impostor** - uses reverse/forward DNS lookups to verify requests with user agent strings = googlebot, bingbot, yandex, etc.

4. **ua-switching** - determines if the visitor is switching their user agent string on every single request.

5. **rate-limit** - determines if the visitor has exceeded a certain # of requests within a certain rolling timeframe.  Supports multiple rate limits.

Desirable visitors can be whitelisted when they pass a particular detector so that they are immune to subsequent detection.  By default, if Googlebot passes the **ua-impostor** detector, the IP address is whitelisted and is not subject to further bot detection.

Every visitor's request is saved to the database until the visitor is assigned a particular status (**whitelisted**, **banned**, **allowed**, etc).

####Response handling
On every incoming request, botbouncer queries its database for the request's IP address to determine the visitor's status (except for IP addresses matching those set in the **whitelistIp** config option, then no query is performed).If the visitor is **blacklisted** or **banned**, a payment request is created, or retrieved from the db if a pending request already exists for their IP address.  A new Bitcoin receiving address is generated for every new payment request, unless the **reuseExpiredPayment** option is enabled.

botbouncer then "bounces" the **banned** visitor by responding with a 402 HTTP status code (PAYMENT REQUIRED) and plain text body similar to the following:
```
Hello.  Your IP address has been determined to be making automated requests to this website and access has been temporarily banned.

To get immediate access to this website, make the following Bitcoin payment within the next in 3 days:

Bitcoin Address: 19am4P4vbBKDkwdv5R7gLUN27GmGCTmFAh
Bitcoin Amount: 0.05 BTC
QR code: https://chart.googleapis.com/chart?cht=qr&chs=300x300&chld=L|2&chl=bitcoin%3A19am4P4vbBKDkwdv5R7gLUN27GmGCTmFAh%3Famount%3D0.05

After your full payment has reached 1 confirmation(s), your IP address will be granted access for 7 days.

If you think this ban was made in error, or your are experiencing problems with your payment, please contact the website administrator at foo@bar.com and include your IP address (167.213.68.157) in your message.
```

Additional payment request headers are also set in the response, see [FAQ](#FAQ).

####Payments
botbouncer currently only accepts Bitcoin payments and uses Bitcoin BIP32 deterministic address generation to get a unique address per payment request. A master public key from a BIP32 HD Bitcoin wallet must be provided in botbouncer's config options.

Bitcoin payment monitoring is done via interval polling of the [blockr.io](https://blockr.io) API.  API requests are batched with 20 addresses per request.  Pending payment request addresses are checked until they're paid in full or their expiration date is surpassed.

If a payment request's expiration date is surpassed, then the visitor remains **banned** and a new payment request will be generated on their next request.

If a payment request's address received total reaches the amount owed with the required confirmation count, the associated visitor's status is set to **allowed** and requests from the visitor will no longer be "bounced" by botbouncer until their **allowed** status expires (see **payment.allowedDuration** config option).

When a paid visitor's **allowed** status expires, their IP address will still have access to the normal server, but their requests will once again be subject to bot detection, potentially resulting in another ban and a new payment request.

####Database
botbouncer creates a sqlite3 database in [WAL journal mode](https://www.sqlite.org/wal.html)  to track visitors, requests, and the payments.  By default, the following database files are created in the current working directory:

- botbouncer.db
- botbouncer-wal.db
- botbouncer-shm.db

If WAL journal mode is not supported by your file system, then botbouncer defaults to delete journal mode and creates the following file(s) in your current working directory by default:

- botbouncer.db
- botbouncer-journal.db (temp file, only remains on disk when a transaction is interrupted)

See the [sqlite website](https://www.sqlite.org/tempfiles.html) for more details.

#####Schema

Each IP address is treated as a unique visitor.  There are 4 tables in the main database:

- **visitor**: contains visitors by IP address and their current status details
- **request**: contains visitors' requests
- **payment**: payment requests for banned visitors
- **meta**: botbouncer state information and other stuff

botbouncer uses the [caminte](https://github.com/biggora/caminte) module as an ORM. Caminte was chosen because of its cross-db capabilities, but botbouncer is currently limited to using sqlite3 only.

Based on passed config options, the database is pruned periodically of unneeded records to help keep it's size under control.

###Config
Pass config options as first argument to ```botbouncer.init```. Config options are merged recursively with the default config options.  The only required config option is **dbConfig.database**. The **payment.bitcoin.masterPublicKey** is required if payments are enabled. 

Nested options are written in dot notation below.

| option | type | default | description |
| --- | --- | ---| --- |
|includePath|array of strings/regexp|[]|Array of strings and/or regexp. Requests with paths matching any of the supplied array elements will be processed by botbouncer. All others will be ignored. Strings are case sensitive. This option can't be combined with excludePath option.|
|excludePath|array of strings/regexp|[]|Array of strings and/or regexp. Requests with paths matching any of the supplied array elements will ignored by botbouncer. All other requests will be processed. Strings are case sensitive. This option can't be combined with includePath option.|
|whitelistIp|array of strings|ipv4/6 CIDR's of local/private networks|Array of CIDR notation strings representing network IP address ranges to ignore. NOTE: visitors with matching IP's are not stored in the database.|
|allowedDuration|int|2592000000 (3 days)|# of milliseconds an allowed user should retain their allowed status. This only applies to visitors who have passed a bot detector with the **allowOnPass** option eneabld (not those visitor who have paid money). Once the allowed status expires, the visitor will be bot detected again.|
|banDuration|int|2592000000 (3 days)|# of milliseconds a banned user should remain banned for. Once the banned status expires, the visitor will be detected again.|
|detectFrequency|int|1000|Only run the detectors after a visitor's request if it's been this many milliseconds since the visitor's last request,o r it's their first request. The delay helps limit multiple bot detection runs on the same visitor. 0 to disable.|
|lookupHostname|bool|true|Flag to do a reverse dns lookup on the visitor's ip address before the visitor record is saved to the database.|
|getIpMethod|bool/string/function|null|How to get the IP address from the express request. If falsey, uses **req.ip**. if string, use req.headers[string] (case insensitive). if function, use function's return (passed express request object as sole argument).
|debug|bool|false|Flag to print debug message to the console. They'll be in the format [botbouncer] [methodname] [message]|
|wipe|bool|false|Flag to remove all existing database data and start over.|
|**dbConfig**||||
|dbConfig.database|string|process.cwd() + '/botbouncer.db'|Path to the botbouncer sqlite3 database. If the database does not exist there, it will be created.|
|dbConfig.busyTimeout|int|3000|timeout in milliseconds for database query/operations|
|**payment**||||
|payment.enabled|bool|true|Enable requesting payments from banned visitors.|
|payment.allowedDuration|int|2592000000 (30 days)|How long a settled payment unbans a visitor for in milliseconds. A visitor that has paid will be subjected to bot detection again afterwards.|
|**payment.bitcoin**|||Bitcoin payment options|
|payment.bitcoin.amount|number|0.05|Amount of Bitcoin (BTC) to charge banned visitors for continued access.|
|payment.bitcoin.masterPublicKey|string||BIP32 HD master public key.  Should be a large string that looks like 'xpub...'|
|payment.bitcoin.confirmations|int|1|# of confirmations to consider payment settled, max = 15 b/c of blockr.io limits|
|payment.bitcoin.reuseExpiredPayment|bool|false|Flag to use expired payment addresses if possible, instead of generating a new payment request. This will help keep the # of payment requests records low at the cost of altering past payment request records.|
|payment.bitcoin.requestOpt|object|{}|Additional options to pass to the [request](https://github.com/request/request) module when making API calls.|
|payment.bitcoin.qrCode|bool|true|Flag to display a payment QR code URL from chart.googleapis.com in the payment request body text.|
|payment.bitcoin.checkFrequency|int|900000 (15 minutes)|How often to automatically check for settled payments in milliseconds, 0 to disable automatic payment checking.|
|payment.bitcoin.checkTimeout|int|900000 (15 minutes)|If the checkPayments routine (i.e. the querying of blockr.io API for any payments) has been locked for longer that this many milliseconds, consider it timed out and allow checkPayments routine to run again.|
|**bounce**||||
|bounce.enabled|bool|true|Flag to display the banned response for banned/blacklisted visitors. Disable for dry run: visitors will still be saved to db, but bounce response won't be displayed, and requests continue normally.|
|bounce.contentType|string|text/plain; charset=UTF-8|content type header of bounced response|
|bounce.statusCode|int|402|HTTP response code of bounced response|
|bounce.body|object|N/A|Bounced response body content options|
|bounce.body.banned|string/function|content/en/body/banned-payment-request.txt|File path to an ejs template file to be rendered and set in the response's body. Or a function that renders the response body, and is passed arguments: req, res, visitor, done. done is a callback that must be passed the body content as an argument.|
|bounce.adminEmail|string|undefined|email address to display in the payment request body text|
|**detectors**||||
|**detectors.ua-bot**|||Detects if the request's user agent string matches known bots or keywords.|
|detectors.ua-bot.enabled|bool|true|Flag to enable/disable|
|detectors.ua-bot.order|bool|0|The order in which this detector should be run in relation to the other detectors (order is ascending).|
|detectors.ua-bot.allowOnPass|bool|false|If the visitor should be given the ALLOWED status if they pass detection.|
|detectors.ua-bot.banOnFail|bool|true|If the visitor should be given the BANNED status if they fail detection.|
|detectors.ua-bot.exclude|array of strings/regexp|google, bingbot, yandex, yahoo, baidu, uptimerobot|Array of strings and/or regular expression objects of bot user agents to ignore. If a provided string is contained in the user agent string (case insensitive), or a regexp matches the request's user agent, then the request will pass.|
|**detectors.ua-version**|||Checks if the request's user agent string indicates a severly outdated browser version.|
|detectors.ua-version.enabled|bool|true|Flag to enable/disable|
|detectors.ua-version.order|bool|1|The order in which this detector should be run in relation to the other detectors (order is ascending).|
|detectors.ua-version.allowOnPass|bool|false|If the visitor should be given the ALLOWED status if they pass detection.|
|detectors.ua-version.banOnFail|bool|true|If the visitor should be given the BANNED status if they fail detection.|
|detectors.ua-version.version|object|ie: <=7.0.0, firefox: <=30.0.0, chrome: <=32.0.0, safari: <=5.1.9|Object of key/vals where the key is a case-insensitive browser family ('firefox', 'chrome') and the val is a semver version number string that when matched, will consider the request to be a bot. The version number string should be in the format for the useragent module's satisfies function (https://github.com/3rd-Eden/useragent#user-content-adding-more-features-to-the-useragent).|
|**detectors.ua-impostor**|||Uses reverse/forward DNS lookups to verify requests with user agent strings of popular web crawlers are truly who they claim to be. Currently checks googlebot, yahoo, bingbot, yandex, baidu, and uptimerobot.|
|detectors.ua-impostor.enabled|bool|true|Flag to enable/disable|
|detectors.ua-impostor.order|bool|2|The order in which this detector should be run in relation to the other detectors (order is ascending).|
|detectors.ua-impostor.allowOnPass|bool|true|If the visitor should be given the ALLOWED status if they pass detection.|
|detectors.ua-impostor.banOnFail|bool|true|If the visitor should be given the BANNED status if they fail detection.|
|**detectors.ua-switching**|||Determines if the visitor is switching their user agent string on every single request.|
|detectors.ua-switching.enabled|bool|true|Flag to enable/disable|
|detectors.ua-switching.order|bool|3|The order in which this detector should be run in relation to the other detectors (order is ascending).|
|detectors.ua-switching.allowOnPass|bool|false|If the visitor should be given the ALLOWED status if they pass detection.|
|detectors.ua-switching.banOnFail|bool|true|If the visitor should be given the BANNED status if they fail detection.|
|detectors.ua-switching.minRequests|int|5|Visitor must have made at least this many requests to be considered, 0 to disable|
|detectors.ua-switching.maxRequests|int|20|Max # of latest requests to inspect, 0 to disable|
|detectors.ua-switching.timeframe|int|300000 (5 minutes)|Only consider requests made within this many milliseconds prior to the last request, 0 to disable|
|**detectors.rate-limit**|||Determines if the visitor has exceeded a certain # of requests within a certain rolling timeframe.  Supports multiple rate limits.|
|detectors.rate-limit.enabled|bool|true|Flag to enable/disable|
|detectors.rate-limit.order|bool|4|The order in which this detector should be run in relation to the other detectors (order is ascending).|
|detectors.rate-limit.allowOnPass|bool|false|If the visitor should be given the ALLOWED status if they pass detection.|
|detectors.rate-limit.banOnFail|bool|true|If the visitor should be given the BANNED status if they fail detection.|
|detectors.rate-limit.limit|array of objects|[{total: 50, timeframe: 900000}]|Array of objects representing rate limits to implement. Default is 50 requests allowed per last 15 minutes.|
|detectors.rate-limit.limit[].total|||# of requests that are allowed within the timeframe.|
|detectors.rate-limit.limit[].timeframe|||Timeframe to inspect as milliseconds from the latest request. NOTE: make sure this is larger than botbouncer's detectFrequency setting, otherwise rate limit violations may not be detected.|
|**prune**|||options for automatic database pruning|
|prune.frequency|int|8640000 (1 day)|How often, in milliseconds, to automatically prune old records from the database. Don't set this higher than 2147483647 (25 days). Your web app will be unresponsive during pruning, and the process may take a few seconds depending on the size of your database (a 200MB database takes roughly 10 seconds to prune). Set to 0 to disable.|
|prune.olderThan|int|259200000 (3 days)|Delete unneeded visitor records (and their related request records) older than this many milliseconds, 0 to disable|
|prune.timeout|int|300000 (5 minutes)|If prune lock has been on for longer than this many milliseconds, consider pruning failed/timed out and reset|
|prune.vacuum|bool|true|Flag to compact sqlite3 database after pruning.|

###Methods
botbouncer methods intended for public usage.

| method | description |
|--------|--------|
| init | Initializes botbouncer and creates the sqlite3 database, or if it exists, updates its schema if necessary. Accepts two parameters: config object, and an optional callback called once init is complete. Returns a Q promise object that resolves once init is complete.|
| handleRequest | Looks up the visitor by IP and determines if the request should continue based on the visitor's status. Also queues up bot detection if necessary once the request/response has been completed by express. Meant to be enabled in express express via ```app.use```, not meant to be called outright.|
| getModelVisitor | Returns the caminte Visitor model. |
| getModelRequest | Returns the caminte Request model. |
| getModelPayment | Returns the caminte Payment model. |
|getDbFilePaths| Returns an array of path strings of all the sqlite3 database files. |
|getOpt| Returns botbouncer's config object.|
| wipe| Deletes all data in the database. Use with caution.|

####Example
Here's a quick example of looking up a visitor by IP and getting all their request and payment records.  See the [caminte](https://github.com/biggora/caminte) module for details on working with models and instances.

```
// ... after botbouncer has been initialized
Visitor = botbouncer.getModelVisitor();
Visitor.find({where: {ip: '192.168.0.150'}}, function(err, visitors){
    if (err){
        console.error(err);
        return;
    }   

    if (! visitors[0]) return;
    var visitor = visitors[0];
    console.log(visitor.toObject());
    // { ip: '192.168.0.150', ipv: 4, hostname: null, created: Tue Apr 26 2016 23:44:18 GMT+0000 (UTC), ... }
    
    visitor.requests(function(err, requests){
        if (err){
            console.error(err);
            return;
        }
        
        if(requests[0]) console.log(requests[0].toObject());
        // { visitor_id: 1, method: 'get', protocol: 'http', hostname: 'example.com', ... }

        visitor.payments(function(err, payments){
            if (err){
                console.error(err);
                return;
            }
  
            if(payments[0]) console.log(payments[0].toObject());
            // { visitor_id: 1, method_id: 1, status_id: 1, address: 'XXXX', ... }
        });
    });
});
```

###Events
The following events are emitted by ```botbouncer.emitter```:
- **error**: emitted when an error is encountered, passed an Error object
- **detectVisitorStart**: emitted immediately prior to a visitor being subjected to the detector functions. passed a visitor object.  
- **detectVisitorEnd**: emitted immediately after a visitor has been subjected to the detector functions. passed a visitor object.  
- **bouncePre**: emitted immediately prior to the express reponse being sent for a banned visitor. passed an object of data. 
- **bouncePost**: emitted immediately after the express response has been sent for a banned visitor. passed an object of data.
- **pruneStart**: emitted when the database prune routine starts.
- **pruneEnd**: emitted when the database prune routine ends.
- **monitorPaymentsPre**: emitted when the monitorPayments routine begins, regardless if intends to fully execute (example: monitorPayments will exit early if another monitorPayments call is currently in progress).
- **monitorPaymentsStart**: emitted when the monitorPayments routine begins and intends to fully execute.
- **monitorPaymentsEnd**: emitted when the monitorPayments routine ends.
- **paymentSettled**: emitted when a full payment is fully confirmed. passed a payment object.
- **paymentPartial**: emitted when a partial payment is fully confirmed. passed a payment object.

Example of listening for an error event:
```
botbouncer.emitter.on('error', function(err){
    console.error('botbouncer error', err);
});
```

###Best practices
A few suggestions when using botbouncer:
1. Don't let botbouncer process requests for static files (css, js, images, fonts, etc) because it really increases the chance that human visitors will be banned due to exceeded rate limits when their browser loads all that stuff.  This can be avoided by ensuring [express's built-in static middleware](http://expressjs.com/en/starter/static-files.html) is called prior to botbouncer's middleware:

    ```
    app.use(express.static('base/path/to/your/static/files'));
    app.use(botbouncer.handleRequest)
    ```
    Alternatively you can tell botbouncer to ignore requests to your static files:
    ```
    botbouncer.init({
        excludePath: ['base/path/to/your/static/files']
    })
    ```

    Another alternative is to configure a (nginx) reverse proxy to handle static requests by itself and not forward them to your express app.


2. If you're using nginx as a reverse proxy make sure you've enabled express's "trust proxy" setting (ie. ``` app.set('trust proxy', true)```) so that botbouncer can get the visitor's real IP address at ```req.ip```.  The visitor's real IP address [should be set by nginx](http://expressjs.com/en/guide/behind-proxies.html) in the ```X-Forwarded-For``` header (don't trust whatever the client sends in their own ```X-Forwarded-For``` header, it's trivial to forge). Example:

    ```
    proxy_set_header X-Forwarded-For $remote_addr;
    ```

    Alternatively, you can set the real remote IP address in a different header in your nginx server's config, for example:

    ```
    proxy_set_header X-Real-IP $remote_addr;
    ```

    And then pass that header's name in botbouncer's **getIpMethod** config option:

    ```
    {  
       ...
       getIpMethod: 'X-Real-IP',
       ...
    }
    ```
    botbouncer will then use the ```req.header('x-real-ip')``` value as the visitor's IP address instead of the default ```req.ip```.
    
    Alternatively, if you're the DIY type, the **getIpMethod** can also be a custom function that returns the visitor's IP address.  It's passed 1 argument: the express request object.


3. Reduce the number of payment requests (and generated Bitcoin addresses) by enabling the **payment.bitcoin.reuseExpiredPayment** option, which will simply use an old expired payment request address when possible instead of generating a new one.
4. Otherwise, it's possible botbouncer may generate thousands of payment requests before anyone ever pays you. If you do get paid, you may not see the Bitcoin payment in your own wallet because of the wallet's gap limit: the number of deterministic addresses your wallet will check before giving up (ie. Electrum's default gap limit is 20).  So it may be necessary to periodically update your wallet's gap limit based on how many addresses you've generated.  Eventually, botbouncer will have an admin function that will return the suggested gap limit to set in your wallet.
4. Listen to the "paymentSettled" and/or "paymentPartial" events, and log them or send yourself an email as a secondary measure to know if you've been paid and if you need to update your wallet's gap limit.
5. Listen to the "error" event and log errors.
6. Specify an email address where you can be reached in the **adminEmail** config option, or include one in your custom banned response text.  If you still want humans on your website, it's best to ensure they can contact you if they're erroneously banned.
7. It's not currently recommended to use botbouncer on a forking/multi-process express server, see [FAQ](#FAQ) below.
8. Use a separate Bitcoin wallet and BIP32 master public key for each node.js express app that uses botbouncer.  If you don't, the generated addresses will be the same, and any payments would be credited to each app for different visitors.


## FAQ
Disclaimer: these aren't frequently asked questions because no one has ever asked these questions except me to myself.

##### I don't have a Bitcoin BIP32 HD master public key.  How do I get one?
Install [Electrum](https://electrum.org/) on your computer.  It's Bitcoin wallet software with BIP32 HD support. It also supports multiple wallets and easy access to each wallet's master public key. The downside is that it's an SPV client, so it's lacking in privacy as Electrum connects to a single 3rd party server capable of logging your IP address and Bitcoin addresses.

1. Install Electrum.
2. Create a new wallet (File > New). It's suggested to label it something similar to your website.  If you're using botbouncer with multiple Express apps, you'll want to create a wallet for each app.
3. Once the wallet has been created, get the master public key (Wallet > Master Public Key), and copy/paste it into your botbouncer config.
4. **Optional but recommended**: increase your wallet's gap limit so that you'll see incoming payments.  Goto the console tab and paste this, hit enter:

```
wallet.storage.put('gap_limit',1000);
```

##### Will botbouncer slow down my website?
In my testing with a database of 55K visitor records, 88K payment records, and 360K request records, botbouncer added an average of 30ms to the server's response time.  For each request, botbouncer performs a single indexed query on the visitor's IP address.  If the visitor is banned, then an additional query or two is performed to get their payment request record and the next address derivation index if a new Bitcoin address has not yet been generated.

##### Will Google penalize my website for cloaking?
I doubt it. I've been running botbouncer on one of my websites for the last 2 months and traffic levels have remained static, and adsense earnings have even increased slightly.

I don't intend to know the mind of Google, but [Matt Cutts says](https://support.google.com/webmasters/answer/2604723?hl=en) that cloaking "is showing different content to users than to Googlebot" and is determined by if "are you treating users the same way as you're treating Googlebot".

Personally, I wouldn't consider a bot to be a normal user. And even if a human user (or one of Google's covert "normal user" bots) gets detected as a bot and is banned/bounced, I think as long as botbouncer sends a 402 PAYMENT REQUIRED (or similar error code) instead of a 200 OK status code, you're in the clear, as I would not consider an error response to be content.

Besides, Google and Cloudflare already pull the exact same stuff.  Try accessing google.com from a VPN or proxy that bots have used, and you'll be shown an intermediate page forcing you to solve a CAPTCHA before you can continue to your original destination's content. So if you're penalized by Google for cloaking, you can safely accuse them of hypocrisy.

#####I don't use Node.js and/or Express. Can I still use botbouncer?
No. But someday maybe I'll add a standalone mode to botbouncer so that it can be installed and run as a server that interfaces via an API with your own (PHP/Ruby/Python/whatever) web server. I think this would be far easier than trying to port it to other popular languages.

#####Don't you know that you can't equate an IP address with a single visitor because of NAT, proxies, VPN's, what have you?
Yup, but that's just how this thing works right now. The alternatives, such as session cookies or fingerprinting, are either impractical or ineffective. If you have a better idea, I'll listen.

#####So that means if a bot is using a proxy/VPN and pays for access to my website, then any other bots using the same proxy/VPN get access to my website for free?
Yes.

#####Can a regular human visitor get banned by botbouncer?
Yes.  If the human's browser is changing ua strings on every request, or they exceed the request rate limits, or engage in other bot-like behavior that trips one of the detectors, they'll be banned.  But of course the goal is to keep false positives to a minimum.

#####What recourse does a regular human visitor have if they are determined to be a bot and are banned?
Besides paying up, not much. They can email the administrator alerting them of the situation. That's why webmasters are strongly suggested to include an email address they can be reached in the bounce body message via the **adminEmail** config setting.

#####Couldn't a banned bot operator pose as a regular human visitor and just email the admin asking for access?
Yes. That's why webmasters are also suggested to run a report on the visitor's IP when an unban request is received from a stranger on the internet. Check their request history, IP address hostname, why they were banned, and make an educated decision whether the unban request is actually legit, or just a bot operator posing as an innocent human.  You can get a report on an IP address like so:

```
node /path/to/your/app/node_modules/botbouncer/admin.js report --ip X.X.X.X --db /path/to/your/botbouncer.db
```

##### Can the entire payments functionality be disabled?
Yes, pass this flag in your config options:
```
payment: {
    enabled: false
}
...
```

#####Bitcoin is stupid and dead. Can you make this thing work with Paypal?
People keep saying Bitcoin is dead. But it still works for me, so I don't know what to tell you.

Wait, yes I do. I think cryptocurrency is the ideal payment method here because it doesn't require the parties involved to know much about each other. Think of it this way: if you were scraping a website and got banned by the site's admin, but still really needed access, would you want to hand over your personal info (name/email address/billing details/etc) when you pay them for continued access? Nope, a pseudonymous payment just makes more sense.

Also, a sufficiently confirmed Bitcoin transaction is quite permanent.  Centralized payment method transactions can be contested by the customer and reversed by the payment processor.
 
But if you really want Paypal support, or some other payment processor, contact me and I'll see what I can do.  It will cost you many bitcoins. I am also open to adding support for other popular cryptocurrencies/altcoins.

#####Can I require everyone to pay me for access to my website, even if they're not a bot?
Not yet.  But I'm thinking of adding a **blacklistIp** config option added soon where you could simply blacklist the entire internet in the botbouncer config options like this:

```
blacklistIp: '0.0.0.0/0'
```

#####Will botbouncer prevent (D)DoS attacks? 
No botbouncer probably won't help much against a DDoS. A severe enough attack will jam your network up before it jams your node.js app server up.  Even if the attack is less severe and requests are making it to your app server, botbouncer visitors are identified by IP address, so many IPs = many visitors.

botbouncer might help defend against lightweight DoS attacks because it will ban a visitor's IP when they exceed your rate limit and will prevent the request from continuing on to be handled by your web app. But, botbouncer queries it's file-based sqlite3 database on each request to determine the IP's status, so an inordinate amount of these queries due to a DoS attempt may overload your app.

#####I use cluster to fork my express server process. Is botbouncer multi-process safe?
It *should* be because botbouncer uses sqlite3 transactions to keep changes to records atomic, and thus avoid race conditions across multiple processes, but this has not yet been tested on a multi-process server.  If you're brave and want to try it out, I would suggest disabling all interval background processing (like checking payments and database pruning) and instead running those via cronjobs.  A multi-process express server will create multiple botbouncer instances, and botbouncer *should* prevent concurrent runs of background processing routines (via storing states in the database), but it's still better to be safe about it until multi-process stuff is fully tested.

######How to do this
1. Disable all interval background processing in your botbouncer config:
```
...
prune: {
    frequency: 0
},
payment:{
    bitcoin:{
        checkFrequency: 0
    }
}
...
```
3. Setup cronjobs for payment checking and database pruning, examples:
```
*/10 * * * *  someuser    node /path/to/your/app/node_modules/botbouncer/admin.js check-payments --db /path/to/your/botbouncer.db
0 2 * * *  someuser    node /path/to/your/app/node_modules/botbouncer/admin.js prune --db /path/to/your/botbouncer.db
```

##### Does botbouncer set any machine readable response headers indicating the payment method, amount, etc? [faqheaders]
Yes, there are four headers, here's an example:

```
X-Payment-Types-Accepted: Bitcoin
X-Payment-Address-Bitcoin: 12A1MyfXbW6RhdRAZEqofac5jCQQjwEPBu
X-Payment-Amount-Bitcoin: 0.05
X-Payment-Amount-Unit-Bitcoin: BTC
```
The header names are formatted so that multiple payment methods could be accepted and transmitted in a single 402 PAYMENT REQUIRED response. For example, the "X-Payment-Types-Accepted" header value may one day be a comma separated string of payment methods, maybe something like this: ```Bitcoin,Litecoin,Ethereum,Dogecoin``` with additional address, amount, unit headers for each of those payment methods.

#####Do these headers follow any kind of standardized protocol?
No. They were borrowed from [Casey Leonard](http://thoughts.amphibian.com/2015/05/using-http-402-for-bitcoin-paywall.html) because they seemed to be the most extendable and informative headers proposed so far. I added "X-Payment-Amount-Unit-*" (example values would be things like BTC, mBTC, µBTC/uBTC, satoshi/satoshis, etc) because I think it makes sense to be provide as many details as possible so any crawling automata that want to make automated payments don't get confused (currently botbouncer only specifies BTC as this header's value).

#####Why is the banned response message in plain text and not HTML? 
Generally speaking, it's easier on the bot operators' eyeballs. Once they notice that their bot is encountering 402 errors on every request to your site, they'll most likely ask themselves "WTF is a 402?" and then manually inspect the response body from a console or log file. So hopefully this response body is a bit easier for them to read than picking through raw HTML.

This does have the drawback of looking wacky to a legitimate browser user who has been banned from your site by mistake. You can render your own HTML response message by passing a custom function as the message file path, or changing the response body on the ```bouncePre``` event.

#####How does botbouncer handle errors?
Errors are not thrown or passed to express's next() function.  Instead an error event is emitted. That means that if botbouncer fails in some way your website should still work instead of erroring with a 500 status code.

Is handling unban requests via email clunky? Yes, but it's the best option at the moment. Perhaps in the future an alternative such as a CAPTCHA + cookie (like Google and Cloudflare do) can be implemented, though this technique can also be circumvented by a bot operator.

#####Does botbouncer work on windows?
Don't know, don't care. I'm open to pull requests for windows support, but I wont' be adding it myself unless someone pays me muchos bitcoinos.

#####Will you add feature ABC and cool thing XYZ?
I'll add nearly anything if you pay me. Otherwise probably not, but I'll gladly accept pull requests.

#####Do you have a bitcoin tipping address?
Yes, thanks for asking:
```
1MUUyS4y4w4NsV4acD2XiDmAV1zMN92PS5
```

##Release history

###### 2016-04-27 v0.0.3
initial release

##About

Congrats on making it this far.  botbouncer was inspired by a prior project I did with [Jesse Powell](https://github.com/jespow) called [Elephant Grass](https://github.com/timbowhite/elephant-grass-gmail), which was a similar idea, except for email. While that one didn't turn out to be a homerun, I think the idea of automated, private payments and provisioning with the lack of human involvement is extremely cool. So perhaps the perfect compliment to botbouncer would be web scraping software with an integrated bitcoin wallet. Maybe it could be called benefactorbot. Or subscraper. Give it a small bitcoin allowance and set it loose scraping the web, paying sites within configurable limits. Then perhaps we'll be one step closer to the dream of making the machines do all the work, while they pay each other magic internet money, and we can go have a beer.
