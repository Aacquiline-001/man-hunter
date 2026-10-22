# Pursuit — real-world hide-and-seek in the browser

A web game inspired by the mechanics in Scram:

- **Zone**: the host taps the map to place a circular zone and sets its radius.
- **Head start**: runners get 3 minutes. Hunters see a "hold tight" screen during that time.
- **Hidden**: runners never appear on the hunters' map…
- **Ping**: …except every 2 minutes, when hunters see every runner's position.
- **Ghosts**: a ping only shows where you *were*. Keep moving and hunters chase a ghost. Runners see their own ghost next to their real position.
- **Squeeze**: the zone shrinks by 20% every 5 minutes. A runner who stays outside it for 30 s becomes *live* (visible all the time) until they get back in.
- **Tag**: a hunter within 25 m presses TAG. Runners can also press "I was tagged". Hunters win if every runner is caught. Runners win if anyone is still free after 30 minutes.

Also included: a 7-slide how-to-play intro, 4-letter game codes with share links, bot players for solo testing, a 6× demo speed, and reconnect after a refresh.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open it in two browser tabs (or two phones) to play. One tab hosts; the other joins with the code.

## Testing without walking around

- Tap **Tap moves me** in the lobby, or just tap the map once GPS is off. Your player walks to the spot you tapped.
- Add bot runners and hunters, and tick **Demo speed** so a full game takes about 5 minutes.

## Playing on phones with real GPS

Browsers only allow GPS on **HTTPS** (or `localhost`). To play outside:

- Deploy to Render, Railway, or Fly.io. They give you HTTPS automatically. Then set the start command to `npm start`.
- Or, for a quick test, run a tunnel like `npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000` and open the HTTPS URL on each phone.

## Tuning

All the timings live in `CFG` at the top of `server.js` (head start, game length, ping interval, shrink interval and factor, outside-zone grace period, and tag distance).

## Structure

```
server.js          game server. It holds all the timers and decides what each player is allowed to see.
public/index.html  screens: home, intro, lobby, HUD, game over
public/style.css
public/app.js      Leaflet map, GPS/simulated movement, rendering, intro animation
```

The server sends each player only what their role should see, so hunters can't read runners' positions from the network traffic between pings.
