# Thorley Park Home — Link Page

## What
Central link page for all Thorley Park and Sorted projects. Accessible remotely as an iPhone home screen bookmark.

## Tech Stack
- Static HTML/CSS/JS (single page, no frameworks)
- Node.js HTTP server (port 3003)
- Cloudflare tunnel: home.thorleypark.com

## How to Run
```
node server.js          # default port 3003
PORT=3005 node server.js  # custom port
```

## Deployment
- MacBook Pro (192.168.1.13): serves the page on port 3003
- Tunnel on MacBook Pro: home.thorleypark.com → localhost:3003
- Tunnel on Mac mini: home.thorleypark.com → 192.168.1.13:3003
- LaunchAgent: com.thorleypark.home.plist
- Cloudflare tunnel: thorleypark-budget (shared with budget + chores)

## URLs
- https://home.thorleypark.com

## Links Included
- thorleypark.com (GitHub Pages)
- budget.thorleypark.com (local Mac Mini, port 8081)
- chores.thorleypark.com (other Mac Mini, port 3001)
- chores.thorleypark.com/kid
- chores.thorleypark.com/dingobutton
- sortedapp.io (GitHub Pages)
- money.sortedapp.io (GitHub Pages)

## Adding New Links
Edit `index.html` — add a new `<a class="link-card">` block in the "New Projects" section.

## iPhone Home Screen
- apple-touch-icon: custom fountain garden artwork (180x180)
- Theme color: #1a3a0a (Thorley Park green)
- Web app manifest enables standalone mode (no Safari chrome)

## Timelapse (timelapse/)
Separate local web app in `timelapse/`: captures 4K frames from IP cameras on a schedule and
renders MP4 timelapses. Own Node server (port 3006, zero deps, ffmpeg via Homebrew), own
LaunchAgent (`com.thorleypark.timelapse.plist`), no login, reachable on the LAN and over Tailscale
(http://100.106.18.20:3006, the address the home-page card uses). The Pro's LAN IP is DHCP-assigned
(192.168.1.57 as of Sep 2026, earlier notes say .13), so prefer the Tailscale IP or
`xaviers-macbook-pro.local`. Cameras are the 12 Reolink NVR channels (4K main streams).
See `timelapse/README.md`.
- Run: `cd timelapse && PORT=3006 node server.js`
- Install service: `timelapse/scripts/install-launchagent.sh`
- Data: `~/TimelapseData` (frames, videos); secrets in `timelapse/config/` (gitignored)
- Smoke test: `timelapse/scripts/smoke.sh`
