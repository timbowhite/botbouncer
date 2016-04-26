'use strict';
var httpMocks = require('node-mocks-http'),
    lo = require('lodash'),
    fs = require('fs'),
    Q = require('q'),
    browserDetail = require('./browsers-detail.json'),  
    bitcorelib = require('bitcore-lib'),
    basereq = {
        method: 'GET',
        url: 'https://reddit.com/path/to/nowhere?foo=123&bar=666',
        protocol: 'https',
        headers: {
            host: 'reddit.com',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.5',
            'accept-encoding': 'gzip, deflate',
            connection: 'keep-alive',
            cookie: 'NSFW=74=E-dWsr7ug7X9U-Eq4k3QIKlnJddy0m1clfHe-rXIrDeT9Wyed3MpMRivBLYQ5kfPqV7aBmIAKNsQ1lXKJOWb9-rk1zrxmF_i4X-Xvgd6eBNfOhKMGBxgnohBNI0mSJ8LBSgIGJWH0kwlUEM; OGPC=5061451-4:; OR=Qj_PS0D530cSDIr4Q8ld4fV-4Hl2owI'
        }
    },
    agent = { 
        bot:{
            // valid
            googlebot: {
                ip: '66.249.73.143',
                headers: {
                    'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                }
            },
            googleadsense: {
                ip: '66.249.90.105',
                headers: {
                    'user-agent': 'Mediapartners-Google' 
                }
            },
            bingbot: {
                ip: '157.55.39.105',
                headers: {
                    'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 
                }
            }, 
            yahoo: {
                ip: '66.228.160.1',
                headers: {
                    'user-agent': 'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)'
                }
            },
            yandexbot: {
                ip: '141.8.143.211',
                headers: {
                    'user-agent': 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 
                }
            }, 
            baidu: {
                ip: '180.76.15.25',
                headers: {
                    'user-agent': 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', 
                }
            }
        },
        browser: browserDetail,  // see browsers-detail.json
        // misc crap, TODO arrange maybe arrange with browserDetail above 
        misc: {
            // old user agent strings that should fail botbouncer's default ua-version detector settings
            oldua: {
                'internet explorer 6': [
                    'Mozilla/4.0 (Compatible; Windows NT 5.1; MSIE 6.0) (compatible; MSIE 6.0; Windows NT 5.1; .NET CLR 1.1.4322; .NET CLR 2.0.50727)',
                    'Mozilla/4.0 (X11; MSIE 6.0; i686; .NET CLR 1.1.4322; .NET CLR 2.0.50727; FDM)',
                    'Mozilla/5.0 (Windows; U; MSIE 6.0; Windows NT 5.1; SV1; .NET CLR 2.0.50727)',
                    'Mozilla/5.0 (compatible; MSIE 6.0; Windows NT 5.1)',
                ],
                'internet explorer 6.1': [
                    'Mozilla/4.0 (compatible; MSIE 6.1; Windows XP; .NET CLR 1.1.4322; .NET CLR 2.0.50727)',
                    'Mozilla/4.0 (compatible; MSIE 6.1; Windows XP)'
                ],
                'internet explorer 7': [
                    'Mozilla/5.0 (compatible; MSIE 7.0; Windows NT 6.0; WOW64; SLCC1; .NET CLR 2.0.50727; Media Center PC 5.0; c .NET CLR 3.0.04506; .NET CLR 3.5.30707; InfoPath.1; el-GR)',
                    'Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.1; Trident/6.0; SLCC2; .NET CLR 2.0.50727; .NET CLR 3.5.30729; .NET CLR 3.0.30729; .NET4.0C; .NET4.0E)',
                    'Mozilla/5.0 (Windows; U; MSIE 7.0; Windows NT 6.0; en-US)',
                ],
                'internet explorer 7.0b': [
                    'Mozilla/4.0 (compatible; MSIE 7.0b; Windows NT 5.1; .NET CLR 1.0.3705; Media Center PC 3.1; Alexa Toolbar; .NET CLR 1.1.4322; .NET CLR 2.0.50727)',
                    'Mozilla/5.0 (Windows; U; MSIE 7.0; Windows NT 6.0; en-US)',
                ],
                'firefox 29' :[
                    'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:29.0) Gecko/20120101 Firefox/29.0',
                ],
                'firefox 28' :[
                    'Mozilla/5.0 (X11; Linux x86_64; rv:28.0) Gecko/20100101 Firefox/28.0' 
                ],
                'firefox 22' :[
                    'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:22.0) Gecko/20130328 Firefox/22.0',
                ],
                'firefox 13.0.1': [
                    'Mozilla/5.0 (Windows NT 5.1; rv:15.0) Gecko/20100101 Firefox/13.0.1'
                ],
                'firefox 7': [
                    'Mozilla/5.0 (Windows NT 6.1; rv:6.0) Gecko/20100101 Firefox/7.0'
                ],
                'firefox 4.0b13pre': [
                    'Mozilla/5.0 (Windows NT 5.1; rv:2.0b13pre) Gecko/20110223 Firefox/4.0b13pre'
                ],
                'firefox 3.6b5': [
                    'Mozilla/5.0 (Windows; U; Windows NT 6.1; en-US; rv:1.9.2b5) Gecko/20091204 Firefox/3.6b5'
                ],
                'chrome 0.2.153.1': [
                    'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US) AppleWebKit/525.19 (KHTML, like Gecko) Chrome/0.2.153.1 Safari/525.19'
                ],
                'chrome 0.2': [
                    'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US) AppleWebKit/525.13 (KHTML, like Gecko) Chrome/0.2.149.27 Safari/525.13',
                    'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US) AppleWebKit/525.19 (KHTML, like Gecko) Chrome/0.2.153.1 Safari/525.19'
                ],
                'chrome 2': [
                    'Mozilla/5.0 (Windows; U; Windows NT 6.0; en-US) AppleWebKit/530.7 (KHTML, like Gecko) Chrome/2.0.176.0 Safari/530.7',
                    'Mozilla/5.0 (Windows; U; Windows NT 6.1; en-US) AppleWebKit/531.0 (KHTML, like Gecko) Chrome/2.0.182.0 Safari/531.0'
                ],
                'chrome 4': [
                    'Mozilla/5.0 (X11; U; Linux x86_64; en-US) AppleWebKit/532.0 (KHTML, like Gecko) Chrome/4.0.206.0 Safari/532.0',
                    'Mozilla/5.0 (Windows; U; Windows NT 6.1; en-US) AppleWebKit/532.3 (KHTML, like Gecko) Chrome/4.0.227.0 Safari/532.3'
                ],
                'chrome 9': [
                    'Mozilla/5.0 (Windows U Windows NT 5.1 en-US) AppleWebKit/534.12 (KHTML, like Gecko) Chrome/9.0.583.0 Safari/534.12'
                ],
                'chrome 18': [
                    'Mozilla/5.0 (X11; CrOS i686 1660.57.0) AppleWebKit/535.19 (KHTML, like Gecko) Chrome/18.0.1025.46 Safari/535.19'
                ],
                'chrome 22': [
                    'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.2 (KHTML, like Gecko) Chrome/22.0.1216.0 Safari/537.2'
                ],
                'chrome 30': [
                    'Mozilla/5.0 (Windows NT 6.2; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/30.0.1599.17 Safari/537.36'
                ],
                'chrome 31': [
                    'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1623.0 Safari/537.36',
                ]
            } 
        }
    },
    ip = {
        private: [
            '10.0.0.1', 
            '10.255.255.255',
            '100.64.0.1', 
            '100.127.255.255',
            '172.16.0.1',
            '172.31.255.255',
            '192.0.0.1',
            '192.168.56.1',
            '192.0.0.255',
            '127.0.0.1',
            '::1',
            'fc00::',
            'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
        ],
        bogus: [
            'foobar',
            '໒( • ͜ʖ • )७',
            '256.256.256.256',
            'fd12:3456:789a:1::1'
        ]
    },
    createRequests = function(obj, i){
        if (! i) i = 0;
        i++;

        if (obj.headers){
            var br = lo.cloneDeep(basereq);
            lo.merge(br, obj);
            obj = httpMocks.createRequest(br);
            return obj;
        }
        for(var k in obj){
            // only operate on the bot/browser top-level keys
            if (i === 1 && (! lo.includes(['bot', 'browser'], k))) continue;
            obj[k] = createRequests(obj[k], i);
        }
        return obj;
    },
    /**
     * Returns a random browser user agent id (keys from mockreq.browser); 
     * 
     * @return {string}
     */
    getRandomBrowserUserAgentId = function(){
        var ids = Object.keys(agent.browser), 
            idx = lo.random(0, ids.length - 1);

        return ids[idx]; 
    },
    /**
     * Returns X amount of random browser request objects in an array. 
     * If opt.count === 1, then a single browser request object will be returned (not in an array) 
     * 
     * @param {object} [opt]
     * @param {int} [opt.count]         how many, default = 1. If count = 0, will return all of them.
     * @param {sttring} [opt.family]    browser family to retrieve (case insensitive), see ua-version-family-list.txt
     * @return {mixed}                  array or object
     */
    // TODO: change this to getRandomRequest, ust read in the fucking JSON file every time
    getRandomBrowserRequest = function(opt){
        opt = opt || {};
        lo.defaults(opt, {count: 1, family: null});

        var browsers = agent.browser;

        if (typeof(opt.family) === 'string'){
            opt.family = opt.family.toLowerCase(); 
            browsers = lo.filter(browsers, function(b){ return b.family && b.family.toLowerCase() === opt.family; });
        }

        var ret;
        if (! opt.count) ret = browsers; 
        else{
            ret = lo.sampleSize(browsers, opt.count);
            ret = (ret.length === 1) ? ret[0] : ret; 
        }

        return lo.cloneDeep(ret);
    },
    /**
     * Returns a big array of bot user agents strings from the isbot module 
     * 
     * @return {object}     promise object, resolves with array
     */
    getBotUserAgentStrings = function(){
        var uas = fs.readFileSync(__dirname + '/../node_modules/isbot/crawlers.txt', 'utf8').split("\n");
        return lo.uniq(lo.remove(uas));
    },
    /**
     * Returns a big array of browser user agents strings from the isbot module 
     * 
     * @return {object}     promise object, resolves with array
     */
    getBrowserUserAgentStrings = function(){
        var uas = fs.readFileSync(__dirname + '/../node_modules/isbot/browsers.txt', 'utf8').split("\n");
        return lo.uniq(lo.remove(uas));
    },
    getRandomHdPubKey = function(){
        // TODO: add more?
        return 'xpub661MyMwAqRbcFr8FYCsf2vvu3BEkeREzwDo5E3C4R22v3cFTv6BsWheenXX3DAtXr5fyDP3qV6LGxhhzQHUsyyfz7bpqdHAX5jExnBuHx8j'; 
    },
    deriveAddressFromHdPubKey = function(hdpubkey, idx, network){
        var hdpk = bitcorelib.HDPublicKey(hdpubkey);
        var publicKey = hdpk.derive(0).derive(idx).toObject().publicKey;
        var pk = new bitcorelib.PublicKey(publicKey);
        var address = pk.toAddress(network);
        return address.toString()
    },
    getBitcoinZombieAddresses = function(){
        return {
            paid:{
            '1JCeMgVeDzLdxz3G5vRin2ydNxUp6E5yFf': 20000000000,
            '1CzJQHjyQshJbXwfLZJdh8pcfLi4bbMfPW': 25374000000,
            '19bdnnnKHRzMp6VbPMSxxmpQfEvfJf2P8K': 14010000000,
            '17MAF6XSJ9vQSkog69bUAqakToNzXnkWbz': 27939636441,
            '1BY3aX7cyQWdZkm9chtw3qTJtt87mWede4': 22494000000,
            '1LNKBdzwXmisa67qtYCofsZWwgZW2wewmn':  5000000000,
            '1EncfvybmZe4hXMgkFgfAcbhF9kGxTXM68':  5000000000,
            },
            unpaid: {
            '1FkQFSt7ZGEPazBnK1DQjmvXGvLByNRCcu':  4837700000,
            '1DLSTsqbcSdwTEx9vyCMmdwuD6vZq3Yaeh':  3325942350,
            '1B8Qpydg1n6HESTa7LFAQecGaj7UiwGo5x':  2872950000,
            '1KrbG3xPKzgvKzhBuwXwtpoTHVd8wsxNZL':  2671000000,
            '1MykZKxFhB9kEdDrsoKccA72gju8fA6dUU':           0,
            '1G7X6itUt7DHKxZrWS4Rak6JjzoJEysPX':            0,
            '19am4P4vbBKDkwdv5R7gLUN27GmGCTmFAh':           0,
            '114Lq5uHvieqLpdymXc7C83PSgtjPxiThV':           0,
            '17t7QQSFgqSYWvJnto62a3HD7Br3HYLFDe':           0,
            '1HqBGqYAiyW5K8Tf9Y4bH9mzJ8eLSLRwr1':           0
            }
        };
    }; 

// create mock requests (basereq merged with agent)
agent = createRequests(agent);

module.exports = {
    agent: agent, 
    getBotUserAgentStrings: getBotUserAgentStrings,
    getBrowserUserAgentStrings: getBrowserUserAgentStrings,
    getRandomBrowserUserAgentId: getRandomBrowserUserAgentId,
    getRandomBrowserRequest: getRandomBrowserRequest,
    getRandomHdPubKey: getRandomHdPubKey,
    deriveAddressFromHdPubKey: deriveAddressFromHdPubKey,
    getBitcoinZombieAddresses: getBitcoinZombieAddresses,
    basereq: basereq, 
    ip: ip
};
