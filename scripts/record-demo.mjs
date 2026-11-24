#!/usr/bin/env node
// record-demo.mjs - deterministic narrated demo capture for ClearBill.
//
//   node scripts/record-demo.mjs stage     run the real test suite
//                                        (nice -n 15 npm test) and write
//                                        demo/assets/tests_stdout.txt
//   node scripts/record-demo.mjs synth     narration.txt -> narration.wav,
//                                        timing.json, captions.ass, .srt
//   node scripts/record-demo.mjs probe     headless pass that verifies every
//                                        selector in steps.json resolves and
//                                        is click-hittable at 1920x1080
//   node scripts/record-demo.mjs capture   serve + headless Chrome drive ->
//                                        clearbill-demo.mp4
//   node scripts/record-demo.mjs all       stage + synth (if stale) + capture
//   node scripts/record-demo.mjs check     ffprobe report on the mp4
//
// Voiceover uses macOS `say` (Samantha). No API keys, no network. The video
// is recorded by a throwaway headless Chrome with an empty profile inside
// CLEARBILL_DEMO_TMP (default: a fresh mkdtemp dir that is always deleted).
// It never touches a signed-in browser, never downloads to ~/Downloads, and
// aborts if the page navigates off the demo origin.
//
// steps.json vocabulary (times in ms unless noted):
//   { "do": "at", "s": 12.5 }            wait until 12.5 s after record start
//   { "do": "at", "mark": "2.1" }        wait until sentence para 2 sent 1
//                                        starts (resolved via demo/timing.json)
//   { "do": "at", "mark": "end" }        wait until narration end
//   { "do": "wait", "ms": 1500 }
//   { "do": "scrollTo", "selector": "#x", "ms": 1600, "offset": 80 }
//   { "do": "scrollBy", "y": 400, "ms": 1200 }
//   { "do": "move", "selector": "#x", "ms": 700 }
//   { "do": "click", "selector": "#x", "fx": 0.5, "fy": 0.5 }
//   { "do": "drag", "selector": "#x", "to": 0.66, "ms": 900 }  range slider
//   { "do": "select", "selector": "#x", "value": "v" }
//   { "do": "type", "selector": "#x", "text": "hi", "cps": 14 }
//   { "do": "key", "key": "Enter" }
//   { "do": "media", "media": "print" | "off" }                emulated media
//   { "do": "eval", "js": "..." }          __TESTS_STDOUT__ and
//                                        __TESTS_TOTAL__ placeholders expand
//                                        to the staged npm-test evidence

