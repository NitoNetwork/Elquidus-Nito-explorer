'use strict';
const supervisor = require('../lib/supervisor');
try {
  supervisor.checkNodeVersion(process.versions.node);
  supervisor.run(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
