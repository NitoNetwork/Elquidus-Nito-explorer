module.exports = {
  apps: [{
    name: 'nito-explorer',
    script: './bin/instance',
    cwd: '/opt/explorer-eIquidus-NITO',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1024M'
  }]
};
