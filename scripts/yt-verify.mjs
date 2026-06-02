/**
 * yt-verify — automated visual + DOM diagnostic for the v0.3 webview player.
 *
 * WHY: tight feedback loop without hand-testing. Launches the BUILT app with a
 * PERSISTENT profile (so the SOCS cookie + any consent persist across runs → no
 * bot/consent wall), opens a real video, dumps guest DOM state as JSON, and writes
 * screenshots to /tmp/yt-verify/*.png (readable by the agent). Also reproduces the
 * "click the video → goes black" bug by issuing a REAL mouse click at the webview.
 *
 * Run (after `npx electron-vite build && pnpm rebuild:electron`):
 *   DISPLAY=:0 node scripts/yt-verify.mjs            # default video
 *   DISPLAY=:0 YT_VIDEO=EdKTZ7WsaiY node scripts/yt-verify.mjs
 *
 * NOT a test (no asserts) — a manual diagnostic. Delete before merge or keep behind
 * the smoke gate. Persistent profile dir is reused on purpose; delete it to reset.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const VIDEO_ID = process.env.YT_VIDEO || 'M7lc1UVf-VE'
const PROFILE = '/tmp/linsae-yt-verify-profile' // PERSISTENT across runs
const OUT = '/tmp/yt-verify'
mkdirSync(OUT, { recursive: true })

const log = (...a) => console.log('[yt-verify]', ...a)

// --disable-blink-features=AutomationControlled hides navigator.webdriver from the
// guest so YouTube doesn't bounce the (Playwright-launched) session to its home page.
const app = await electron.launch({
  args: [
    'out/main/index.js',
    '--disable-blink-features=AutomationControlled',
    `--user-data-dir=${PROFILE}`,
  ],
})

/** Run JS inside the YouTube guest webview (returns the evaluated value). */
const guest = (win, code) =>
  win.evaluate(async (c) => {
    const wv = document.querySelector('#yt-player-wrapper webview')
    if (!wv) return { __noWebview: true }
    try {
      return await wv.executeJavaScript(c)
    } catch (e) {
      return { __err: String(e) }
    }
  }, code)

const PROBE = `(function(){
  var v=document.querySelector('#movie_player video');
  var mp=document.getElementById('movie_player');
  var cs=mp?getComputedStyle(mp):null;
  var kids=mp?Array.prototype.slice.call(mp.children).map(function(c){var s=getComputedStyle(c);return (c.className||c.tagName).toString().slice(0,30)+' op='+s.opacity+' pe='+s.pointerEvents+' disp='+s.display;}):[];
  var mast=document.querySelector('#masthead-container,ytd-masthead');
  return {
    url: location.href,
    webdriver: navigator.webdriver,
    consent: !!document.querySelector('ytd-consent-bump-v2-lightbox'),
    hasVideo: !!v,
    paused: v?v.paused:null,
    currentTime: v?Math.round(v.currentTime*10)/10:null,
    readyState: v?v.readyState:null,
    videoWH: v?(v.videoWidth+'x'+v.videoHeight):null,
    videoRect: v?(function(){var r=v.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height);})():null,
    videoOpacity: v?getComputedStyle(v).opacity:null,
    videoDisplay: v?getComputedStyle(v).display:null,
    mpPosition: cs?cs.position:null, mpInset: cs?(cs.top+' '+cs.left):null, mpZ: cs?cs.zIndex:null,
    mastDisplay: mast?getComputedStyle(mast).display:'(absent)',
    kids: kids
  };
})()`

const report = async (win, label) => {
  const s = await guest(win, PROBE)
  log(`--- ${label} ---`)
  log(JSON.stringify(s, null, 2))
  await win.screenshot({ path: join(OUT, `${label}.png`) })
  log(`screenshot → ${join(OUT, `${label}.png`)}`)
  return s
}

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  log('origin', await win.evaluate(() => location.origin))

  await win.evaluate(
    async ({ videoId }) => {
      await window.api.notes.create({
        body: '',
        type: 'source',
        source_kind: 'youtube',
        source_locator: { media: 'youtube', video_id: videoId },
      })
      await window.api.videoSources.upsert({
        videoId,
        sourceKind: 'youtube',
        title: 'Verify Video',
        channel: 'Chan',
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      })
    },
    { videoId: VIDEO_ID },
  )
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  const open = win.getByRole('button', { name: /open video notes/i }).first()
  await open.waitFor({ timeout: 20000 })
  await open.click()
  log('thread opened')

  // Wait for the webview to exist + dom-ready + guest to settle.
  await win.waitForFunction(() => !!document.querySelector('#yt-player-wrapper webview'), {
    timeout: 30000,
  })

  // Poll until the guest reports a loaded video ON the watch page (or give up → bot wall).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const s = await guest(
      win,
      `({url:location.href, rs:(document.querySelector('#movie_player video')||{}).readyState||0, wd:navigator.webdriver})`,
    )
    log(`load-poll ${i + 1}/20`, JSON.stringify(s))
    if (typeof s?.url === 'string' && s.url.includes('/watch') && s.rs >= 1) break
  }

  await report(win, '1-after-open')

  // Find the stacking-context TRAP: walk #movie_player's ancestors and report any
  // that create a containing block / stacking context for its position:fixed.
  const chain = await guest(
    win,
    `(function(){var el=document.getElementById('movie_player');var out=[];while(el&&el!==document.documentElement){var s=getComputedStyle(el);if(s.transform!=='none'||s.contain!=='none'&&s.contain!=='normal'||s.willChange!=='auto'||s.filter!=='none'||s.perspective!=='none'||s.position!=='static'||s.zIndex!=='auto'){out.push((el.id||el.tagName)+' pos='+s.position+' tf='+(s.transform==='none'?'-':'Y')+' contain='+s.contain+' wc='+s.willChange+' filter='+(s.filter==='none'?'-':'Y')+' z='+s.zIndex);}el=el.parentElement;}return out;})()`,
  )
  log('ancestor chain (stacking-relevant):')
  log(JSON.stringify(chain, null, 2))

  // Press our play button (TransportBar) so the video is actually playing.
  try {
    await win.getByRole('button', { name: /^play$/i }).click({ timeout: 3000 })
    log('clicked TransportBar play')
  } catch (e) {
    log('no play button / already playing:', String(e))
  }
  await new Promise((r) => setTimeout(r, 4000))
  await report(win, '2-after-play')

  // Reproduce the bug: a REAL mouse click in the CENTER of the webview (the video).
  const rect = await win.evaluate(() => {
    const wv = document.querySelector('#yt-player-wrapper webview')
    const r = wv.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  // Only click if we're actually ON the watch page — clicking the center while bounced
  // to the home page lands on a recommendation thumbnail and navigates to a random video.
  const cur = await guest(win, 'location.href')
  if (typeof cur === 'string' && cur.includes('/watch')) {
    log('webview rect', JSON.stringify(rect))
    await win.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2)
    log('clicked video center')
  } else {
    log('SKIP video click — not on /watch (url=' + cur + ')')
  }
  await new Promise((r) => setTimeout(r, 2500))
  await report(win, '3-after-video-click')
} catch (e) {
  console.error('[yt-verify] ERROR', e)
} finally {
  await app.close()
}
