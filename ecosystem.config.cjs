module.exports = {
  apps: [{
    name: 'dietfit-plan',
    script: 'dist/server.js',
    cwd: '/var/www/dietfit-plan',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};