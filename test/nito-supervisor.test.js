'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
const supervisor = require('../lib/supervisor');
const {options} = require('../scripts/prestart');
const root = path.resolve(__dirname, '..');

test('startup requires the patched LTS and rejects unsupported operating modes before initialization', () => {
  for (const version of ['22.20.0', '24.14.0', '24.22.2', '25.0.0'])
    assert.throws(() => supervisor.checkNodeVersion(version), /Unsupported Node/);
  supervisor.checkNodeVersion('24.22.3');
  supervisor.checkNodeVersion('24.23.0');
  assert.deepEqual(options(['pm2 production']), {mode: 'pm2', environment: 'production'});
  assert.deepEqual(options(['pm2', 'development']), {mode: 'pm2', environment: 'development'});
  assert.throws(() => options(['forever', 'production']), /no longer supported/);
  assert.throws(() => options(['unknown']), /Usage/);
  assert.throws(() => options(['pm2', 'production;echo']), /Usage/);
});

test('retired Forever and automatic updater commands fail without touching services', async () => {
  for (const script of ['unsupported_forever.js', 'update_explorer.js']) {
    await assert.rejects(execute(process.execPath, [path.join(root, 'scripts', script)], {cwd: root}), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /no longer supported/);
      return true;
    });
  }
});

test('the pinned local PM2 starts, reloads and stops a process in an isolated PM2 home', {timeout: 60000}, async t => {
  // PM2 uses fixed named pipes on Windows even with a distinct PM2_HOME.
  // Refuse to run while any existing supervisor owns either pipe.
  if (process.platform === 'win32') {
    for (const socket of ['\\\\.\\pipe\\rpc.sock', '\\\\.\\pipe\\pub.sock']) {
      await new Promise((resolve, reject) => {
        const connection = net.connect(socket);
        connection.once('connect', () => {
          connection.destroy();
          reject(new Error('Supervisor test requires free PM2 Windows pipes; an existing PM2 service was left untouched.'));
        });
        connection.once('error', error => error.code === 'ENOENT' ? resolve() : reject(error));
      });
    }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nito-supervisor-'));
  const pidFile = path.join(directory, 'worker.pid');
  const worker = path.join(directory, 'worker.js');
  const name = 'nito-supervisor-test';
  const configPath = path.join(directory, 'ecosystem.config.js');
  await fs.writeFile(worker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const app = {...require('../ecosystem.config').apps[0], name, script: worker, cwd: directory, instances: 1};
  await fs.writeFile(configPath, 'module.exports = ' + JSON.stringify({apps: [app]}) + ';');
  const env = {...process.env, PM2_HOME: directory, PM2_SILENT: 'true', PM2_DISCRETE_MODE: 'true', PM2_DISABLE_VERSION_CHECK: 'true'};
  const cli = (...args) => execute(process.execPath, [path.join(root, 'scripts/pm2.js'), ...args], {cwd: root, env, timeout: 20000});
  t.after(async () => {
    const daemonPid = await fs.readFile(path.join(directory, 'pm2.pid'), 'utf8').catch(() => null);
    // A daemon PID in the unique, freshly created home establishes test ownership.
    if (daemonPid && /^\d+\s*$/.test(daemonPid)) await cli('kill');
    // The directory contains only this test's disposable supervisor files.
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'nito-supervisor-'));
    await fs.rm(directory, {recursive: true, force: true});
  });
  await cli('startOrReload', configPath, '--env', 'production');
  const list = async () => JSON.parse((await cli('jlist')).stdout.trim());
  let processes = await list();
  assert.equal(processes.length, 1);
  assert.equal(processes[0].name, name);
  assert.equal(processes[0].pm2_env.status, 'online');
  assert.equal(processes[0].pm2_env.NODE_ENV, 'production');
  assert.equal(processes[0].pm2_env.exec_mode, 'cluster_mode');
  const oldPid = processes[0].pid;
  assert.ok(oldPid > 0);
  await cli('reload', name);
  processes = await list();
  assert.equal(processes[0].pm2_env.status, 'online');
  assert.notEqual(processes[0].pid, oldPid);
  await cli('stop', name);
  processes = await list();
  assert.equal(processes[0].pm2_env.status, 'stopped');
  assert.equal(processes[0].pid, 0);
  await cli('delete', name);
  assert.deepEqual(await list(), []);
});
