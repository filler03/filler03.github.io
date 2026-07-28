# Deployment

## Static Site (GitHub Pages)

The `public/` directory is deployed via **GitHub Pages**. Deployment is automatic on push — no build step.

- Push changes to the repo → site updates at `https://filler03.github.io/`
- All files are served as-is (HTML, CSS, JS, images)
- **No server-side processing** — PHP files in `sandbox/` will not execute

## Multiplayer Servers (VPS)

Both multiplayer apps run on a VPS under **pm2** and are reverse-proxied through **nginx** so they appear under the site's domain without exposed port numbers.

### Ports

| App | Port | pm2 Name | URL Path |
|-----|------|----------|----------|
| Basketball | 3100 | `basketball-mp` | `/multiplayer/basketball/` |
| Soccer | 3200 | `soccer-mp` | `/multiplayer/soccer/` |

### Starting / Restarting

```bash
# Start
cd apps/basketball && pm2 start ecosystem.config.js && pm2 save
cd apps/soccer && pm2 start ecosystem.config.js && pm2 save

# Restart after code changes
pm2 restart basketball-mp --update-env
pm2 restart soccer-mp --update-env
```

### nginx Configuration

Each app needs a `location` block in the site's `server { ... }`:

```nginx
# Basketball
location /multiplayer/basketball/ {
    proxy_pass http://127.0.0.1:3100/;       # trailing slash strips prefix
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # required for WebSocket
    proxy_set_header Connection "upgrade";    # required for WebSocket
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;                 # don't cut idle game sockets
}

# Soccer
location /multiplayer/soccer/ {
    proxy_pass http://127.0.0.1:3200/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
}
```

After editing nginx config:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Critical Details

- **Trailing slashes matter.** Both the `location` path and `proxy_pass` URL must end in `/`. This strips the prefix so Node sees `/`, `/ws`, `/health`.
- **WebSocket headers required.** The `Upgrade`, `Connection`, and `proxy_http_version 1.1` lines enable WebSocket passthrough. Without them, the page loads but the game won't connect.
- **Same-origin benefit.** Because everything goes through the domain's HTTPS, the game automatically uses `wss://` — no mixed-content warnings.

### Health Checks

```bash
# Direct
curl -i http://127.0.0.1:3100/health
curl -i http://127.0.0.1:3200/health

# Via nginx
curl -i https://your-domain/multiplayer/basketball/health
curl -i https://your-domain/multiplayer/soccer/health
```

Both return `{"ok": true, ...}`.

### Changing Ports

Set the port in the app's `ecosystem.config.js` and match it in the nginx `proxy_pass` line.
