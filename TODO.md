# TODO

## Up Next
- Timelapse: Cloudflare tunnel (timelapse.thorleypark.com) with Cloudflare Access in front, since the app has no login of its own
- Timelapse: side-by-side multi-camera composite video; optional deflicker filter
- Add new project links as they come online
- Port `/api/news` to the Cloudflare Worker so the home.thorleypark.com edge copy also shows the ticker (currently only the local MacBook Pro server has it)

## Done
- [x] Timelapse app (`timelapse/`): cameras, scheduled 4K capture, daily/sun windows, interim + final renders, iMessage alerts, frame zip, LaunchAgent
- [x] Refresh links: removed Chores/Dingo&Fox; added Hannah&rsquo;s Itinerary, Wimbledon Trip, Bucko; renamed Sorted section to Apps
- [x] Create link page with all project links
- [x] iPhone home screen icon (custom fountain artwork)
- [x] Web app manifest for standalone mode
- [x] Node.js server + LaunchAgent
- [x] Cloudflare tunnel setup (home.thorleypark.com)
- [x] Cross-Mac Mini tunnel routing
- [x] Live news ticker (Google News AU via `/api/news` proxy in server.js)
