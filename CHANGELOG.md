# Changelog

## [Build 2] — 2026-04-29
- Added breaking news ticker under the header: red "BREAKING" label, smooth horizontal CSS scroll, headlines link to source
- Added `/api/news` proxy endpoint to `server.js` (Google News AU RSS, 10-min server-side cache, JSON output)
- Ticker auto-refreshes every 12 minutes; pauses on hover; hides silently when `/api/news` is unreachable (so the Cloudflare Worker / GitHub Pages copy stays clean)

## [Build 1] — 2026-04-14
- Initial link page with quick links to all Thorley Park and Sorted projects
- Custom apple-touch-icon from TP fountain artwork for iPhone home screen bookmark
- Web app manifest for standalone home screen app experience
- Dark mode support
- Node.js static file server on port 3003
- LaunchAgent for auto-start on boot
- Cloudflare tunnel integration (home.thorleypark.com)
- Cross-Mac Mini tunnel routing (other Mac Mini proxies to this one)
