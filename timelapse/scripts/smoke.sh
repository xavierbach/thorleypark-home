#!/bin/bash
# End-to-end smoke test against a running server using a synthetic 4K test camera (no real camera needed).
# Usage: BASE=http://localhost:3006 ./scripts/smoke.sh
# Runs for about 2.5 minutes: creates a camera and a 90 s job at a 10 s interval, requests an
# interim render, waits for the final render, checks Range support and the zip download.
set -euo pipefail
BASE="${BASE:-http://localhost:3006}"
J=(-H "Content-Type: application/json")
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

echo "# health"
curl -sf "$BASE/api/health" | json 'o.ffmpeg.ok ? "ffmpeg " + o.ffmpeg.version : "FFMPEG MISSING: " + o.ffmpeg.error'

echo "# camera"
CAM=$(curl -sf "${J[@]}" -d '{"name":"Smoke 4K","kind":"lavfi","lavfiSpec":"testsrc2=size=3840x2160:rate=1"}' "$BASE/api/cameras" | json 'o.camera.id')
curl -sf -X POST "$BASE/api/cameras/$CAM/test" | json '"test: " + (o.result.ok ? o.result.width + "x" + o.result.height : "FAILED " + o.result.error)'

echo "# job (90 s, every 10 s)"
START=$(date +%Y-%m-%dT%H:%M:%S); END=$(date -v+90S +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -d '+90 seconds' +%Y-%m-%dT%H:%M:%S)
JOB=$(curl -sf "${J[@]}" -d "{\"name\":\"Smoke $$\",\"start\":\"$START\",\"end\":\"$END\",\"intervalSec\":10,\"cameraIds\":[\"$CAM\"],\"playback\":{\"mode\":\"fps\",\"fps\":5}}" "$BASE/api/jobs" | json 'o.job.id')
echo "job $JOB"
sleep 45
curl -sf "$BASE/api/jobs/$JOB" | json '"status " + o.job.status + ", frames " + o.job.totalFrames'

echo "# interim render (2 s target)"
curl -sf "${J[@]}" -d '{"mode":"duration","targetDurationSec":2}' "$BASE/api/jobs/$JOB/renders" > /dev/null
sleep 20
curl -sf "$BASE/api/jobs/$JOB/renders" | json 'o.renders.map(r=>r.type+" "+r.status+" "+(r.error||r.framesUsed+"f@"+r.fpsUsed+"fps "+r.width+"x"+r.height)).join(" | ")'

echo "# waiting for job end + final render"
for i in $(seq 1 30); do
  S=$(curl -sf "$BASE/api/jobs/$JOB" | json 'o.job.status')
  [ "$S" = "completed" ] || [ "$S" = "errored" ] && break
  sleep 5
done
curl -sf "$BASE/api/jobs/$JOB" | json '"status " + o.job.status + ", renders: " + o.job.renders.map(r=>r.type+" "+r.status).join(", ")'

RID=$(curl -sf "$BASE/api/jobs/$JOB/renders" | json 'o.renders.find(r=>r.type==="final"&&r.status==="done")?.id || ""')
echo "# range request"
curl -sI -H 'Range: bytes=0-99' "$BASE/api/jobs/$JOB/renders/$RID/file" | head -1
echo "# zip"
curl -sf -o /tmp/smoke_frames.zip "$BASE/api/jobs/$JOB/frames/$CAM/frames.zip" && unzip -l /tmp/smoke_frames.zip | tail -1

echo "# cleanup"
curl -sf -X DELETE "$BASE/api/jobs/$JOB" > /dev/null
curl -sf -X DELETE "$BASE/api/cameras/$CAM" > /dev/null
echo "OK"
