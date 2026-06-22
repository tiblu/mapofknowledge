module.exports = {
  apps: [{
    name:        'knobitmap-server',
    script:      'server/index.js',
    instances:   1,
    exec_mode:   'fork',
    autorestart: true,
    watch:       false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT:     3001,
    },
    error_file:  '/data01/virt147958/logs/knobitmap-error.log',
    out_file:    '/data01/virt147958/logs/knobitmap-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
