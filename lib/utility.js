var lo = require('lodash'),
    BigNumber = require('bignumber.js');

module.exports = {
    isNumeric: function(n){
        return !isNaN(parseFloat(n)) && isFinite(n);
    },
    isPositiveInteger: function(n) {
        return this.isInteger(n) && parseInt(n) > 0;
    },
    isPositiveIntegerOrZero: function(n) {
        return this.isPositiveInteger(n) || parseInt(n) === 0;
    },
    // passes big integer and big integer strings 
    isInteger: function(n) {
        if (! this.isNumeric(n)) return false;
        if (lo.isInteger(n)) return true;
        try{
        var bn = new BigNumber(n);
        return /^-?[0-9]+$/.test(''+bn.toFixed());
        }
        catch(e){
            return false;
        }
    }
};