import { spawn, spawnSync, execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO = join(ROOT, 'demo');
const ASSETS = join(DEMO, 'assets');
const NARRATION_TXT = join(DEMO, 'narration.txt');
const NARRATION_WAV = join(DEMO, 'narration.wav');
const TIMING_JSON = join(DEMO, 'timing.json');
const CAPTIONS_ASS = join(DEMO, 'captions.ass');
const OUT_SRT = join(DEMO, 'clearbill-demo.srt');
const OUT_MP4 = join(DEMO, 'clearbill-demo.mp4');
const STEPS_JSON = join(DEMO, 'steps.json');
const TESTS_TXT = join(ASSETS, 'tests_stdout.txt');

const VOICE = process.env.CLEARBILL_VOICE || 'Samantha';
const RATE = Number(process.env.CLEARBILL_VOICE_RATE || 175);
const SR = 24000;
const LEAD = 0.6, GAP_SENT = 0.3, GAP_PARA = 0.75, TAIL = 1.0;
const FPS = 30, W = 1920, H = 1080;

const work = process.env.CLEARBILL_DEMO_TMP || mkdtempSync(join(tmpdir(), 'clearbill-demo-'));
mkdirSync(work, { recursive: true });
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- stage -----------------------------------------------------------

function stage() {
  mkdirSync(ASSETS, { recursive: true });
  const r = spawnSync('nice', ['-n', '15', 'npm', 'test'], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tests = Number((out.match(/tests (\d+)/) || [])[1]);
  const pass = Number((out.match(/pass (\d+)/) || [])[1]);
  const fail = Number((out.match(/fail (\d+)/) || [])[1]);
  if (r.status !== 0 || tests !== 1290 || pass !== 1290 || fail !== 0) {
    throw new Error(`test suite not green (tests=${tests} pass=${pass} fail=${fail} status=${r.status})`);
  }
  const tail = out.trim().split('\n').slice(-14).join('\n');
  writeFileSync(TESTS_TXT, `$ nice -n 15 npm test\n...\n${tail}\n`);
  console.log(`stage: 1290/1290 tests verified -> ${TESTS_TXT}`);
}

// ---------- synth -----------------------------------------------------------

function parseNarration(text) {
  const paras = [];
  for (const raw of text.split(/\n\s*\n/)) {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) paras.push(lines);
  }
  return paras;
}

async function afDuration(file) {
  const { stdout } = await run('afinfo', [file]);
  const m = stdout.match(/estimated duration:\s*([\d.]+)/);
  if (!m) throw new Error(`afinfo could not read duration of ${file}`);
  return Number(m[1]);
}

async function synth() {
  const paras = parseNarration(readFileSync(NARRATION_TXT, 'utf8'));
  const cache = join(work, 'tts');
  mkdirSync(cache, { recursive: true });
  const sents = [];
  const inputs = [];
  let t = LEAD;
  let prevPara = -1;
  inputs.push(['-f', 'lavfi', '-i', `aevalsrc=0:d=${LEAD}:s=${SR}`]);
  for (let p = 0; p < paras.length; p++) {
    for (let s = 0; s < paras[p].length; s++) {
      const text = paras[p][s];
      const aiff = join(cache, `s${p}-${s}.aiff`);
      const wav = join(cache, `s${p}-${s}.wav`);
      if (!existsSync(wav)) {
        await run('say', ['-v', VOICE, '-r', String(RATE), '-o', aiff, text]);
        await run('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-ar', String(SR), '-ac', '1', wav]);
      }
      const dur = await afDuration(wav);
      const gap = prevPara === -1 ? 0 : (p !== prevPara ? GAP_PARA : GAP_SENT);
      if (gap > 0) inputs.push(['-f', 'lavfi', '-i', `aevalsrc=0:d=${gap}:s=${SR}`]);
      t += gap;
      sents.push({ para: p, sent: s, text, dur: Math.round(dur * 1000) / 1000, start: Math.round(t * 1000) / 1000 });
      inputs.push(['-i', wav]);
      t += dur;
      prevPara = p;
    }
  }
  inputs.push(['-f', 'lavfi', '-i', `aevalsrc=0:d=${TAIL}:s=${SR}`]);
  const total = Math.round((t + TAIL) * 1000) / 1000;

  const flat = inputs.flat();
  const labels = inputs.map((_, i) => `[${i}:a]`).join('');
  await run('ffmpeg', ['-v', 'error', '-y', ...flat, '-filter_complex', `${labels}concat=n=${inputs.length}:v=0:a=1[a]`, '-map', '[a]', '-ar', String(SR), '-ac', '1', NARRATION_WAV]);
  const actual = await afDuration(NARRATION_WAV);
  const timing = {
    voice: VOICE, rate: RATE, sr: SR, lead: LEAD, gap_sent: GAP_SENT, gap_para: GAP_PARA, tail: TAIL,
    total, wav_seconds: Math.round(actual * 1000) / 1000,
    words: sents.reduce((a, e) => a + e.text.split(/\s+/).length, 0),
    sentences: sents,
  };
  writeFileSync(TIMING_JSON, JSON.stringify(timing, null, 1) + '\n');
  writeCaptions(timing);
  writeSrt(timing);
  console.log(`synth: ${sents.length} sentences, ${timing.words} words, narration ${timing.wav_seconds}s -> ${NARRATION_WAV}`);
}

const tsAss = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  let cs = Math.round((t - Math.floor(t)) * 100);
  if (cs === 100) { cs = 0; }
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};
const tsSrt = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

