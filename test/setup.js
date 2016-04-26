'use strict';

var path = require('path'),
    lo = require('lodash'),
    fs = require('fs'),
    schemaArgs = {
        dbConfig: { 
            driver: 'sqlite3',
            database: path.normalize(__dirname + '/botbouncer-test.db'), 
            busyTimeout: 3000
        }
    };

module.exports = {
    // initializes the db
    getSchema: function(args){
        var schema = require("../lib/schema")(args || schemaArgs);
        return schema;
    },
    schemaArgs: schemaArgs,
    removeDb: function(){
        var files = [
            schemaArgs.dbConfig.database, 
            schemaArgs.dbConfig.database + '-journal', 
            schemaArgs.dbConfig.database + '-shm',
            schemaArgs.dbConfig.database + '-wal'
        ];

        lo.forEach(files, function(file){
            try {
                fs.statSync(file).isFile();
                fs.unlinkSync(file);
            }
            catch (e) {
                // purposely empty
            }
        });
    }
};
