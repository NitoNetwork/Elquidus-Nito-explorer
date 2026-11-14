'use strict';

const actions = new Set(['backup', 'restore', 'delete']);
const action = process.argv[2];

if (!actions.has(action)) {
  console.error('Usage: node scripts/unsupported_database_maintenance.js <backup|restore|delete>');
  process.exitCode = 1;
} else {
  console.error(`Automated database ${action} is intentionally disabled; no data was changed.`);
  console.error('Use version-matched MongoDB Database Tools as a separate operator procedure.');
  console.error('Stop the explorer writer, keep credentials out of command-line arguments, and test restores on an isolated replica set.');
  console.error('See README.md: Database backup, restore and deletion.');
  process.exitCode = 1;
}
