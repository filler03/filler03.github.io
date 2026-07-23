// pm2 config so the port is fixed and survives restarts/reboots.
// Start it with:  pm2 start ecosystem.config.js  &&  pm2 save
// Change the port in ONE place here, and match it in the nginx proxy_pass.
module.exports = {
  apps: [
    {
      name: 'soccer-mp',
      script: 'server.js',
      env: {
        PORT: 3200,
        HOST: '127.0.0.1'
      }
    }
  ]
};
