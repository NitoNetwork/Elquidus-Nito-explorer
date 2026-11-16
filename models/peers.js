var mongoose = require('mongoose'),
    Schema = mongoose.Schema;

var PeersSchema = new Schema({
  createdAt: { type: Date, expires: 86400, default: Date.now() },
  address: { type: String, default: "", index: true },
  port: { type: String, default: "" },
  network: { type: String, default: "" },
  protocol: { type: String, default: "" },
  version: { type: String, default: "" },
  country: { type: String, default: "" },
  country_code: { type: String, default: "" },
  geo_checked_at: { type: Date, default: null },
  geo_attempted_at: { type: Date, default: null }
});

// Deliberately non-unique: old databases can contain duplicate observations.
// They age out through the existing TTL while new writes use address+port.
PeersSchema.index({ address: 1, port: 1 }, { name: 'peer_lookup_idx', background: true });

module.exports = mongoose.model('Peers', PeersSchema);
