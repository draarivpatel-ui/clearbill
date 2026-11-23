import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from './serve.mjs';

const chromeBin = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

class Session {
  id = 0;
  pending = new Map();
  handlers = new Map();

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else {
        for (const handler of this.handlers.get(message.method) || []) handler(message.params, message.sessionId);
      }
    });
    socket.addEventListener('close', () => {
      for (const { timer, reject } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Chrome disconnected'));
      }
      this.pending.clear();
    });
  }

  command(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { timer, resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method).delete(handler);
  }
}

async function waitFor(read, description) {
  const end = Date.now() + 12_000;
  let last;
  do {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { last = error; }
    await delay(60);
  } while (Date.now() < end);
  throw new Error(`No ${description}${last ? ` (${last.message})` : ''}`);
}

function mark(name) { console.log(`PASS ${name}`); }

async function runViewport(cdp, app, width, height) {
  const { browserContextId } = await cdp.command('Target.createBrowserContext');
  const { targetId } = await cdp.command('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.command('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.command(method, params, sessionId);
  const targetSessions = new Set([sessionId]);
  const unsub = [];
  const events = { console: [], page: [], external: [] };
  unsub.push(cdp.on('Network.requestWillBeSent', (event, id) => {
    if (!targetSessions.has(id)) return;
    const url = new URL(event.request.url);
    if (['http:', 'https:', 'blob:'].includes(url.protocol) && url.origin !== app.origin) events.external.push(url.href);
  }));
  unsub.push(cdp.on('Log.entryAdded', ({ entry }, id) => {
    if (targetSessions.has(id) && entry.level === 'error') events.console.push(entry.text);
  }));
  unsub.push(cdp.on('Runtime.consoleAPICalled', ({ type, args }, id) => {
    if (targetSessions.has(id) && ['error', 'assert'].includes(type)) events.console.push(args.map(arg => arg.value || arg.description).join(' '));
  }));
  unsub.push(cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }, id) => {
    if (targetSessions.has(id)) events.page.push(exceptionDetails.exception?.description || exceptionDetails.text);
  }));
  unsub.push(cdp.on('Target.attachedToTarget', ({ sessionId: worker, targetInfo, waitingForDebugger }, parent) => {
    if (parent !== sessionId) return;
    targetSessions.add(worker);
    void (async () => {
      try {
        if (waitingForDebugger) await cdp.command('Runtime.runIfWaitingForDebugger', {}, worker);
        await Promise.allSettled(['Network.enable', 'Runtime.enable', 'Log.enable'].map(method => cdp.command(method, {}, worker)));
      } catch (error) { events.page.push(error.message); }
    })();
  }));

  async function evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  const wait = (expression, label) => waitFor(() => evaluate(expression), label);
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const text = selector => evaluate(`${q(selector)}?.textContent`);
  const route = `${app.origin}/clearbill/`;
  async function navigate(url) {
    const { errorText } = await send('Page.navigate', { url });
    assert.equal(errorText, undefined);
    if (url.startsWith(route)) await wait(`${q('#case-title')}?.textContent && document.readyState === 'complete'`, 'ready ClearBill document');
  }
  async function click(selector) {
    const { x, y, hit } = await evaluate(`(() => {
      const el = ${q(selector)};
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
    })()`);
    assert(hit, `Click target ${selector} is not visible at ${x}, ${y}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async function set(selector, value, event = 'change') {
    await evaluate(`(() => { const field = ${q(selector)}; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  }
  async function fit(label) {
    const { scroll, client } = await evaluate('({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth})');
    assert(scroll <= client && client === width, `${label}: document width ${scroll}, viewport ${client}`);
  }

  try {
    await Promise.all(['Page.enable', 'Network.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable'].map(method => send(method)));
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await navigate(route);
    await wait(`${q('#lab-panel')} && ${q('#lab-pfs table')} && ${q('#lab-chart svg')}`, 'mounted sensitivity lab');
    await wait(`${q('#offline-status')}.dataset.ready === 'true'`, 'active offline service worker');
    assert.equal(await evaluate(`${q('#lab-panel')}.hidden`), true);
    await click('[data-view=lab]');
    assert.equal(await evaluate(`${q('#lab-panel')}.hidden`), false);
    assert.match(await text('#lab-title'), /Sensitivity lab/);
    assert.match(await text('#lab-pfs'), /\$96\.33/);
    assert.match(await text('#lab-pfs'), /\$107\.63/);
    assert.match(await text('#lab-pfs'), /\$89\.23/);
    assert((await evaluate(`document.querySelectorAll('#lab-pfs tbody tr').length`)) === 6);
    assert.match(await text('#lab-boundary'), /Meets both screens/);
    assert.match(await text('#lab-boundary'), /15960|15,960|\$15,960\.00/);
    assert.match(await text('#lab-cases'), /4\/4/);
    assert((await evaluate(`document.querySelectorAll('#lab-chart .chart-bar').length`)) === 6);
    assert((await evaluate(`document.querySelectorAll('#lab-quadrant .quad-dot').length`)) === 9);
    assert.match(await text('#lab-digest'), /SHA-256 [a-f0-9]{64}/);
    await fit('lab default');
    mark(`${width}x${height} lab renders comparator, charts and boundary tables`);

    await set('#lab-code', '70551');
    assert.match(await text('#lab-pfs'), /70551 Global/);
    await click('#lab-component [data-value="TC"]');
    assert.match(await text('#lab-pfs'), /\$126\.95/);
    await click('#lab-setting [data-value="facility"]');
    assert.match(await text('#lab-pfs'), /N\/A/);
    await click('#lab-setting [data-value="office"]');
    await click('#lab-region [data-value="alaska"]');
    assert.match(await text('#lab-boundary'), /Alaska/);
    await set('#lab-days', '121', 'input');
    assert.match(await text('#lab-boundary'), /Past 120 days/);
    await set('#lab-gap', '399.99', 'input');
    assert.match(await text('#lab-boundary'), /Below \$400/);
    await fit('lab exercised');
    mark(`${width}x${height} procedure, component, setting, region, day and gap controls`);

    await click('#lab-export summary');
    const digestBefore = (await text('#lab-digest')).split(' ')[1];
    await click('#lab-verify');
    assert.match(await text('#lab-status'), /Digest verified/);
    await click('#lab-tamper');
    assert.match(await text('#lab-status'), /Tamper detected/);
    await click('#lab-copy');
    await wait(`${q('#lab-status')}.textContent.length > 3`, 'copy status');
    assert.equal(await evaluate(`${q('#lab-link')}.value`), 'http://127.0.0.1/clearbill/#cbl=v1.c.70551.k.TC.s.office.r.alaska.h.3.i.4000000.g.39999.d.121'
      .replace('http://127.0.0.1', app.origin));
    mark(`${width}x${height} audited export bar and share link`);

    await click('#lab-tests summary');
    await click('#lab-run');
    await wait(`${q('#lab-test-status')}.dataset.all === 'true'`, 'all self-tests passing');
    const testCount = await evaluate(`document.querySelectorAll('#lab-test-list li').length`);
    assert(testCount >= 14, `expected 14+ self-tests, saw ${testCount}`);
    assert.equal(await evaluate(`document.querySelectorAll('#lab-test-list li[data-pass="false"]').length`), 0);
    assert.match(await text('#lab-test-status'), new RegExp(`${testCount}/${testCount}`));
    mark(`${width}x${height} in-page self-tests ${testCount}/${testCount} passing`);

    const bar = '#lab-chart .chart-bar';
    await click(bar);
    const focused = await evaluate(`document.activeElement === ${q(bar)}`);
    assert(focused, 'SVG bar marker should take keyboard focus after a pointer click');
    const marker = '#lab-quadrant .chart-bar';
    await click(marker);
    assert(await evaluate(`document.activeElement === ${q(marker)}`), 'quadrant marker should take focus');
    mark(`${width}x${height} keyboard-focusable SVG markers`);

    await click('[data-lab-language="es"]');
    assert.match(await text('#lab-title'), /Laboratorio de sensibilidad/);
    assert.match(await text('#lab-boundary'), /Cumple ambas pantallas|Bajo \$400|Más de 120 días/);
    await fit('lab Spanish');
    await click('[data-lab-language="en"]');
    assert.match(await text('#lab-title'), /Sensitivity lab/);
    mark(`${width}x${height} EN and ES localization`);

    const share = await evaluate(`${q('#lab-link')}.value`);
    await navigate('about:blank');
    await navigate(share);
    await wait(`!${q('#lab-panel')}.hidden`, 'lab opens from share link');
    assert.equal(await evaluate(`${q('#lab-code')}.value`), '70551');
    assert.equal(await evaluate(`${q('#lab-component [aria-pressed="true"]')}.dataset.value`), 'TC');
    assert.equal(await evaluate(`${q('#lab-setting [aria-pressed="true"]')}.dataset.value`), 'office');
    assert.equal(await evaluate(`${q('#lab-region [aria-pressed="true"]')}.dataset.value`), 'alaska');
    assert.equal(await evaluate(`${q('#lab-size')}.value`), '3');
    assert.equal(await evaluate(`${q('#lab-income')}.value`), '40000.00');
    assert.equal(await evaluate(`${q('#lab-gap')}.value`), '399.99');
    assert.equal(await evaluate(`${q('#lab-days')}.value`), '121');
    assert.equal(await evaluate(`location.hash.startsWith('#cbl=')`), true);
    await send('Page.reload');
    await wait(`!${q('#lab-panel')}.hidden && ${q('#lab-code')}.value === '70551'`, 'reload restores lab state');
    assert.equal(await evaluate(`${q('#lab-component [aria-pressed="true"]')}.dataset.value`), 'TC');
    assert.equal(await evaluate(`${q('#lab-setting [aria-pressed="true"]')}.dataset.value`), 'office');
    assert.equal(await evaluate(`${q('#lab-region [aria-pressed="true"]')}.dataset.value`), 'alaska');
    assert.equal(await evaluate(`${q('#lab-income')}.value`), '40000.00');
    assert.equal(await evaluate(`${q('#lab-gap')}.value`), '399.99');
    assert.equal(await evaluate(`${q('#lab-days')}.value`), '121');
    mark(`${width}x${height} #cbl= bookmark restores and survives reload`);

    await navigate(`${route}#sealed=v1.invalid.invalid`);
    await wait(`${q('#share-open-panel')} && !${q('#share-open-panel')}.hidden`, 'sealed panel still opens');
    await click('#discard-share');
    for (const hostile of ['#cbl=v1.c.__proto__', '#cbl=v1.h.9', '#cbl=v1.g.1e3', '#cbl=']) {
      await navigate(`${route}${hostile}`);
      await delay(150);
      assert.equal(await evaluate(`${q('#lab-code')}.value`), '70551', `hostile ${hostile} must not clobber lab state`);
      assert.equal(await evaluate(`${q('#lab-days')}.value`), '121', `hostile ${hostile} must not clobber lab days`);
    }
    mark(`${width}x${height} malformed and hostile hashes fail closed, sealed links unaffected`);

    assert.deepEqual(events.console, [], 'Console errors');
    assert.deepEqual(events.page, [], 'Page errors');
    assert.deepEqual(events.external, [], 'External requests');
    mark(`${width}x${height} 0 console errors, 0 page errors, 0 external requests, no horizontal overflow`);
  } finally {
    unsub.forEach(fn => fn());
    await cdp.command('Target.disposeBrowserContext', { browserContextId });
  }
}

let app, chrome, socket, scratch;
try {
  scratch = await mkdtemp('/tmp/cb-audit-');
  app = await serve(0);
  const response = await fetch(`${app.origin}/clearbill/`);
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${app.origin}/clearbill/src/sensitivity-lab.js`)).status, 200);
  const profile = join(scratch, 'profile');
  chrome = spawn(chromeBin, ['--headless=new', '--mute-audio', '--disable-background-networking', '--disable-extensions',
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  let exitError;
  chrome.on('error', error => { exitError = error; });
  const port = await waitFor(async () => {
    if (exitError) throw exitError;
    return readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  }, 'Chrome CDP port');
  const [number, endpoint] = port.trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${number}${endpoint}`);
  await once(socket, 'open');
  const cdp = new Session(socket);
  for (const [width, height] of [[1440, 900], [390, 844]]) await runViewport(cdp, app, width, height);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null && chrome.pid) {
    const closed = once(chrome, 'exit');
    chrome.kill();
    const stopped = await Promise.race([closed.then(() => true), delay(2000, false, { ref: false })]);
    if (!stopped) { chrome.kill('SIGKILL'); await closed; }
  }
  if (app) await app.close();
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
