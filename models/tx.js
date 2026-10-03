var mongoose = require('mongoose'),
   Schema = mongoose.Schema;

var TxSchema = new Schema({
  schema_version: Number,
  block_tx_index: Number,
  privacy: String,
  metadata_complete: Boolean,
  fee_nitoshi: String,
  orchard: Schema.Types.Mixed,
  total_scope: String,
  size: Number,
  txid: { type: String, lowercase: true, unique: true, index: true},
  vin: { type: Array, default: [] },
  vout: { type: Array, default: [] },
  total: { type: Schema.Types.Decimal128, default: 0, index: true },
  timestamp: { type: Number, default: 0, index: true },
  blockhash: { type: String, index: true },
  blockindex: {type: Number, default: 0, index: true},
  tx_type: { type: String, default: null },
  op_return: { type: String, default: null },
  algo: { type: String, default: null }
}, {id: false});

TxSchema.index({total: 1, total: -1, blockindex: 1, blockindex: -1});

module.exports = mongoose.model('Tx', TxSchema);
