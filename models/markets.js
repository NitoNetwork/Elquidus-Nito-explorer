var mongoose = require('mongoose'),
    Schema = mongoose.Schema;

var MarketsSchema = new Schema({
  market: { type: String, index: true },
  coin_symbol: { type: String },
  pair_symbol: { type: String },
  summary: { type: Object, default: {} },
  chartdata: { type: Array, default: [] },
  buys: { type: Array, default: [] },
  sells: { type: Array, default: [] },
  history: { type: Array, default: [] },
  last_success_at: { type: Number, default: null },
  last_attempt_at: { type: Number, default: null },
  last_error: { type: String, default: null },
  stale: { type: Boolean, default: true },
});

module.exports = mongoose.model('Markets', MarketsSchema);