function captionWindows(sents) {
  // Same windowing as the station's captions_hark.py: LEAD_IN 0.08, TAIL_PAD 0.05, MIN_GAP 0.04.
  const wins = sents.map((e) => ({ start: e.start - 0.08, end: e.start + e.dur + 0.05, text: e.text }));
  for (let i = 1; i < wins.length; i++) {
    if (wins[i].start < wins[i - 1].end + 0.04) wins[i].start = wins[i - 1].end + 0.04;
  }
  return wins;
}

function writeCaptions(timing) {
  const header = `[Script Info]
Title: clearbill demo captions
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Helvetica,42,&H00FFFFFF,&H000019FF,&H88141414,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,2,120,120,46,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = captionWindows(timing.sentences).map(
    (w) => `Dialogue: 0,${tsAss(w.start)},${tsAss(w.end)},Cap,,0,0,0,,${w.text}`
  );
  writeFileSync(CAPTIONS_ASS, header + lines.join('\n') + '\n');
}

function writeSrt(timing) {
  const out = captionWindows(timing.sentences).map(
    (w, i) => `${i + 1}\n${tsSrt(w.start)} --> ${tsSrt(w.end)}\n${w.text}\n`
  );
  writeFileSync(OUT_SRT, out.join('\n'));
}

// ---------- browser plumbing -------------------------------------------------

async function servePort() {
  const proc = spawn('node', [join(ROOT, 'scripts', 'serve.mjs')], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((res, rej) => {
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/ClearBill at http:\/\/127\.0\.0\.1:(\d+)\/clearbill\//);
      if (m) res(Number(m[1]));
    });
    proc.on('exit', () => rej(new Error('serve.mjs exited early')));
    setTimeout(() => rej(new Error('serve.mjs port timeout')), 8000);
  });
  return { proc, port };
}

async function drive({ record }) {
  const steps = JSON.parse(readFileSync(STEPS_JSON, 'utf8'));
  const testsOut = existsSync(TESTS_TXT) ? readFileSync(TESTS_TXT, 'utf8') : 'test evidence not staged';
  const testsTotal = (testsOut.match(/pass (\d+)/) || ['', '?'])[1];
  let timing = { wav_seconds: 0, sentences: [] };
  if (existsSync(TIMING_JSON)) timing = JSON.parse(readFileSync(TIMING_JSON, 'utf8'));
  const sentStart = (mark) => {
    if (mark === 'end') return timing.wav_seconds;
    const [p, s] = mark.split('.').map(Number);
    const e = timing.sentences.find((x) => x.para === p && x.sent === s);
    if (!e) throw new Error(`no sentence ${mark} in timing.json`);
    return e.start;
  };

  const server = await servePort();
  const url = `http://127.0.0.1:${server.port}/clearbill/`;
  const allowedOrigin = new URL(url).origin;
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile = join(work, 'chrome-profile');
  const framesDir = join(work, 'frames');
  mkdirSync(profile, { recursive: true });
  mkdirSync(framesDir, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
    `--window-size=${W},${H}`, '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });

  async function shutdown(code) {
    if (chrome.exitCode === null) {
      const gone = new Promise((r) => chrome.once('exit', r));
      chrome.kill('SIGTERM');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
    server.proc.kill('SIGTERM');
    rmSync(profile, { recursive: true, force: true });
    rmSync(framesDir, { recursive: true, force: true });
    process.exit(code);
  }
  process.on('unhandledRejection', (e) => { console.error(e); shutdown(1); });

  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    const f = join(profile, 'DevToolsActivePort');
    if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0].trim();
  }
  if (!port) { console.error('Chrome did not start'); await shutdown(1); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

  const ws = new WebSocket(webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const listeners = [];
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result);
    } else if (m.method) listeners.forEach((l) => l(m));
  };
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });

  // Belt and suspenders: nothing this drive does may write to ~/Downloads.
  await send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sid);
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page('Emulation.setFocusEmulationEnabled', { enabled: true });

  let offOrigin = null;
  listeners.push((m) => {
    if (m.sessionId !== sid || m.method !== 'Page.frameNavigated' || m.params.frame.parentId) return;
    const u = m.params.frame.url;
    if (u !== 'about:blank' && new URL(u).origin !== allowedOrigin) offOrigin = u;
  });

  await page('Page.navigate', { url });
  await sleep(2800);
  await page('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
  if (offOrigin) { console.error(`page left ${allowedOrigin}: ${offOrigin}`); await shutdown(1); }

  await page('Runtime.evaluate', { expression: `(() => {
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '28'); svg.setAttribute('height', '28'); svg.setAttribute('viewBox', '0 0 28 28');
    const pth = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pth.setAttribute('d', 'M5 3l16 10-7 1.6L10.4 22z');
    pth.setAttribute('fill', '#111'); pth.setAttribute('stroke', '#fff');
    pth.setAttribute('stroke-width', '1.6'); pth.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pth); c.appendChild(svg);
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none',
      transform: 'translate(${W * 0.62}px, ${H * 0.72}px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))',
      transition: 'scale .12s ease' });
    document.documentElement.appendChild(c);
    window.__cursor = { x: ${W * 0.62}, y: ${H * 0.72} };
    window.__showTests = (text, total) => {
      const old = document.getElementById('__demo_scrim'); if (old) old.remove();
      const scrim = document.createElement('div');
      scrim.id = '__demo_scrim';
      Object.assign(scrim.style, { position: 'fixed', inset: '0', zIndex: '2147483646',
        background: 'rgba(22,22,18,.66)', display: 'grid', placeItems: 'center',
        opacity: '0', transition: 'opacity .45s ease' });
      const card = document.createElement('div');
      Object.assign(card.style, { width: '1360px', maxWidth: '86vw', background: '#1d1d18', color: '#ece6d4',
        borderRadius: '14px', overflow: 'hidden', boxShadow: '0 26px 80px rgba(0,0,0,.55)',
        transform: 'translateY(16px)', transition: 'transform .45s ease' });
      const bar = document.createElement('div');
      Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '8px',
        padding: '12px 18px', background: '#28281f', borderBottom: '1px solid #3d3d30' });
      for (const col of ['#ff5f57', '#febc2e', '#28c840']) {
        const d = document.createElement('i');
        Object.assign(d.style, { width: '12px', height: '12px', borderRadius: '50%', background: col, display: 'block' });
        bar.appendChild(d);
      }
      const cap = document.createElement('span');
      cap.textContent = 'verification';
      Object.assign(cap.style, { marginLeft: '10px', font: '600 13px ui-monospace,SF Mono,Menlo,monospace', color: '#9d977f' });
      bar.appendChild(cap);
      const pre = document.createElement('pre');
      pre.textContent = text;
      Object.assign(pre.style, { margin: '0', padding: '22px 28px', font: '15px/1.6 ui-monospace,SF Mono,Menlo,monospace',
        whiteSpace: 'pre-wrap', color: '#d6cfba' });
      const stat = document.createElement('div');
      const big = document.createElement('span');
      big.textContent = total + ' / ' + total;
      Object.assign(big.style, { font: '700 44px ui-monospace,SF Mono,Menlo,monospace', color: '#8fd6ac' });
      const small = document.createElement('span');
      small.textContent = '  tests passing, 0 failed';
      Object.assign(small.style, { font: '500 16px ui-monospace,SF Mono,Menlo,monospace', color: '#9d977f' });
      Object.assign(stat.style, { padding: '0 28px 24px' });
      stat.append(big, small);
      card.append(bar, pre, stat);
      scrim.appendChild(card);
      document.documentElement.appendChild(scrim);
      requestAnimationFrame(() => { scrim.style.opacity = '1'; card.style.transform = 'translateY(0)'; });
    };
    window.__hideTests = () => {
      const scrim = document.getElementById('__demo_scrim');
      if (!scrim) return;
      scrim.style.opacity = '0';
      setTimeout(() => scrim.remove(), 500);
    };
  })()` });
  {
    const ok = await page('Runtime.evaluate', { expression: `!!(window.__cursor && document.getElementById('__demo_cursor') && window.__showTests)`, returnByValue: true });
    if (!ok.result.value) { console.error('cursor injection failed (CSP?); aborting'); await shutdown(1); }
  }

  const frames = [];
  if (record) {
    listeners.push(async (m) => {
      if (m.sessionId !== sid || m.method !== 'Page.screencastFrame') return;
      const n = frames.length;
      const file = join(framesDir, `f${String(n).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(m.params.data, 'base64'));
      frames.push({ file, t: m.params.metadata.timestamp });
      try { await page('Page.screencastFrameAck', { sessionId: m.params.sessionId }); } catch {}
    });
    await page('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  }
  const t0 = Date.now();

  const js = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const center = async (sel, st = {}) => {
    const b = await rect(sel);
    if (!b) throw new Error(`no element ${sel}`);
    const p = { x: b.x + b.w * (st.fx ?? 0.5), y: b.y + b.h * (st.fy ?? 0.5), w: b.w };
    if (!record) {
      const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        const h = document.elementFromPoint(${p.x}, ${p.y});
        if (!h) return 'off-viewport';
        if (e === h || e.contains(h)) return true;
        return 'covered by ' + (h.id ? '#' + h.id : h.tagName + (h.className ? '.' + String(h.className).split(' ')[0] : '')); })()`);
      if (hit !== true) throw new Error(`hit test failed on ${sel} at ${Math.round(p.x)},${Math.round(p.y)}: ${hit}`);
    }
    return p;
  };
  const glide = (x, y, ms) => js(`new Promise((done) => {
    const c = document.getElementById('__demo_cursor'), s = window.__cursor, t0 = performance.now();
    const ease = (p) => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    (function f() { const p = Math.min(1, (performance.now() - t0) / ${ms}), e = ease(p);
      const cx = s.x + (${x} - s.x) * e, cy = s.y + (${y} - s.y) * e;
      c.style.transform = 'translate(' + (cx - 5) + 'px,' + (cy - 3) + 'px)';
      if (p < 1) requestAnimationFrame(f); else { window.__cursor = { x: ${x}, y: ${y} }; done(); } })();
  })`);
  const smoothScroll = (dy, ms) => js(`new Promise((done) => {
    const y0 = scrollY, t0 = performance.now(), max = document.documentElement.scrollHeight - innerHeight;
    const to = Math.max(0, Math.min(max, y0 + ${dy}));
    const ease = (p) => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    (function f() { const p = Math.min(1, (performance.now() - t0) / ${ms});
      scrollTo(0, y0 + (to - y0) * ease(p)); if (p < 1) requestAnimationFrame(f); else done(); })();
  })`);
  const mouse = (type, x, y) => page('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  const expand = (code) => code
    .replaceAll('__TESTS_STDOUT__', JSON.stringify(testsOut))
    .replaceAll('__TESTS_TOTAL__', JSON.stringify(testsTotal));

  try {
    for (const st of steps) {
      if (offOrigin) break;
      switch (st.do) {
        case 'at': {
          const target = st.mark !== undefined ? sentStart(st.mark) : st.s;
          const wait = target * 1000 - (Date.now() - t0);
          if (wait > 0) await sleep(wait);
          else if (wait < -400) console.warn(`late by ${(-wait / 1000).toFixed(1)} s at mark ${st.mark ?? st.s}`);
          break;
        }
        case 'wait': await sleep(st.ms); break;
        case 'scrollTo': {
          const top = await js(`(document.querySelector(${JSON.stringify(st.selector)})||{}).getBoundingClientRect ? document.querySelector(${JSON.stringify(st.selector)}).getBoundingClientRect().top : null`);
          if (top === null || top === undefined) throw new Error(`no element ${st.selector}`);
          await smoothScroll(top - (st.offset ?? 80), st.ms ?? 1600); break;
        }
        case 'scrollBy': await smoothScroll(st.y, st.ms ?? 1200); break;
        case 'move': { const p = await center(st.selector, st); await glide(p.x, p.y, st.ms ?? 700); break; }
        case 'click': {
          const p = await center(st.selector, st); await glide(p.x, p.y, st.ms ?? 700); await sleep(120);
          await js(`document.getElementById('__demo_cursor').style.scale = '.82'`);
          await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y); await mouse('mouseReleased', p.x, p.y);
          await sleep(110); await js(`document.getElementById('__demo_cursor').style.scale = '1'`); break;
        }
        case 'drag': {
          const info = await js(`(() => { const e = document.querySelector(${JSON.stringify(st.selector)});
            if (!e) return null; const b = e.getBoundingClientRect();
            return { x: b.left, y: b.top + b.height / 2, w: b.width, min: Number(e.min || 0), max: Number(e.max || 100), v: Number(e.value || 0) }; })()`);
          if (!info) throw new Error(`no element ${st.selector}`);
          const thumbW = 20;
          const span = info.w - thumbW;
          const startX = info.x + ((info.v - info.min) / (info.max - info.min)) * span + thumbW / 2;
          const endX = info.x + (st.to ?? 0.5) * span + thumbW / 2;
          if (!record) {
            const hit = await js(`(() => { const e = document.querySelector(${JSON.stringify(st.selector)});
              const h = document.elementFromPoint(${startX}, ${info.y});
              return h ? (e === h || e.contains(h)) : 'off-viewport'; })()`);
            if (hit !== true) throw new Error(`hit test failed on drag ${st.selector}: ${hit}`);
          }
          await glide(startX, info.y, st.ms ?? 650);
          await mouse('mouseMoved', startX, info.y);
          await mouse('mousePressed', startX, info.y);
          const n = 20, seg = Math.max(30, Math.floor((st.dms ?? 900) / n));
          const cursorGlide = glide(endX, info.y, n * seg);
          for (let i = 1; i <= n; i++) {
            await mouse('mouseMoved', startX + ((endX - startX) * i) / n, info.y);
            await sleep(seg);
          }
          await mouse('mouseReleased', endX, info.y);
          await cursorGlide;
          break;
        }
        case 'type': {
          const p = await center(st.selector); await glide(p.x, p.y, 600);
          await js(`document.querySelector(${JSON.stringify(st.selector)}).focus()`);
          for (const ch of st.text) { await page('Input.insertText', { text: ch }); await sleep(1000 / (st.cps ?? 14)); }
          break;
        }
        case 'select': await js(`(() => { const e = document.querySelector(${JSON.stringify(st.selector)});
          e.value = ${JSON.stringify(st.value)}; e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true })); })()`); break;
        case 'key': {
          const KEYCODES = { Enter: 13, ArrowUp: 38, ArrowDown: 40, ' ': 32 };
          const vkc = KEYCODES[st.key] ?? (st.key.length === 1 ? st.key.toUpperCase().charCodeAt(0) : 0);
          const code = /^[a-zA-Z]$/.test(st.key) ? `Key${st.key.toUpperCase()}` : /^[0-9]$/.test(st.key) ? `Digit${st.key}` : st.key;
          const params = { key: st.key, code, windowsVirtualKeyCode: vkc, nativeVirtualKeyCode: vkc };
          await page('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
          await page('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
          break;
        }
        case 'media': await page('Emulation.setEmulatedMedia', { media: st.media === 'off' ? '' : st.media }); break;
        case 'eval': await js(expand(st.js)); break;
        default: throw new Error(`unknown step ${st.do}`);
      }
    }
  } catch (e) {
    console.error(e.message || e);
    await shutdown(1);
  }
  const tEnd = Date.now();

  if (!record) {
    console.log(`probe: ${steps.length} steps ran clean in ${((tEnd - t0) / 1000).toFixed(1)} s`);
    await shutdown(0);
  }
  await page('Page.stopScreencast');
  await sleep(400);
  ws.close();
  if (offOrigin) { console.error(`ABORTED: the page left ${allowedOrigin} for ${offOrigin}; nothing was written.`); await shutdown(1); }
  if (frames.length < 2) { console.error('no frames captured'); await shutdown(1); }

  // Resample to constant fps on the real clock: output frame k shows the
  // newest captured frame at t0 + k/FPS.
  const total = Math.round(((tEnd - t0) / 1000) * FPS);
  let j = 0;
  for (let k = 0; k < total; k++) {
    const at = t0 / 1000 + k / FPS;
    while (j + 1 < frames.length && frames[j + 1].t <= at) j++;
    linkSync(frames[j].file, join(framesDir, `o${String(k).padStart(6, '0')}.jpg`));
  }

  mkdirSync(dirname(OUT_MP4), { recursive: true });
  const ass = CAPTIONS_ASS.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const ff = ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(framesDir, 'o%06d.jpg'), '-i', NARRATION_WAV,
    '-vf', `scale=in_range=pc:out_range=tv,format=yuv420p,tpad=stop_mode=clone:stop_duration=30,subtitles='${ass}'`,
    '-threads', '6', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', OUT_MP4];
  execFileSync('nice', ['-n', '15', 'ffmpeg', ...ff], { stdio: 'inherit' });
  console.log(`capture: frames ${frames.length}, drive ${((tEnd - t0) / 1000).toFixed(1)} s -> ${OUT_MP4}`);
  await shutdown(0);
}

// ---------- probe -------------------------------------------------------------

// Replays steps.json without recording. Selectors must resolve, marks must
// exist in timing.json, and every move/click/drag target must be the topmost
// element at the hit point under the same scroll state the real drive reaches.
async function probe() {
  const steps = JSON.parse(readFileSync(STEPS_JSON, 'utf8'));
  const timing = existsSync(TIMING_JSON) ? JSON.parse(readFileSync(TIMING_JSON, 'utf8')) : { sentences: [] };
  const missing = [];
  for (const st of steps) {
    if (st.do === 'at' && st.mark !== undefined && st.mark !== 'end') {
      const [p, s] = st.mark.split('.').map(Number);
      if (!timing.sentences.find((x) => x.para === p && x.sent === s)) missing.push(`mark ${st.mark}`);
    }
  }
  if (missing.length) throw new Error(`steps.json has unresolved marks: ${missing.join(', ')}`);
  await drive({ record: false });
}

// ---------- check -----------------------------------------------------------

async function check() {
  const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', OUT_MP4]);
  const d = JSON.parse(stdout);
  const v = d.streams.find((s) => s.codec_type === 'video');
  const a = d.streams.find((s) => s.codec_type === 'audio');
  const { stderr: vol } = await run('ffmpeg', ['-i', OUT_MP4, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 120000 }).catch((e) => ({ stderr: e.stderr || '' }));
  console.log(`video: ${v.codec_name} ${v.width}x${v.height} ${eval(v.r_frame_rate).toFixed(0)}fps pix=${v.pix_fmt} range=${v.color_range || 'unknown'}`);
  console.log(`audio: ${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch`);
  console.log(`duration: ${d.format.duration}s size: ${(d.format.size / 1e6).toFixed(1)}MB`);
  const mv = (vol.match(/mean_volume:\s*([-\d.]+ dB)/) || [])[1];
  const xv = (vol.match(/max_volume:\s*([-\d.]+ dB)/) || [])[1];
  console.log(`audio level: mean ${mv || 'unknown'} / max ${xv || 'unknown'}`);
}

// ---------- main ------------------------------------------------------------

const cmd = process.argv[2] || 'all';
try {
  if (cmd === 'stage') stage();
  else if (cmd === 'synth') await synth();
  else if (cmd === 'probe') await probe();
  else if (cmd === 'capture') await drive({ record: true });
  else if (cmd === 'check') await check();
  else if (cmd === 'all') {
    stage();
    if (!existsSync(NARRATION_WAV) || !existsSync(TIMING_JSON)) await synth();
    await drive({ record: true });
  } else {
    console.error('usage: record-demo.mjs stage|synth|probe|capture|all|check');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
