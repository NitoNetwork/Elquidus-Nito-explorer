'use strict';
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const supervisor = require('../lib/supervisor');

function options(args) {
  const words = args.flatMap(arg => arg.split(/\s+/)).filter(Boolean);
  if (words[0] === 'forever') throw new Error(supervisor.foreverMessage);
  if (words.length > 2 || (words.length && !['node', 'pm2'].includes(words[0])) ||
      (words[1] && !['production', 'development'].includes(words[1])))
    throw new Error('Usage: node scripts/prestart.js [node|pm2] [production|development]');
  return {mode: words[0] || 'node', environment: words[1] || 'development'};
}

function main() {
  try {
    supervisor.checkNodeVersion(process.versions.node);
    const config = options(process.argv.slice(2));
    // Resolve before any database or asset work; startup never downloads packages.
    if (config.mode === 'pm2') supervisor.localCli();
    execFileSync(process.execPath, [path.join(__dirname, 'compile_css.js')], {stdio: 'inherit'});
    const db = require('../lib/database');
    db.connect(null, () => {
      db.initialize_data_startup(() => {
        try {
          if (config.mode === 'pm2')
            supervisor.run(['startOrReload', path.resolve(__dirname, '../ecosystem.config.js'), '--env', config.environment]);
          process.exit(0);
        } catch (error) {
          console.error(error.message);
          process.exit(1);
        }
      });
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = {options};
