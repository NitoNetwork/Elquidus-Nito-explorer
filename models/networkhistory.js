var mongoose = require('mongoose'),
   Schema = mongoose.Schema;

var NetworkHistorySchema = new Schema({
  chain: String,
  blockindex: {type: Number, default: 0, index: true},
  blockhash: String,
  nethash_hps: Number,
  nethash: { type: Number, default: 0 },
  nethash_unit: String,
  difficulty_pow: { type: Number, default: 0 },
  difficulty_pos: { type: Number, default: 0 },
  timestamp: { type: Number, default: 0 }
}, {id: false});

module.exports = mongoose.model('NetworkHistory', NetworkHistorySchema);
