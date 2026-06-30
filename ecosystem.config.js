module.exports = {
  apps: [{
    name:        'knobitz-server',
    script:      'server/index.js',
    instances:   1,
    exec_mode:   'fork',
    autorestart: true,
    watch:       false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
    },
    error_file:  '/data01/virt149225/logs/knobitz-error.log',
    out_file:    '/data01/virt149225/logs/knobitz-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
