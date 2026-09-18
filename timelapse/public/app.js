/* Thorley Park Timelapse: single page app. Hash routes, plain DOM, no dependencies. */
(function () {
  'use strict';

  const view = document.getElementById('view');
  const toastEl = document.getElementById('toast');
  let pollTimer = null;
  let toastTimer = null;
  let currentRoute = '';

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(method, path, body) {
    const opts = { method, headers: {}, cache: 'no-store' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok) throw new Error((data && (data.detail ? `${data.error}: ${data.detail}` : data.error)) || `HTTP ${r.status}`);
    return data;
  }

  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, isError ? 5000 : 2500);
  }

  function fmtBytes(n) {
    if (n == null) return '–';
    if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
    if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
    return `${(n / 1e9).toFixed(1)} GB`;
  }

  function fmtDur(sec) {
    if (sec == null || isNaN(sec)) return '–';
    sec = Math.round(sec);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 48) return mm ? `${h}h ${mm}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  function fmtInterval(sec) {
    if (sec % 3600 === 0) return `${sec / 3600} h`;
    if (sec % 60 === 0) return `${sec / 60} min`;
    return `${sec} s`;
  }

  function fmtDateTime(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function fmtTime(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtRel(iso) {
    if (!iso) return '–';
    const diff = (new Date(iso).getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    const txt = abs < 5 ? 'now' : fmtDur(abs);
    if (abs < 5) return txt;
    return diff > 0 ? `in ${txt}` : `${txt} ago`;
  }

  function windowText(w) {
    if (!w || w.mode === 'none') return 'All day';
    if (w.mode === 'daily') return `Daily ${w.dailyStart} to ${w.dailyEnd}`;
    const b = Number(w.sunBeforeMin) || 0, a = Number(w.sunAfterMin) || 0;
    return `Sunrise${b ? (b > 0 ? ` −${b}m` : ` +${-b}m`) : ''} to sunset${a ? (a > 0 ? ` +${a}m` : ` −${-a}m`) : ''}`;
  }

  function playbackText(p) {
    if (!p) return '30 fps';
    return p.mode === 'duration' ? `${p.targetDurationSec}s video` : `${p.fps} fps`;
  }

  function pill(status, label) {
    return `<span class="pill ${esc(status)}">${esc(label || status)}</span>`;
  }

  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function setNav(name) {
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  }

  function setPoll(fn, ms) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') fn(); }, ms);
  }

  function healthBanners(h) {
    const out = [];
    if (!h.ffmpeg.ok) out.push(`<div class="banner error"><strong>ffmpeg not found.</strong> ${esc(h.ffmpeg.error)} <span class="small">Install with <code>brew install ffmpeg</code>, or set the path in Settings.</span></div>`);
    if (h.disk && h.disk.freeBytes != null && h.disk.freeBytes < 10e9) out.push(`<div class="banner warn"><strong>Low disk space:</strong> ${fmtBytes(h.disk.freeBytes)} free in the data folder.</div>`);
    if (h.platform === 'darwin' && !h.caffeinate && h.scheduler && h.scheduler.inFlight) {
      // only meaningful when capturing; dashboard adds context
    }
    return out.join('');
  }

  // ---------- dashboard ----------
  async function dashboard() {
    setNav('jobs');
    async function load() {
      const [{ jobs }, h] = await Promise.all([api('GET', '/api/jobs'), api('GET', '/api/health')]);
      if (currentRoute !== '#/') return;
      const active = jobs.filter((j) => ['capturing', 'finishing', 'scheduled'].includes(j.status));
      const past = jobs.filter((j) => !['capturing', 'finishing', 'scheduled'].includes(j.status));
      const card = (j) => `
        <div class="card link" data-go="#/jobs/${esc(j.id)}">
          <div class="row between">
            <div class="card-title grow">${esc(j.name)}</div>
            ${j.pausedReason ? pill('paused', 'paused: ' + j.pausedReason) : pill(j.status)}
          </div>
          <div class="muted mt">${esc(fmtDateTime(j.start))} → ${esc(fmtDateTime(j.end))} · every ${esc(fmtInterval(j.intervalSec))} · ${esc(windowText(j.window))}</div>
          <div class="muted">${j.cameras.map((c) => esc(c.name) + (c.removed ? ' (removed)' : '')).join(', ')}</div>
          <div class="stats">
            <div class="stat"><div class="v">${j.totalFrames.toLocaleString()}</div><div class="k">frames</div></div>
            <div class="stat"><div class="v">${fmtBytes(j.totalBytes)}</div><div class="k">on disk</div></div>
            ${j.status === 'capturing' ? `<div class="stat"><div class="v">${esc(fmtRel(j.nextCaptureAt))}</div><div class="k">next capture</div></div>` : ''}
            ${j.status === 'scheduled' ? `<div class="stat"><div class="v">${esc(fmtRel(j.start))}</div><div class="k">starts</div></div>` : ''}
            ${j.gaps ? `<div class="stat"><div class="v">${j.gaps}</div><div class="k">gaps</div></div>` : ''}
            ${j.renderRunning ? `<div class="stat"><div class="v">rendering…</div><div class="k">video</div></div>` : ''}
          </div>
          ${j.cameras.some((c) => c.consecutiveFailures >= 3 && !c.removed) ? `<div class="banner error mt small">Camera failing: ${j.cameras.filter((c) => c.consecutiveFailures >= 3).map((c) => esc(c.name)).join(', ')}</div>` : ''}
          ${j.error ? `<div class="banner error mt small">${esc(j.error)}</div>` : ''}
        </div>`;
      view.innerHTML = `
        ${healthBanners(h)}
        <div class="row between mb">
          <div class="section-label" style="margin:0 0 0 0.25rem">Jobs</div>
          <a class="btn btn-primary btn-sm" href="#/jobs/new">+ New timelapse</a>
        </div>
        ${!jobs.length ? `<div class="empty">No timelapse jobs yet.<br><br><a class="btn btn-primary" href="#/jobs/new">Create your first job</a></div>` : ''}
        ${active.map(card).join('')}
        ${past.length ? `<div class="section-label">Finished</div>${past.map(card).join('')}` : ''}
        <div class="muted mt small" style="text-align:center">${h.disk && h.disk.freeBytes != null ? `${fmtBytes(h.disk.freeBytes)} free` : ''} · ${esc(h.timezone)}${h.platform === 'darwin' ? (h.caffeinate ? ' · caffeinate on' : '') : ''}</div>`;
    }
    await load();
    setPoll(() => load().catch(() => {}), 5000);
  }

  // ---------- job form ----------
  async function jobForm(editId) {
    setNav('jobs');
    const [{ cameras }, existing] = await Promise.all([
      api('GET', '/api/cameras'),
      editId ? api('GET', `/api/jobs/${editId}`).then((r) => r.job) : Promise.resolve(null),
    ]);
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(Math.ceil(now.getMinutes() / 5) * 5);
    const weekLater = new Date(now.getTime() + 7 * 86400000);
    const j = existing || {
      name: '', startInput: toLocalInput(now), endInput: toLocalInput(weekLater), intervalSec: 300,
      cameras: [], window: { mode: 'none', dailyStart: '06:30', dailyEnd: '19:00', sunBeforeMin: 30, sunAfterMin: 30 },
      playback: { mode: 'fps', fps: 30, targetDurationSec: 60 }, status: 'scheduled',
    };
    const locked = existing && existing.status !== 'scheduled';
    const done = existing && !['scheduled', 'capturing'].includes(existing.status);
    const selected = new Set((j.cameras || []).filter((c) => !c.removed).map((c) => c.id));
    let iv = j.intervalSec, unit = 1;
    if (iv % 3600 === 0) { iv /= 3600; unit = 3600; } else if (iv % 60 === 0) { iv /= 60; unit = 60; }
    const camList = cameras.filter((c) => c.enabled !== false);

    view.innerHTML = `
      <div class="card">
        <h2>${existing ? 'Edit timelapse' : 'New timelapse'}</h2>
        ${done ? `<div class="banner info small">This job is ${esc(existing.status)}. Only the name and playback default can be changed.</div>` : ''}
        <form id="jobform">
          <div class="field"><label>Name</label><input type="text" name="name" value="${esc(j.name)}" placeholder="e.g. Back deck build" required></div>
          <div class="inline">
            <div class="field"><label>Start</label><input type="datetime-local" name="start" value="${esc(j.startInput)}" ${locked ? 'disabled' : ''} required></div>
            <div class="field"><label>End</label><input type="datetime-local" name="end" value="${esc(j.endInput)}" ${done ? 'disabled' : ''} required></div>
          </div>
          <div class="field"><label>Cameras</label>
            ${!camList.length ? `<div class="banner warn small">No cameras yet. <a href="#/cameras">Add one first.</a></div>` : ''}
            ${camList.map((c) => `<label class="check"><input type="checkbox" name="cam" value="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''} ${done ? 'disabled' : ''}> ${esc(c.name)} <span class="muted">${esc(c.kind === 'ip' ? (c.snapshotUrl ? 'snapshot' : 'rtsp') : c.kind)}</span></label>`).join('')}
          </div>
          <div class="field"><label>Capture every</label>
            <div class="inline">
              <input type="number" name="ivn" min="1" step="1" value="${esc(iv)}" ${done ? 'disabled' : ''} required>
              <select name="ivu" class="fixed" ${done ? 'disabled' : ''}>
                <option value="1" ${unit === 1 ? 'selected' : ''}>seconds</option>
                <option value="60" ${unit === 60 ? 'selected' : ''}>minutes</option>
                <option value="3600" ${unit === 3600 ? 'selected' : ''}>hours</option>
              </select>
            </div>
            <div class="hint" id="ivhint"></div>
          </div>
          <div class="field"><label>Daily window</label>
            <div class="radios">
              <label><input type="radio" name="wmode" value="none" ${j.window.mode === 'none' ? 'checked' : ''} ${done ? 'disabled' : ''}><span>All day</span></label>
              <label><input type="radio" name="wmode" value="daily" ${j.window.mode === 'daily' ? 'checked' : ''} ${done ? 'disabled' : ''}><span>Fixed hours</span></label>
              <label><input type="radio" name="wmode" value="sun" ${j.window.mode === 'sun' ? 'checked' : ''} ${done ? 'disabled' : ''}><span>Sunrise to sunset</span></label>
            </div>
            <div id="wdaily" class="inline mt" hidden>
              <div class="field"><label>From</label><input type="time" name="dailyStart" value="${esc(j.window.dailyStart)}" ${done ? 'disabled' : ''}></div>
              <div class="field"><label>To</label><input type="time" name="dailyEnd" value="${esc(j.window.dailyEnd)}" ${done ? 'disabled' : ''}></div>
            </div>
            <div id="wsun" class="mt" hidden>
              <div class="inline">
                <div class="field"><label>Minutes before sunrise</label><input type="number" name="sunBeforeMin" step="5" value="${esc(j.window.sunBeforeMin)}" ${done ? 'disabled' : ''}></div>
                <div class="field"><label>Minutes after sunset</label><input type="number" name="sunAfterMin" step="5" value="${esc(j.window.sunAfterMin)}" ${done ? 'disabled' : ''}></div>
              </div>
              <div class="hint" id="sunhint">Loading today's sun times…</div>
            </div>
          </div>
          <div class="field"><label>Final video</label>
            <div class="radios">
              <label><input type="radio" name="pmode" value="fps" ${j.playback.mode === 'fps' ? 'checked' : ''}><span>Playback speed</span></label>
              <label><input type="radio" name="pmode" value="duration" ${j.playback.mode === 'duration' ? 'checked' : ''}><span>Target length</span></label>
            </div>
            <div class="inline mt">
              <div class="field" id="pfps"><label>Frames per second</label><input type="number" name="fps" min="1" max="120" value="${esc(j.playback.fps)}"></div>
              <div class="field" id="pdur" hidden><label>Video length (seconds)</label><input type="number" name="targetDurationSec" min="1" max="3600" value="${esc(j.playback.targetDurationSec)}"></div>
            </div>
          </div>
          <div class="estimate" id="estimate">Estimate…</div>
          <div class="row mt">
            <button class="btn btn-primary" type="submit">${existing ? 'Save changes' : 'Create job'}</button>
            <a class="btn" href="${existing ? '#/jobs/' + esc(existing.id) : '#/'}">Cancel</a>
          </div>
        </form>
      </div>`;

    const form = document.getElementById('jobform');
    const f = (name) => form.elements[name];
    let sunCache = null;

    function values() {
      const wmode = form.querySelector('input[name=wmode]:checked').value;
      const pmode = form.querySelector('input[name=pmode]:checked').value;
      return {
        name: f('name').value,
        start: f('start').value,
        end: f('end').value,
        cameraIds: [...form.querySelectorAll('input[name=cam]:checked')].map((i) => i.value),
        intervalSec: Math.round(Number(f('ivn').value) * Number(f('ivu').value)),
        window: { mode: wmode, dailyStart: f('dailyStart').value, dailyEnd: f('dailyEnd').value, sunBeforeMin: Number(f('sunBeforeMin').value), sunAfterMin: Number(f('sunAfterMin').value) },
        playback: { mode: pmode, fps: Number(f('fps').value), targetDurationSec: Number(f('targetDurationSec').value) },
      };
    }

    function syncVisibility() {
      const v = values();
      document.getElementById('wdaily').hidden = v.window.mode !== 'daily';
      document.getElementById('wsun').hidden = v.window.mode !== 'sun';
      document.getElementById('pfps').hidden = v.playback.mode !== 'fps';
      document.getElementById('pdur').hidden = v.playback.mode !== 'duration';
      const rtspShort = v.intervalSec < 5 && v.cameraIds.some((id) => { const c = cameras.find((x) => x.id === id); return c && c.kind === 'ip' && !c.snapshotUrl; });
      document.getElementById('ivhint').textContent = rtspShort ? 'Intervals under 5 s are unreliable over RTSP (each grab waits for a keyframe). Use a snapshot URL for fast capture.' : '';
      if (v.window.mode === 'sun' && !sunCache) {
        api('GET', '/api/sun').then((s) => {
          sunCache = s;
          document.getElementById('sunhint').textContent = s.polar ? `Polar ${s.polar} at the configured location` : `Today at the configured location: sunrise ${fmtTime(s.sunrise)}, sunset ${fmtTime(s.sunset)} (change location in Settings)`;
        }).catch(() => {});
      }
    }

    let estTimer = null;
    function estimate() {
      clearTimeout(estTimer);
      estTimer = setTimeout(async () => {
        const v = values();
        const box = document.getElementById('estimate');
        if (!v.start || !v.end || !v.intervalSec) { box.textContent = 'Fill in start, end and interval for an estimate.'; return; }
        try {
          const e = await api('POST', '/api/jobs/estimate', v);
          const cams = Math.max(1, v.cameraIds.length);
          box.innerHTML = `≈ <strong>${e.frames.toLocaleString()}</strong> frames per camera (${e.perDay.toLocaleString()} per day) → final video <strong>${fmtDur(e.finalDurationSec)}</strong> at ${e.fpsUsed} fps · ≈ ${fmtBytes(e.estBytesPerCamera)} per camera${cams > 1 ? `, ${fmtBytes(e.estBytesTotal)} total` : ''}`;
        } catch (err) {
          box.textContent = err.message;
        }
      }, 300);
    }

    form.addEventListener('input', () => { syncVisibility(); estimate(); });
    form.addEventListener('change', () => { syncVisibility(); estimate(); });
    syncVisibility();
    estimate();

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = values();
      try {
        let res;
        if (existing) {
          const patch = { name: v.name, playback: v.playback };
          if (!done) { Object.assign(patch, { end: v.end, intervalSec: v.intervalSec, window: v.window, cameraIds: v.cameraIds }); }
          if (!locked) patch.start = v.start;
          res = await api('PUT', `/api/jobs/${existing.id}`, patch);
        } else {
          res = await api('POST', '/api/jobs', v);
        }
        toast(existing ? 'Saved' : 'Job created');
        location.hash = `#/jobs/${res.job.id}`;
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ---------- job detail ----------
  async function jobDetail(id) {
    setNav('jobs');
    const state = { framesCam: null, framesOffset: 0, framesItems: [], framesTotal: 0, playing: null, renderOpen: false };
    let job = null;

    async function load() {
      job = (await api('GET', `/api/jobs/${id}`)).job;
      if (currentRoute !== `#/jobs/${id}`) return;
      if (!state.framesCam || !job.cameras.some((c) => c.id === state.framesCam)) state.framesCam = job.cameras[0] && job.cameras[0].id;
      renderPage();
    }

    async function loadFrames(reset) {
      if (!state.framesCam) return;
      if (reset) { state.framesOffset = 0; state.framesItems = []; }
      const r = await api('GET', `/api/jobs/${id}/frames/${state.framesCam}?offset=${state.framesOffset}&limit=48`);
      state.framesTotal = r.total;
      state.framesItems = state.framesItems.concat(r.items);
      state.framesOffset += r.items.length;
      renderFrames();
    }

    function renderFrames() {
      const el = document.getElementById('frames');
      if (!el) return;
      const cam = job.cameras.find((c) => c.id === state.framesCam);
      el.innerHTML = `
        <div class="row between mb">
          <select id="framecam" class="grow" style="font:inherit;padding:0.4rem;border-radius:8px;border:1px solid var(--line);background:var(--input-bg);color:var(--text)">
            ${job.cameras.map((c) => `<option value="${esc(c.id)}" ${c.id === state.framesCam ? 'selected' : ''}>${esc(c.name)} (${c.frames.toLocaleString()} frames)</option>`).join('')}
          </select>
          ${cam && cam.frames ? `<a class="btn btn-sm" href="/api/jobs/${esc(id)}/frames/${esc(cam.id)}/frames.zip">⬇ All frames (zip, ${fmtBytes(cam.bytes)})</a>` : ''}
        </div>
        ${!state.framesItems.length ? '<div class="muted">No frames yet.</div>' : ''}
        <div class="thumbs">
          ${state.framesItems.map((fr) => `<a href="/api/jobs/${esc(id)}/frames/${esc(state.framesCam)}/${esc(fr.name)}" target="_blank" title="${esc(fmtDateTime(fr.ts))}"><img loading="lazy" src="/api/jobs/${esc(id)}/thumbs/${esc(state.framesCam)}/${esc(fr.name)}" alt=""></a>`).join('')}
        </div>
        ${state.framesOffset < state.framesTotal ? `<button class="btn btn-block mt" id="moreframes">Show more (${(state.framesTotal - state.framesOffset).toLocaleString()} older)</button>` : ''}`;
      document.getElementById('framecam').addEventListener('change', (e) => { state.framesCam = e.target.value; loadFrames(true).catch((err) => toast(err.message, true)); });
      const more = document.getElementById('moreframes');
      if (more) more.addEventListener('click', () => loadFrames(false).catch((err) => toast(err.message, true)));
    }

    function renderCard(r) {
      const pct = r.progress && r.progress.total ? Math.round((100 * r.progress.frame) / r.progress.total) : 0;
      const meta = r.status === 'done'
        ? `${r.framesUsed.toLocaleString()} frames · ${fmtDur(r.durationSec)} @ ${r.fpsUsed} fps · ${r.width}×${r.height} · ${fmtBytes(r.bytes)}`
        : r.status === 'running' ? `${(r.progress.frame || 0).toLocaleString()} / ${(r.progress.total || 0).toLocaleString()} frames`
          : r.status === 'failed' ? esc(r.error) : 'waiting in queue';
      return `
        <div class="card" style="margin-bottom:0.5rem">
          <div class="row between">
            <div class="grow"><strong>${esc(r.type === 'final' ? 'Final' : 'Interim')}</strong> · ${esc(r.cameraName)} <span class="muted">${esc(fmtDateTime(r.requestedAt))}</span></div>
            ${pill(r.status)}
          </div>
          <div class="muted small mt">${meta}</div>
          ${r.status === 'running' ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}
          ${r.status === 'failed' && r.stderrTail ? `<details class="mt"><summary>ffmpeg output</summary><div class="loglines">${esc(r.stderrTail)}</div></details>` : ''}
          ${r.status === 'done' ? `
            <div class="row mt">
              <button class="btn btn-sm" data-play="${esc(r.id)}">▶ Play</button>
              <a class="btn btn-sm" href="/api/jobs/${esc(id)}/renders/${esc(r.id)}/file?download=1">⬇ Download</a>
              <span class="grow"></span>
              <button class="btn btn-sm btn-danger" data-delrender="${esc(r.id)}">Delete</button>
            </div>
            ${state.playing === r.id ? `<video controls playsinline autoplay src="/api/jobs/${esc(id)}/renders/${esc(r.id)}/file"></video>` : ''}` : `
            <div class="row mt"><span class="grow"></span><button class="btn btn-sm btn-danger" data-delrender="${esc(r.id)}">${r.status === 'failed' ? 'Remove' : 'Cancel'}</button></div>`}
        </div>`;
    }

    function logLine(l) {
      const t = fmtTime(l.t);
      if (l.type === 'gap') return `<div class="gap">${t}  GAP ${l.cam ? esc(job.cameras.find((c) => c.id === l.cam)?.name || l.cam) + ' ' : ''}${l.missed != null ? `missed ${l.missed} slot(s) ` : ''}${l.ms ? `(${fmtDur(l.ms / 1000)}) ` : ''}${esc(l.reason || '')}</div>`;
      if (l.type === 'state') return `<div class="state">${t}  ${esc(l.from)} → ${esc(l.to)}</div>`;
      const cam = esc(job.cameras.find((c) => c.id === l.cam)?.name || l.cam);
      if (l.ok) return `<div>${t}  ${cam}  ok  ${l.ms} ms  ${fmtBytes(l.bytes)}</div>`;
      return `<div class="err">${t}  ${cam}  FAIL  ${esc(l.error)}</div>`;
    }

    function renderPage() {
      const active = ['scheduled', 'capturing'].includes(job.status);
      const canRender = job.cameras.some((c) => c.frames > 1) && !['finishing'].includes(job.status);
      const running = job.renders.some((r) => r.status === 'running' || r.status === 'queued');
      view.innerHTML = `
        <div class="card">
          <div class="row between">
            <div class="card-title grow" style="font-size:1.2rem">${esc(job.name)}</div>
            ${job.pausedReason ? pill('paused', 'paused: ' + job.pausedReason) : pill(job.status)}
          </div>
          <div class="muted mt">${esc(fmtDateTime(job.start))} → ${esc(fmtDateTime(job.end))}</div>
          <div class="muted">Every ${esc(fmtInterval(job.intervalSec))} · ${esc(windowText(job.window))} · final: ${esc(playbackText(job.playback))}</div>
          ${job.error ? `<div class="banner error mt small">${esc(job.error)}</div>` : ''}
          ${job.pausedReason === 'disk' ? `<div class="banner warn mt small">Capture is paused because the disk is nearly full. Free some space and it resumes automatically.</div>` : ''}
          <div class="stats">
            <div class="stat"><div class="v">${job.totalFrames.toLocaleString()}</div><div class="k">frames</div></div>
            <div class="stat"><div class="v">${fmtBytes(job.totalBytes)}</div><div class="k">on disk</div></div>
            <div class="stat"><div class="v">${job.estimatedFrames.toLocaleString()}</div><div class="k">expected / cam</div></div>
            ${job.status === 'capturing' ? `<div class="stat"><div class="v">${esc(fmtRel(job.nextCaptureAt))}</div><div class="k">next capture</div></div>` : ''}
            ${job.gaps ? `<div class="stat"><div class="v">${job.gaps}</div><div class="k">gaps</div></div>` : ''}
          </div>
          <div class="row mt">
            ${canRender ? `<button class="btn btn-primary" id="openrender">🎬 Render up to now</button>` : ''}
            <a class="btn" href="#/jobs/${esc(job.id)}/edit">Edit</a>
            ${job.status === 'capturing' ? `<button class="btn" id="endnow">End now</button>` : ''}
            ${active || job.status === 'finishing' ? `<button class="btn btn-danger" id="cancel">Cancel</button>` : ''}
            ${['errored', 'completed', 'cancelled'].includes(job.status) && job.totalFrames > 1 ? `<button class="btn" id="retry">Re-render final</button>` : ''}
            ${!active && job.status !== 'finishing' ? `<button class="btn btn-danger" id="delete">Delete</button>` : ''}
          </div>
          <div id="renderpanel" class="mt" ${state.renderOpen ? '' : 'hidden'}>
            <div class="card" style="background:var(--bg);box-shadow:none;margin:0">
              <div class="field"><label>Video</label>
                <div class="radios">
                  <label><input type="radio" name="rmode" value="fps" ${job.playback.mode !== 'duration' ? 'checked' : ''}><span>Playback speed</span></label>
                  <label><input type="radio" name="rmode" value="duration" ${job.playback.mode === 'duration' ? 'checked' : ''}><span>Target length</span></label>
                </div>
              </div>
              <div class="inline">
                <div class="field" id="rfps"><label>Frames per second</label><input type="number" id="rfpsv" min="1" max="120" value="${esc(job.playback.fps || 30)}"></div>
                <div class="field" id="rdur" hidden><label>Video length (seconds)</label><input type="number" id="rdurv" min="1" max="3600" value="${esc(job.playback.targetDurationSec || 60)}"></div>
              </div>
              <div class="field"><label>Cameras</label>
                ${job.cameras.map((c) => `<label class="check"><input type="checkbox" name="rcam" value="${esc(c.id)}" ${c.frames > 1 ? 'checked' : 'disabled'}> ${esc(c.name)} <span class="muted">${c.frames.toLocaleString()} frames</span></label>`).join('')}
              </div>
              <button class="btn btn-primary" id="dorender">Start render</button>
              <span class="muted small"> Capture keeps running. You get an iMessage when it is ready.</span>
            </div>
          </div>
        </div>

        <div class="section-label">Cameras</div>
        ${job.cameras.map((c) => `
          <div class="card">
            <div class="row between"><div class="card-title">${esc(c.name)}${c.removed ? ' <span class="muted">(removed from job)</span>' : ''}</div>
              ${c.consecutiveFailures >= 3 ? pill('errored', `${c.consecutiveFailures} failures`) : c.lastOk === false ? pill('failed', 'last failed') : c.lastOk ? pill('done', 'ok') : ''}</div>
            ${c.frames ? `<img class="latest mt" src="/api/jobs/${esc(job.id)}/frames/${esc(c.id)}/latest.jpg?ts=${esc(c.lastCaptureAt || '')}" alt="Latest frame">` : '<div class="muted mt">No frames yet.</div>'}
            <div class="muted small mt">${c.frames.toLocaleString()} frames · ${fmtBytes(c.bytes)}${c.lastCaptureAt ? ` · last ${esc(fmtRel(c.lastCaptureAt))}${c.lastMs != null ? ` (${c.lastMs} ms)` : ''}` : ''}${c.nextCaptureAt ? ` · next ${esc(fmtRel(c.nextCaptureAt))}` : ''}</div>
            ${c.lastError ? `<div class="banner error small mt">${esc(c.lastError)}</div>` : ''}
          </div>`).join('')}

        <div class="section-label">Videos</div>
        ${!job.renders.length ? '<div class="muted" style="padding:0 0.25rem">No renders yet.' + (job.status === 'capturing' ? ' Use “Render up to now” for a video of what has been captured so far.' : '') + '</div>' : ''}
        ${job.renders.map(renderCard).join('')}

        <div class="section-label">Frames</div>
        <div class="card" id="frames"></div>

        <div class="section-label">Capture log</div>
        <div class="card"><div class="loglines">${job.log.length ? job.log.slice().reverse().map(logLine).join('') : 'Nothing yet.'}</div></div>`;

      // wire up
      const q = (s) => document.querySelector(s);
      const openBtn = q('#openrender');
      if (openBtn) openBtn.addEventListener('click', () => { state.renderOpen = !state.renderOpen; q('#renderpanel').hidden = !state.renderOpen; });
      view.querySelectorAll('input[name=rmode]').forEach((i) => i.addEventListener('change', () => {
        const dur = view.querySelector('input[name=rmode]:checked').value === 'duration';
        q('#rfps').hidden = dur; q('#rdur').hidden = !dur;
      }));
      if (job.playback.mode === 'duration') { q('#rfps').hidden = true; q('#rdur').hidden = false; }
      const doRender = q('#dorender');
      if (doRender) doRender.addEventListener('click', async () => {
        const mode = view.querySelector('input[name=rmode]:checked').value;
        const cameraIds = [...view.querySelectorAll('input[name=rcam]:checked')].map((i) => i.value);
        if (!cameraIds.length) return toast('Pick at least one camera', true);
        try {
          await api('POST', `/api/jobs/${id}/renders`, { mode, fps: Number(q('#rfpsv').value), targetDurationSec: Number(q('#rdurv').value), cameraIds });
          state.renderOpen = false;
          toast('Render queued');
          await load();
        } catch (err) { toast(err.message, true); }
      });
      const act = (sel, path, confirmMsg) => {
        const b = q(sel);
        if (!b) return;
        b.addEventListener('click', async () => {
          if (confirmMsg && !confirm(confirmMsg)) return;
          try { await api('POST', `/api/jobs/${id}/${path}`); toast('Done'); await load(); } catch (err) { toast(err.message, true); }
        });
      };
      act('#endnow', 'end-now', 'End capture now and render the final video?');
      act('#cancel', 'cancel', 'Cancel this job? Frames are kept, but no final video is made automatically.');
      act('#retry', 'retry-final');
      const del = q('#delete');
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete "${job.name}" and all its ${job.totalFrames.toLocaleString()} frames and videos (${fmtBytes(job.totalBytes)})? This cannot be undone.`)) return;
        try { await api('DELETE', `/api/jobs/${id}`); toast('Deleted'); location.hash = '#/'; } catch (err) { toast(err.message, true); }
      });
      view.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => { state.playing = state.playing === b.dataset.play ? null : b.dataset.play; renderPage(); }));
      view.querySelectorAll('[data-delrender]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this video?')) return;
        try { await api('DELETE', `/api/jobs/${id}/renders/${b.dataset.delrender}`); toast('Deleted'); await load(); } catch (err) { toast(err.message, true); }
      }));
      renderFrames();
      setPoll(() => load().catch(() => {}), running ? 3000 : job.status === 'capturing' ? 10000 : 30000);
    }

    await load();
    await loadFrames(true).catch(() => {});
  }

  // ---------- cameras ----------
  async function camerasView() {
    setNav('cameras');
    let cameras = [];
    let editing = null; // camera id being edited, or 'new'

    function camForm(c) {
      c = c || { name: '', kind: 'ip', rtspUrl: '', snapshotUrl: '', lavfiSpec: 'testsrc2=size=3840x2160:rate=1', filePath: '', enabled: true };
      return `
        <form id="camform" class="mt">
          <div class="field"><label>Name</label><input type="text" name="name" value="${esc(c.name)}" placeholder="e.g. Front garden" required></div>
          <div class="field"><label>Source</label>
            <div class="radios">
              <label><input type="radio" name="kind" value="ip" ${c.kind === 'ip' ? 'checked' : ''}><span>IP camera</span></label>
              <label><input type="radio" name="kind" value="lavfi" ${c.kind === 'lavfi' ? 'checked' : ''}><span>Test pattern</span></label>
              <label><input type="radio" name="kind" value="file" ${c.kind === 'file' ? 'checked' : ''}><span>File</span></label>
            </div>
          </div>
          <div data-kind="ip">
            <div class="field"><label>RTSP URL</label><input type="text" name="rtspUrl" value="${esc(c.rtspUrl)}" placeholder="rtsp://user:password@192.168.1.50:554/stream1" autocapitalize="off" autocorrect="off" spellcheck="false">
              <div class="hint">Main (highest resolution) stream. Password is stored locally and never shown again.</div></div>
            <div class="field"><label>Snapshot URL (optional, preferred if set)</label><input type="text" name="snapshotUrl" value="${esc(c.snapshotUrl)}" placeholder="http://user:password@192.168.1.50/cgi-bin/snapshot.cgi" autocapitalize="off" autocorrect="off" spellcheck="false">
              <div class="hint">Many cameras serve a full-resolution JPEG over HTTP. Faster and lighter than RTSP if available.</div></div>
          </div>
          <div data-kind="lavfi" hidden>
            <div class="field"><label>ffmpeg lavfi source</label><input type="text" name="lavfiSpec" value="${esc(c.lavfiSpec)}" autocapitalize="off" spellcheck="false"><div class="hint">Synthetic source for testing without a camera.</div></div>
          </div>
          <div data-kind="file" hidden>
            <div class="field"><label>Image or video file path</label><input type="text" name="filePath" value="${esc(c.filePath)}" placeholder="/Users/you/Pictures/test.jpg" autocapitalize="off" spellcheck="false"></div>
          </div>
          <label class="check"><input type="checkbox" name="enabled" ${c.enabled !== false ? 'checked' : ''}> Enabled</label>
          <div class="row mt">
            <button class="btn btn-primary" type="submit">Save</button>
            <button class="btn" type="button" id="testform">Test</button>
            <button class="btn" type="button" id="cancelform">Cancel</button>
          </div>
          <div id="testresult"></div>
        </form>`;
    }

    function formValues(form) {
      const f = (n) => form.elements[n];
      return {
        name: f('name').value, kind: form.querySelector('input[name=kind]:checked').value,
        rtspUrl: f('rtspUrl').value.trim(), snapshotUrl: f('snapshotUrl').value.trim(),
        lavfiSpec: f('lavfiSpec').value.trim(), filePath: f('filePath').value.trim(), enabled: f('enabled').checked,
      };
    }

    function testResultHtml(r) {
      if (r.ok) return `<div class="banner info small mt">✅ Frame captured: ${r.width}×${r.height}, ${fmtBytes(r.bytes)}, ${r.ms} ms</div>${r.imageUrl ? `<img class="test-img" src="${esc(r.imageUrl)}" alt="Test frame">` : ''}`;
      return `<div class="banner error small mt">❌ ${esc(r.error)}</div>${r.stderrTail ? `<details class="mt"><summary>ffmpeg output</summary><div class="loglines">${esc(r.stderrTail)}</div></details>` : ''}`;
    }

    function render() {
      view.innerHTML = `
        <div class="row between mb">
          <div class="section-label" style="margin:0 0 0 0.25rem">Cameras</div>
          ${editing ? '' : '<button class="btn btn-primary btn-sm" id="addcam">+ Add camera</button>'}
        </div>
        ${editing === 'new' ? `<div class="card"><h2>New camera</h2>${camForm(null)}</div>` : ''}
        ${!cameras.length && editing !== 'new' ? '<div class="empty">No cameras yet. Add your IP cameras here, then create a timelapse job.</div>' : ''}
        ${cameras.map((c) => `
          <div class="card" data-cam="${esc(c.id)}">
            <div class="row between">
              <div class="grow"><div class="card-title">${esc(c.name)}${c.enabled === false ? ' <span class="muted">(disabled)</span>' : ''}</div>
                <div class="muted small mono">${esc(c.kind === 'ip' ? (c.snapshotUrl || c.rtspUrl) : c.kind === 'lavfi' ? c.lavfiSpec : c.filePath)}</div></div>
              ${c.lastTest ? (c.lastTest.ok ? pill('done', `${c.lastTest.width}×${c.lastTest.height}`) : pill('failed', 'test failed')) : pill('', 'untested')}
            </div>
            ${c.lastTest ? `<div class="muted small mt">Last test ${esc(fmtRel(c.lastTest.at))}${c.lastTest.ok ? ` · ${c.lastTest.ms} ms` : ` · ${esc(c.lastTest.error)}`}</div>` : ''}
            ${editing === c.id ? camForm(c) : `
              <div class="row mt">
                <button class="btn btn-sm" data-test="${esc(c.id)}">Test</button>
                <button class="btn btn-sm" data-edit="${esc(c.id)}">Edit</button>
                <span class="grow"></span>
                <button class="btn btn-sm btn-danger" data-del="${esc(c.id)}">Delete</button>
              </div>
              <div id="testresult-${esc(c.id)}"></div>`}
          </div>`).join('')}`;

      const add = document.getElementById('addcam');
      if (add) add.addEventListener('click', () => { editing = 'new'; render(); });
      view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { editing = b.dataset.edit; render(); }));
      view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const c = cameras.find((x) => x.id === b.dataset.del);
        if (!confirm(`Delete camera "${c.name}"? Existing job frames are kept.`)) return;
        try { await api('DELETE', `/api/cameras/${c.id}`); toast('Deleted'); await load(); } catch (err) { toast(err.message, true); }
      }));
      view.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
        const out = document.getElementById(`testresult-${b.dataset.test}`);
        b.disabled = true; out.innerHTML = '<div class="muted small mt">Grabbing a frame… (up to 30 s)</div>';
        try { const { result } = await api('POST', `/api/cameras/${b.dataset.test}/test`); out.innerHTML = testResultHtml(result); await load(false); } catch (err) { out.innerHTML = `<div class="banner error small mt">${esc(err.message)}</div>`; }
        b.disabled = false;
      }));
      const form = document.getElementById('camform');
      if (form) {
        const syncKind = () => {
          const k = form.querySelector('input[name=kind]:checked').value;
          form.querySelectorAll('[data-kind]').forEach((d) => { d.hidden = d.dataset.kind !== k; });
        };
        form.querySelectorAll('input[name=kind]').forEach((i) => i.addEventListener('change', syncKind));
        syncKind();
        document.getElementById('cancelform').addEventListener('click', () => { editing = null; render(); });
        document.getElementById('testform').addEventListener('click', async () => {
          const out = document.getElementById('testresult');
          const btn = document.getElementById('testform');
          btn.disabled = true; out.innerHTML = '<div class="muted small mt">Grabbing a frame… (up to 30 s)</div>';
          try {
            const body = formValues(form);
            if (editing !== 'new') body.id = editing;
            const { result } = await api('POST', '/api/cameras/test-adhoc', body);
            out.innerHTML = testResultHtml(result);
          } catch (err) { out.innerHTML = `<div class="banner error small mt">${esc(err.message)}</div>`; }
          btn.disabled = false;
        });
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          try {
            const body = formValues(form);
            if (editing === 'new') await api('POST', '/api/cameras', body);
            else await api('PUT', `/api/cameras/${editing}`, body);
            editing = null; toast('Saved'); await load();
          } catch (err) { toast(err.message, true); }
        });
      }
    }

    async function load(rerender = true) {
      cameras = (await api('GET', '/api/cameras')).cameras;
      if (rerender) render();
    }
    await load();
  }

  // ---------- settings ----------
  async function settingsView() {
    setNav('settings');
    const [{ settings, dataDir }, h] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/health')]);
    const s = settings;
    view.innerHTML = `
      ${healthBanners(h)}
      <div class="card">
        <h2>Settings</h2>
        <form id="sform">
          <div class="section-label">Location (for sunrise / sunset)</div>
          <div class="inline">
            <div class="field"><label>Latitude</label><input type="number" name="lat" step="0.0001" value="${esc(s.lat)}"></div>
            <div class="field"><label>Longitude</label><input type="number" name="lon" step="0.0001" value="${esc(s.lon)}"></div>
          </div>
          <div class="section-label">Alerts (iMessage)</div>
          <label class="check"><input type="checkbox" name="alertsEnabled" ${s.alerts.enabled ? 'checked' : ''}> Send iMessage alerts</label>
          <div class="field"><label>Recipient (phone number or Apple ID email)</label><input type="text" name="imessageTo" value="${esc(s.alerts.imessageTo)}" placeholder="+61 4xx xxx xxx" autocapitalize="off">
            <div class="hint">Sent from Messages.app on the Mac. The first send asks for Automation permission on the Mac itself: press “Send test alert” while you are at the Mac and approve it.</div></div>
          <div class="row"><button class="btn btn-sm" type="button" id="testalert">Send test alert</button><span class="muted small" id="testalertout"></span></div>

          <div class="section-label">Capture</div>
          <div class="inline">
            <div class="field"><label>Capture timeout (s)</label><input type="number" name="captureTimeoutSec" min="3" max="120" value="${esc(s.captureTimeoutSec)}"></div>
            <div class="field"><label>Concurrent captures</label><input type="number" name="maxConcurrentCaptures" min="1" max="8" value="${esc(s.maxConcurrentCaptures)}"></div>
          </div>
          <div class="inline">
            <div class="field"><label>Pause below free GB</label><input type="number" name="minFreeGB" min="0" value="${esc(s.minFreeGB)}"></div>
            <div class="field"><label>Alert after N failures</label><input type="number" name="alertAfterFailures" min="1" value="${esc(s.alertAfterFailures)}"></div>
          </div>

          <div class="section-label">Video encoding</div>
          <div class="inline">
            <div class="field"><label>Encoder</label><select name="encoder">
              <option value="libx264" ${s.render.encoder === 'libx264' ? 'selected' : ''}>libx264 (software, best quality)</option>
              <option value="h264_videotoolbox" ${s.render.encoder === 'h264_videotoolbox' ? 'selected' : ''}>VideoToolbox (Apple hardware, much faster)</option>
            </select></div>
            <div class="field"><label>Max width (px)</label><input type="number" name="maxWidth" min="320" max="7680" value="${esc(s.render.maxWidth)}"></div>
          </div>
          <div class="inline">
            <div class="field"><label>libx264 CRF (lower = better)</label><input type="number" name="crf" min="0" max="51" value="${esc(s.render.crf)}"></div>
            <div class="field"><label>libx264 preset</label><select name="preset">${['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((p) => `<option ${s.render.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Max fps in target-length mode</label><input type="number" name="maxFps" min="1" max="120" value="${esc(s.render.maxFps)}"><div class="hint">When a target length needs more than this many fps, frames are dropped evenly instead.</div></div>

          <div class="section-label">Paths</div>
          <div class="field"><label>Data folder (frames and videos)</label><input type="text" name="dataDir" value="${esc(s.dataDir)}" placeholder="${esc(dataDir)}" autocapitalize="off"><div class="hint">Currently using <span class="mono">${esc(dataDir)}</span>. Changing this needs a restart of the service and does not move existing files.</div></div>
          <div class="field"><label>ffmpeg path (blank = auto)</label><input type="text" name="ffmpegPath" value="${esc(s.ffmpegPath)}" placeholder="/opt/homebrew/bin/ffmpeg" autocapitalize="off"></div>
          <div class="field"><label>Link used in alerts (blank = auto)</label><input type="text" name="baseUrl" value="${esc(s.baseUrl)}" placeholder="${esc(h.baseUrl)}" autocapitalize="off"></div>
          <button class="btn btn-primary" type="submit">Save settings</button>
        </form>
      </div>
      <div class="card">
        <h2>Status</h2>
        <div class="muted small">
          ffmpeg: ${h.ffmpeg.ok ? esc(`${h.ffmpeg.version} at ${h.ffmpeg.ffmpeg}`) : '<span style="color:var(--red)">not found</span>'}<br>
          Disk: ${h.disk.freeBytes != null ? `${fmtBytes(h.disk.freeBytes)} free of ${fmtBytes(h.disk.totalBytes)}` : esc(h.disk.error || 'unknown')}<br>
          Timezone: ${esc(h.timezone)} · Host: ${esc(h.hostname)} (${esc(h.platform)}) · Up ${fmtDur(h.uptimeSec)}<br>
          Keep-awake (caffeinate): ${h.platform === 'darwin' ? (h.caffeinate ? 'active' : 'idle (starts when a job is capturing)') : 'n/a'}<br>
          Render queue: ${h.renderQueue.running ? 'rendering' : 'idle'}${h.renderQueue.queued ? `, ${h.renderQueue.queued} queued` : ''}
        </div>
        <details class="mt"><summary>Server log</summary><div class="loglines" id="srvlog">Loading…</div></details>
        <details class="mt"><summary>Recent alerts</summary><div class="loglines" id="alertlog">Loading…</div></details>
      </div>`;

    const form = document.getElementById('sform');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = (n) => form.elements[n].value;
      try {
        const r = await api('PUT', '/api/settings', {
          lat: Number(f('lat')), lon: Number(f('lon')),
          alerts: { enabled: form.elements.alertsEnabled.checked, imessageTo: f('imessageTo') },
          captureTimeoutSec: Number(f('captureTimeoutSec')), maxConcurrentCaptures: Number(f('maxConcurrentCaptures')),
          minFreeGB: Number(f('minFreeGB')), alertAfterFailures: Number(f('alertAfterFailures')),
          render: { encoder: f('encoder'), maxWidth: Number(f('maxWidth')), crf: Number(f('crf')), preset: f('preset'), maxFps: Number(f('maxFps')) },
          dataDir: f('dataDir'), ffmpegPath: f('ffmpegPath'), baseUrl: f('baseUrl'),
        });
        toast(r.restartRequired ? 'Saved. Restart the service to use the new data folder.' : 'Saved');
      } catch (err) { toast(err.message, true); }
    });
    document.getElementById('testalert').addEventListener('click', async () => {
      const out = document.getElementById('testalertout');
      out.textContent = 'Sending…';
      try {
        const f = (n) => form.elements[n].value;
        await api('PUT', '/api/settings', { alerts: { enabled: form.elements.alertsEnabled.checked, imessageTo: f('imessageTo') } });
        const r = await api('POST', '/api/alerts/test');
        out.textContent = r.sent ? 'Sent!' : `Not sent: ${r.reason}`;
      } catch (err) { out.textContent = err.message; }
    });
    api('GET', '/api/log?limit=100').then((r) => {
      document.getElementById('srvlog').innerHTML = r.lines.slice().reverse().map((l) => `<div class="${l.level === 'error' ? 'err' : l.level === 'warn' ? 'gap' : ''}">${esc(fmtTime(l.t))}  ${esc(l.msg)}</div>`).join('') || 'Empty';
    }).catch(() => {});
    api('GET', '/api/alerts').then((r) => {
      document.getElementById('alertlog').innerHTML = r.alerts.map((a) => `<div class="${a.sent ? '' : 'gap'}">${esc(fmtTime(a.t))}  ${a.sent ? 'sent' : esc(a.reason)}  ${esc(a.text)}</div>`).join('') || 'No alerts yet';
    }).catch(() => {});
  }

  // ---------- router ----------
  const routes = [
    [/^#\/$/, () => dashboard()],
    [/^#\/jobs\/new$/, () => jobForm(null)],
    [/^#\/jobs\/([^\/]+)\/edit$/, (m) => jobForm(m[1])],
    [/^#\/jobs\/([^\/]+)$/, (m) => jobDetail(m[1])],
    [/^#\/cameras$/, () => camerasView()],
    [/^#\/settings$/, () => settingsView()],
  ];

  async function route() {
    const hash = location.hash || '#/';
    if (hash === '#') { location.hash = '#/'; return; }
    currentRoute = hash;
    clearInterval(pollTimer);
    window.scrollTo(0, 0);
    for (const [re, fn] of routes) {
      const m = re.exec(hash);
      if (m) {
        try { await fn(m); } catch (err) { view.innerHTML = `<div class="banner error">${esc(err.message)}</div><a class="btn" href="#/">Back</a>`; }
        return;
      }
    }
    location.hash = '#/';
  }

  view.addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-go]');
    if (card && !ev.target.closest('a,button')) location.hash = card.dataset.go;
  });
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/';
  route();
})();
