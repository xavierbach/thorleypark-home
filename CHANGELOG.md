# Changelog

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
