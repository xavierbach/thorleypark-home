# Changelog

## [Build 4] — 2026-09-17
- New `timelapse/` app: local timelapse camera system for the outdoor IP cameras (own Node server on port 3006, no npm deps, ffmpeg via Homebrew)
- Cameras: RTSP or HTTP snapshot sources with a Test button, passwords stored locally and masked in the UI
- Jobs: start/end, one or more cameras, capture interval, optional daily window (fixed hours or sunrise to sunset), playback fps or target length
- Interim "render up to now" while capture continues; automatic final 4K H.264 MP4 at the end; inline playback and download
- iMessage alerts when a video is ready, when a camera keeps failing, and when disk runs low
- Per-camera frame browser and zip download of all frames; capture log with gap detection; restart-safe scheduler
- LaunchAgent, install script, smoke test script; Timelapse link card on the home page

## [Build 3] — 2026-05-03
- Thorley Park section: removed Chores and Dingo &amp; Fox; added Hannah&rsquo;s Itinerary (thorleypark.com/julytrip) and Wimbledon Trip (thorleypark.com/wimbledon2026)
- Renamed &ldquo;Sorted&rdquo; section to &ldquo;Apps&rdquo;; added Bucko link (getbucko.com)
- Cleaned unused `.icon-chores` / `.icon-kid` CSS; added `.icon-trip`, `.icon-wimbledon`, `.icon-bucko`

## [Build 2] — 2026-04-29
- Added live news ticker under the header: red "NEWS" label, smooth horizontal CSS scroll, headlines link to source
- Added `/api/news` proxy endpoint to `server.js` (Google News AU RSS, 10-min server-side cache, JSON output)
- Ticker auto-refreshes every 15 minutes; pauses on hover; falls back to "News unavailable" text when `/api/news` is unreachable (e.g. on the GitHub Pages copy with no Node backend)

## [Build 1] — 2026-04-14
- Initial link page with quick links to all Thorley Park and Sorted projects
- Custom apple-touch-icon from TP fountain artwork for iPhone home screen bookmark
- Web app manifest for standalone home screen app experience
- Dark mode support
- Node.js static file server on port 3003
- LaunchAgent for auto-start on boot
- Cloudflare tunnel integration (home.thorleypark.com)
- Cross-Mac Mini tunnel routing (other Mac Mini proxies to this one)
