var mongoose = require('mongoose'),
    Schema = mongoose.Schema;

var StatsSchema = new Schema({
  schema_version: Number,
  pools: Schema.Types.Mixed,
  supply_scope: String,
  coin: { type: String },
  count: { type: Number, default: 1 },
  last: { type: Number, default: 1 },
  supply: { type: String, default: null },
  txes: { type: Number, default: 0 },
  connections: { type: Number, default: 0 },
  last_price: { type: Number, default: null },
  last_usd_price: { type: Number, default: null },
  market_price_stale: { type: Boolean, default: true },
  market_price_last_success_at: { type: Number, default: null },
  market_price_last_attempt_at: { type: Number, default: null },
  market_price_error: { type: String, default: null },
  blockchain_last_updated: { type: Number, default: 0 },
  reward_last_updated: { type: Number, default: 0 },
  masternodes_last_updated: { type: Number, default: 0 },
  network_last_updated: { type: Number, default: 0 },
  richlist_last_updated: { type: Number, default: 0 },
  markets_last_updated: { type: Number, default: 0 },
  orphan_index: { type: Number, default: 0 },
  orphan_current: { type: Number, default: 0 },
  newer_claim_address: { type: Boolean, default: false }
});

module.exports = mongoose.model('coinstats', StatsSchema);
