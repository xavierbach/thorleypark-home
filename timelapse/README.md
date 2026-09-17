# Thorley Park Timelapse

Local web app that captures full-resolution (4K) frames from the IP cameras around the house on a
schedule and stitches them into MP4 timelapses. Runs on the MacBook Pro, home network only.

- Pick cameras, a start and end date, a capture interval and an optional daily window
  (fixed hours, or sunrise to sunset for the configured location).
- Frames are saved as JPEGs. At any point you can ask for a video "up to now" without
  interrupting capture. When the job ends the final video is rendered automatically.
- You get an iMessage when a video is ready or a camera keeps failing.
- Every frame can be browsed and downloaded, per camera, as a zip.

Zero npm dependencies. Everything external is a macOS or Homebrew binary: `ffmpeg`/`ffprobe`
(Homebrew), `curl`, `zip`, `df`, `caffeinate`, `osascript`.

## Run

```
brew install ffmpeg node          # once
cd timelapse
PORT=3006 TIMELAPSE_DATA_DIR=~/TimelapseData node server.js
```

Open http://192.168.1.13:3006 (or the LAN IP shown in the log). Add it to the iPhone home screen
from Safari for a standalone app.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3006 | HTTP port |
| `TIMELAPSE_DATA_DIR` | `~/TimelapseData` | Frames, thumbnails and videos |
| `TIMELAPSE_CONFIG_DIR` | `timelapse/config` | `settings.json` and `cameras.json` (gitignored, holds camera passwords) |

## Install as a service (LaunchAgent)

```
./scripts/install-launchagent.sh
```

Installs `~/Library/LaunchAgents/com.thorleypark.timelapse.plist`, starts it, and restarts it
on crash or login. Logs go to `~/Library/Logs/thorleypark-timelapse.log`.

## Setting up

1. **Cameras** tab: add each camera with its RTSP URL for the main (highest resolution) stream,
   for example `rtsp://user:password@192.168.1.50:554/stream1`. If the camera also serves a
   full-resolution JPEG over HTTP, add that as the snapshot URL; it is faster and preferred.
   Press **Test** to grab a frame and confirm the resolution.
2. **Settings** tab: set latitude and longitude (for sunrise to sunset windows), the iMessage
   recipient, and enable alerts. Press **Send test alert** while sitting at the Mac: the first
   send triggers a macOS Automation permission prompt for node, approve it in
   System Settings, Privacy & Security, Automation.
3. **Jobs** tab: create a job. The estimate box shows how many frames it will capture, how long
   the final video will be, and roughly how much disk it needs.

## How it works

- `lib/scheduler.js` ticks every 5 seconds. Each job has a slot grid anchored at its start time
  (`start + n * interval`). A slot is captured when it is inside the window. Missed slots (the Mac
  slept, the server restarted, the camera was down) are logged as gaps and never caught up, so
  the timelapse stays evenly spaced.
- `lib/capture.js` grabs a frame with `curl` (snapshot URL) or `ffmpeg -rtsp_transport tcp`
  (RTSP), with a hard timeout, and writes a 320 px thumbnail at the same time.
- Frames are named by slot time in UTC (`20260910T070000Z.jpg`) so file order is chronological.
- `lib/render.js` runs one render at a time: it builds a numbered symlink sequence of the chosen
  frames and encodes with `libx264` (CRF 18, `yuv420p`, `+faststart`) capped at 3840 px wide.
  "Target length" mode picks the fps to hit the length, dropping frames evenly if it would need
  more than the max fps. Progress comes from `ffmpeg -progress`.
- `lib/sun.js` is a pure JS NOAA sunrise/sunset calculator.
- Job state: `scheduled` → `capturing` → `finishing` → `completed` (or `errored` if a final
  render fails; `cancelled` skips the final render).

Data layout:

```
~/TimelapseData/jobs/<jobId>/job.json
                             captures.jsonl        one line per capture attempt, gap, state change
                             frames/<cameraId>/20260910T070000Z.jpg
                             thumbs/<cameraId>/20260910T070000Z.jpg
                             renders/renders.json
                             renders/<job>_<camera>_interim_20260912-1430.mp4
                             renders/<job>_<camera>_final.mp4
```

## Keeping the MacBook awake

The server runs `caffeinate -i -s` while any job is capturing, which stops idle and system sleep
on power. It cannot stop the lid-close sleep. For a multi-week job:

- keep the MacBook plugged in, and
- keep the lid open, or use clamshell mode (external display and keyboard attached), or run
  `sudo pmset -c sleep 0` and `sudo pmset -c disksleep 0`.

Gaps from sleep are shown on the job page and in the capture log.

## Disk use

A 4K JPEG is about 1.5 to 3 MB. Every 5 minutes for a month is roughly 8,600 frames and
20 GB per camera. Capture pauses automatically when free space drops below the configured
minimum (default 5 GB) and resumes when space is freed. Deleting a job removes its frames and videos.

## Testing without cameras

Add a camera with source "Test pattern" (`testsrc2=size=3840x2160:rate=1`) and run a short job,
or run `./scripts/smoke.sh` against a running server for an automated end-to-end check.

## Later

- Cloudflare tunnel (must add authentication first, camera passwords are editable in the UI)
- Side-by-side multi-camera composite video
- Deflicker filter for outdoor exposure changes
