module.exports = {
  apps: [
    {
      name: 'kiro-openai-proxy',
      script: 'src/server.js',
      node_args: '--experimental-vm-modules',
      env: {
        NODE_ENV: 'production',
      },
      // .env is loaded by server.js, but PM2 env overrides take precedence
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
    },
  ],
};