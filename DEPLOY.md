# FILLER site + Multiplayer — deploy bundle

Structure (drop these into your site's web root; your existing games/tools stay put):

```
index.html          ← homepage; the Multiplayer link points at /multiplayer/basketball/
multiplayer/
  basketball/       ← the game (self-contained Node app, zero dependencies)
```

## Deploy — nginx routes a subfolder to the app (no port in the URL)

1. Copy `index.html` (overwriting the old one) and the `multiplayer/` folder into your web root.

2. Start the game under pm2 (runs on port **3100**, set in `ecosystem.config.js`):

   ```bash
   cd /path/to/your-site/multiplayer/basketball
   pm2 start ecosystem.config.js
   pm2 save
   ```

3. Add this `location` block inside the `server { ... }` that serves your domain,
   then reload nginx. The players reach the game at `https://your-domain/multiplayer/basketball/`
   — no port number.

   ```nginx
   location /multiplayer/basketball/ {
       proxy_pass http://127.0.0.1:3100/;          # the TRAILING SLASH matters (see below)
       proxy_http_version 1.1;                      # required for WebSockets
       proxy_set_header Upgrade $http_upgrade;      # required for WebSockets
       proxy_set_header Connection "upgrade";       # required for WebSockets
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 3600s;                    # don't cut idle game sockets
   }
   ```

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

Verify the app is up behind the proxy:

```bash
curl -i http://127.0.0.1:3100/health                       # direct: 200 {"ok":true,...}
curl -i https://your-domain/multiplayer/basketball/health  # via nginx: 200 {"ok":true,...}
```

## Two things that must line up

- **Trailing slashes.** The link, the nginx `location`, and the `proxy_pass` all end in `/`.
  - The `location /multiplayer/basketball/` + `proxy_pass http://127.0.0.1:3100/;` (with the slash)
    strips the prefix, so the Node app sees `/`, `/ws`, `/manifest.webmanifest` — exactly what it serves.
  - The homepage links to `/multiplayer/basketball/` **with** the trailing slash. Without it, the
    game builds the wrong WebSocket URL and won't connect. (If you want, add a redirect so
    `/multiplayer/basketball` → `/multiplayer/basketball/`.)

- **WebSocket headers.** The three `Upgrade`/`Connection`/`http_version` lines above are what let the
  live game socket work. Without them you'll load the page but the match never starts.

Because it's now same-origin behind your domain, an HTTPS site serves the game over `https`/`wss`
automatically — no more "Not secure", and no port in the address bar.

## Changing the port

Set it in one place — `multiplayer/basketball/ecosystem.config.js` — and match it in the
nginx `proxy_pass` line.

## Note

Your homepage is unchanged except for the Multiplayer section. The pre-existing "Worms" link still
points at `games/orbit/orbit.html` (looked like a typo, left as-is).
