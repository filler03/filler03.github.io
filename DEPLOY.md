# FILLER site + Multiplayer — deploy bundle

Structure (drop these into your site's web root; your existing games/tools stay put):

```
index.html          ← homepage; the Multiplayer link points straight at the game's port
multiplayer/
  basketball/       ← the game (self-contained Node app, zero dependencies)
```

## Deploy — no nginx proxy needed

1. Copy `index.html` (overwriting the old one) and the `multiplayer/` folder into your web root.

2. Start the game under pm2 (it runs on port **3100**, set in `ecosystem.config.js`):

   ```bash
   cd /path/to/your-site/multiplayer/basketball
   pm2 start ecosystem.config.js
   pm2 save
   ```

3. Open port 3100 to the internet so people can reach the game directly:

   ```bash
   sudo ufw allow 3100/tcp        # if you use ufw
   # also allow inbound TCP 3100 in any cloud/hPanel firewall your VPS has
   ```

That's it. The homepage's Multiplayer button opens `http://<your-domain>:3100/` — the
link fills in your domain automatically from whatever address the homepage is on. The
game serves its own page **and** its WebSocket on that single port, so it's same-origin
with no CORS and nothing for nginx to route.

Verify the app is up:

```bash
curl -i http://127.0.0.1:3100/health     # expect 200  {"ok":true,...}
```

## If your site uses HTTPS, read this

Hitting a raw port is plain HTTP, so on an HTTPS site the game page will show
"Not secure" in the address bar. It still works — the game's WebSocket runs over
`ws://` on that same port — but two things can bite:

- Some browsers warn when navigating from an `https://` page to an `http://` one.
- If your domain uses **HSTS**, the browser will force `https://…:3100` and fail,
  because the app speaks HTTP (not HTTPS) on that port.

If either happens, the clean fix is the nginx reverse proxy after all — it keeps
everything same-origin HTTPS. That's documented in `multiplayer/basketball/README.md`;
you'd also change the homepage link back to `/multiplayer/basketball/`.

## Changing the port

Set it in one place — `multiplayer/basketball/ecosystem.config.js` — and update the
`:3100` in the link script at the bottom of `index.html` to match.

## Note

Your homepage is unchanged except for the new Multiplayer section (the pre-existing
"Worms" link still points at `games/orbit/orbit.html` — looked like a typo, but I left
your file as-is).
