# Revert to the relay (browser-authoritative) version

This folder holds the previous version, where the HOST's browser ran the physics
and the server only relayed messages. To go back to it:

    cp _relay-backup/server.js  server.js
    cp _relay-backup/rooms.js   rooms.js
    cp _relay-backup/index.html public/index.html
    rm -f game.js                       # only used by the server-authoritative version
    pm2 restart basketball-mp --update-env

That's it — the URL, port, and nginx config are unchanged.
