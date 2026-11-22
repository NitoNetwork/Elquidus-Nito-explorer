#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const jsonminify = require('jsonminify');

const TESTNET_GENESIS = '00000000ddbcc1487e98d0e27fcc235129c543e6b6066df0cc0d157a0e02312b';
const TESTNET_LOGO = '/img/nito-testnet-page-title-green.png';
const TESTNET_FAUCET = 'https://testnet-faucet.nito.tools/';

function argumentsFrom(values) {
  let output = 'settings.testnet.json';
  let instanceMarker = '.nito-instance';
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--output') {
      output = values[++index];
      if (!output) throw new Error('--output requires a file path');
    } else if (value.startsWith('--output=')) {
      output = value.slice('--output='.length);
      if (!output) throw new Error('--output requires a file path');
    } else if (value === '--instance-marker') {
      instanceMarker = values[++index];
      if (!instanceMarker) throw new Error('--instance-marker requires a file path');
    } else if (value.startsWith('--instance-marker=')) {
      instanceMarker = value.slice('--instance-marker='.length);
      if (!instanceMarker) throw new Error('--instance-marker requires a file path');
    } else if (value === '--help') {
      return {help: true, output, instanceMarker};
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return {help: false, output: path.resolve(output), instanceMarker: path.resolve(instanceMarker)};
}

function readTemplate(filename = path.resolve(__dirname, '../settings.json.template')) {
  const source = fs.readFileSync(filename, 'utf8');
  return JSON.parse(jsonminify(source).replace(/,\s*([}\]])/g, '$1'));
}

function testnetSettings(template) {
  const settings = structuredClone(template);
  settings.dbsettings = {...settings.dbsettings,
    user: 'CHANGE_ME_TESTNET_DB_USER', password: 'CHANGE_ME_TESTNET_DB_PASSWORD', database: 'nito_explorer_testnet',
    auth_source: 'nito_explorer_testnet', address: '127.0.0.1', port: 27018};
  settings.wallet = {...settings.wallet, host: '127.0.0.1', port: 8845,
    username: 'CHANGE_ME_TESTNET_RPC_USER', password: 'CHANGE_ME_TESTNET_RPC_PASSWORD'};
  settings.webserver.bind = '127.0.0.1';
  settings.webserver.port = 3002;
  settings.webserver.tls.enabled = false;
  settings.webserver.tls.cert_file = '/etc/letsencrypt/live/testnet-explorer.nito.network/cert.pem';
  settings.webserver.tls.chain_file = '/etc/letsencrypt/live/testnet-explorer.nito.network/chain.pem';
  settings.webserver.tls.key_file = '/etc/letsencrypt/live/testnet-explorer.nito.network/privkey.pem';
  settings.network = {
    id: 'testnet', label: 'Testnet', enforce: true, expected_chain: 'test', expected_genesis: TESTNET_GENESIS,
    public_url: 'https://testnet-explorer.nito.network/', robots_noindex: true, allow_market_data: false,
    require_indexes: ['txindex', 'coinstatsindex'], require_synced: true, private_activation_height: 0,
    require_private_active: true, process_suffix: 'testnet', web_instances: 1, supervise_indexer: true,
    switch: {enabled: true, url: 'https://explorer.nito.network/', label: 'Mainnet'}
  };

  settings.markets_page.enabled = false;
  settings.markets_page.market_price = 'AVERAGE';
  for (const exchange of Object.values(settings.markets_page.exchanges || {})) exchange.enabled = false;

  settings.shared_pages.logo = TESTNET_LOGO;
  settings.shared_pages.favicons.favicon32 = TESTNET_LOGO.slice(1);
  settings.shared_pages.favicons.favicon128 = '';
  settings.shared_pages.favicons.favicon180 = '';
  settings.shared_pages.favicons.favicon192 = '';
  settings.shared_pages.page_header.home_link_logo = TESTNET_LOGO;
  settings.shared_pages.page_header.page_title_image.image_path = TESTNET_LOGO;
  settings.shared_pages.page_header.page_title_image.enable_animation = false;
  settings.shared_pages.page_header.bgcolor = 'success';
  settings.shared_pages.page_footer.bgcolor = 'success';
  if (!settings.shared_pages.page_footer.social_links.some(link => link.url === TESTNET_FAUCET)) {
    settings.shared_pages.page_footer.social_links.push({enabled: true, tooltip_text: 'Testnet Faucet',
      url: TESTNET_FAUCET, fontawesome_class: 'fa-solid fa-faucet-drip', image_path: ''});
  }
  for (const name of ['price_panel', 'usd_price_panel', 'market_cap_panel', 'usd_market_cap_panel']) {
    if (settings.shared_pages.page_header.panels[name]) settings.shared_pages.page_header.panels[name].enabled = false;
  }
  if (settings.shared_pages.page_header.panels.logo_panel) settings.shared_pages.page_header.panels.logo_panel.enabled = false;
  settings.api_page.show_logo = false;
  const hashChart = settings.shared_pages.page_header.network_charts.nethash_chart;
  hashChart.line_color = 'rgba(25, 135, 84, 1)';
  hashChart.fill_color = 'rgba(25, 135, 84, 0.2)';
  hashChart.crosshair_color = 'rgba(25, 135, 84, 0.8)';
  const difficultyChart = settings.shared_pages.page_header.network_charts.difficulty_chart;
  difficultyChart.pow_line_color = 'rgba(25, 135, 84, 1)';
  difficultyChart.pow_fill_color = 'rgba(25, 135, 84, 0.2)';
  difficultyChart.crosshair_color = 'rgba(25, 135, 84, 0.8)';
  return settings;
}

function writeSettings(output, settings) {
  fs.writeFileSync(output, JSON.stringify(settings, null, 2) + '\n', {encoding: 'utf8', flag: 'wx', mode: 0o600});
}

function validateInstanceMarker(filename) {
  if (!fs.existsSync(filename)) return;
  if (fs.readFileSync(filename, 'utf8').trim().toLowerCase() !== 'testnet')
    throw new Error(`Instance marker ${filename} does not identify testnet`);
}

function writeInstanceMarker(filename) {
  validateInstanceMarker(filename);
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, 'testnet\n', {encoding: 'utf8', flag: 'wx', mode: 0o644});
}

function main() {
  try {
    const options = argumentsFrom(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: npm run create-testnet-settings -- [--output /absolute/path/settings.testnet.json] [--instance-marker /checkout/.nito-instance]');
      return;
    }
    validateInstanceMarker(options.instanceMarker);
    writeSettings(options.output, testnetSettings(readTemplate()));
    try { writeInstanceMarker(options.instanceMarker); }
    catch (error) {
      fs.unlinkSync(options.output);
      throw error;
    }
    console.log(`Created testnet settings: ${options.output}`);
    console.log(`Recorded testnet instance marker: ${options.instanceMarker}`);
    console.log('Replace every CHANGE_ME_TESTNET_* value before starting the explorer. The file will never be overwritten by this command.');
  } catch (error) {
    console.error(`Unable to create testnet settings: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = {TESTNET_GENESIS, TESTNET_LOGO, TESTNET_FAUCET, argumentsFrom, readTemplate, testnetSettings,
  validateInstanceMarker, writeInstanceMarker, writeSettings};
