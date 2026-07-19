# FILLER site + Multiplayer — deploy bundle

This bundle is laid out **exactly as it sits at your site's web root**. It's an
*overlay* onto your existing site — it contains only the two things that change:

```
index.html                 ← updated homepage (adds a "Multiplayer" section)
multiplayer/
  basketball/              ← the new 2-player game (self-contained Node app)
    server.js, ws-lite.js, rooms.js, package.json, public/index.html, ...
```

Your existing `games/`, `tools/`, `test/`, etc. are **not** included — leave them
where they are. Only drop these two items into the web root.

## Deploy

1. **Copy** `index.html` (overwriting the old homepage) and the `multiplayer/`
   folder into your site's web root on the VPS.

2. **Start the game server** under pm2 (it has zero dependencies — nothing to
   `npm install`):

   ```bash
   cd /path/to/your-site/multiplayer/basketball
   PORT=3000 pm2 start server.js --name basketball-mp
   pm2 save
   ```

3. **Reverse-proxy it** by adding this to your site's `server { ... }` in nginx
   (full explanation in `multiplayer/basketball/README.md`):

   ```nginx
   location /multiplayer/basketball/ {
       proxy_pass http://127.0.0.1:3000/;   # trailing slash strips the prefix
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_read_timeout 3600s;
   }
   ```

4. **Reload nginx:** `sudo nginx -t && sudo systemctl reload nginx`

The homepage's Multiplayer button points at `/multiplayer/basketball/`, which nginx
routes to the Node app. Static files (homepage, existing games) are still served
directly by nginx.

## Note

The homepage is your existing file, unchanged except for the new Multiplayer
section — including the pre-existing "Worms" link, which still points at
`games/orbit/orbit.html` (looked like a typo for `games/worms/worms.html`, but I
left your file as-is).
