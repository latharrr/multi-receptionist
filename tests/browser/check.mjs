// Browser check for the local prototype. Drives a real Chrome over the DevTools protocol:
// the whole setup flow by keyboard only at desktop width, then every screen at 320, 390 and 1280
// with overflow, clipping, label and focus-ring checks. Needs a fresh database each run:
//   PORT=3100 DATABASE_NAME=receptionist_browser pnpm dev        (drop that database first)
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/rc-chrome about:blank
//   pnpm test:browser
import { writeFileSync } from 'node:fs'
const BASE = 'http://127.0.0.1:3100'
const OUT = new URL('./shots/', import.meta.url).pathname
const target = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
const problems = []
const results = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id) pending.get(m.id)?.(m)
  if (m.method === 'Runtime.exceptionThrown') problems.push(`JS exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`)
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push(`console error: ${m.params.entry.text} ${m.params.entry.url ?? ''}`)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description}`)
  return r.result.value
}
const waitFor = async (expr, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(60)) if (await js(expr).catch(() => false)) return
  throw new Error(`timed out waiting for: ${what} (at ${await js('location.pathname')}; alert: ${await js(`[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent).join('|')`)})`)
}
const go = async (path) => {
  await send('Page.navigate', { url: BASE + path })
  await waitFor(`document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(BASE)}) && (!document.querySelector('script[src*=icons]') || !!document.querySelector('symbol'))`, `load ${path}`)
}
const size = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  await send('Emulation.setTouchEmulationEnabled', { enabled: w < 600 }) // phones report a coarse pointer
}
const key = async (k, code, vk, text) => {
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}
const tab = () => key('Tab', 'Tab', 9)
const enter = () => key('Enter', 'Enter', 13, '\r')
const space = () => key(' ', 'Space', 32, ' ')
const type = (text) => send('Input.insertText', { text })
// Reach an element using only the Tab key, and check the focus ring is visible on it.
const tabTo = async (selector, what = selector) => {
  await js(`document.activeElement?.blur(); window.scrollTo(0, 0)`)
  for (let i = 0; i < 120; i++) {
    await tab()
    const hit = await js(`(() => { const a = document.activeElement; if (!a || !a.matches(${JSON.stringify(selector)})) return null
      const s = getComputedStyle(a); const r = a.getBoundingClientRect()
      return { ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none', visible: r.width > 0 && r.bottom > 0 && r.top < innerHeight } })()`)
    if (hit) {
      if (!hit.ring) problems.push(`no visible focus ring on ${what} (${await js('location.pathname')})`)
      if (!hit.visible) problems.push(`focused element not scrolled into view: ${what}`)
      return
    }
  }
  throw new Error(`not reachable by Tab: ${what} on ${await js('location.pathname')}`)
}
const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`
const step = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`) } catch (e) { results.push(`FAIL  ${name}: ${e.message}`) }
  console.log(results.at(-1))
}
const audit = async (label) => {
  const r = await js(`(() => {
    const vw = innerWidth, out = []
    if (document.documentElement.scrollWidth > vw + 1) out.push('page scrolls sideways: ' + document.documentElement.scrollWidth + ' > ' + vw)
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg') && el.tagName !== 'svg') continue
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue
      const s = getComputedStyle(el); if (s.position === 'absolute' && r.width <= 1) continue
      const name = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : '')
      if (r.right > vw + 1 || r.left < -1) { let p = el.parentElement, scroll = false; while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { scroll = true; break } p = p.parentElement } if (!scroll) out.push('outside viewport: ' + name + ' ' + Math.round(r.left) + '..' + Math.round(r.right)) }
      if ((el.matches('button, a.btn, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')) && s.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1 && !el.matches('input, textarea, select')) out.push('clipped text: ' + name)
      if (el.matches('button, a.btn, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio])') && vw < 600 && r.height < 40) out.push('touch target under 40px: ' + name + ' ' + Math.round(r.height))
    }
    for (const i of document.querySelectorAll('input:not([type=hidden]), select, textarea')) if (!i.labels?.length && !i.getAttribute('aria-label')) out.push('unlabelled control: ' + (i.id || i.name))
    return [...new Set(out)].slice(0, 12)
  })()`)
  for (const p of r) problems.push(`[${label}] ${p}`)
}
const shot = async (name) => writeFileSync(`${OUT}${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.clearBrowserCookies')
await size(1280, 800)
let W = ''
const CLINIC = '# Bright Smile Dental\nOpening hours: Mon–Sat, 9am–6pm\nAddress: 12 Example Street\nConsultation fee: $40\n\nQ: Do you take walk-ins?\nA: Yes, before 4pm.'

// ---------------- keyboard-only flow at desktop width
await step('sign in from the local mailbox link (keyboard)', async () => {
  await go('/')
  await waitFor(`location.pathname === '/signin'`, 'redirect to sign-in')
  await tabTo('#email'); await type('owner@example.test'); await enter()
  await waitFor(`location.pathname === '/dev/mailbox'`, 'mailbox')
  await tabTo('a.btn[href*="magic-link/verify"]', 'sign-in link'); await enter()
  await waitFor(`location.pathname === '/workspaces'`, 'signed in')
})
await step('create a workspace (keyboard)', async () => {
  await tabTo('#name'); await type('Bright Smile Dental & Orthodontics of Greater Example Valley'); await enter()
  await waitFor(`/^\\/w\\/[0-9a-f-]{36}\\/business$/.test(location.pathname)`, 'workspace created')
  W = (await js('location.pathname')).replace('/business', '')
})
await step('add business text, answer one question, skip one (keyboard)', async () => {
  await tabTo('#text'); await type(CLINIC)
  await tabTo('form[data-api$="/sources"] button.primary', 'Add to draft'); await enter()
  await waitFor(has('5 facts found'), 'facts found')
  await tabTo('#answer'); await type('Check-ups, braces and whitening.'); await enter()
  await waitFor(has('Which phone number'), 'next question')
  await tabTo('button[name=skip]', 'Skip'); await enter()
  await waitFor(has('Which prices'), 'question after skip')
})
await step('upload a .md file and see a rejected .exe (mouse-free file set)', async () => {
  const doc = await send('DOM.getDocument'); const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' })
  writeFileSync(`${OUT}parking.md`, 'Parking: Free behind the building.'); writeFileSync(`${OUT}setup.exe`, 'MZ')
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [`${OUT}setup.exe`] })
  await tabTo('form[data-api$="/uploads"] button', 'Upload'); await enter()
  await waitFor(has('Only .md and .txt files are accepted'), 'exe rejected')
  const doc2 = await send('DOM.getDocument'); const node2 = await send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#file' })
  await send('DOM.setFileInputFiles', { nodeId: node2.nodeId, files: [`${OUT}parking.md`] })
  await tabTo('form[data-api$="/uploads"] button', 'Upload'); await enter()
  await waitFor(has('parking.md'), 'upload listed')
})
await step('private web address is refused with an inline message (keyboard)', async () => {
  await tabTo('#url'); await type('https://192.168.0.1/menu'); await enter()
  await waitFor(has('Private, local and numeric addresses are not accepted'), 'inline error')
})
await step('review: accept all, publish version 1 (keyboard)', async () => {
  await go(`${W}/knowledge`)
  await tabTo('form[data-method=PATCH] button.sm', 'Accept all'); await enter()
  await waitFor(`!document.body.innerText.includes('Needs review')`, 'all accepted')
  await tabTo('form[data-api$="/knowledge/publish"] button', 'Publish'); await enter()
  await waitFor(has('Version 1 published'), 'published')
})
await step('review: edit one fact and remove another with their own buttons (keyboard)', async () => {
  await tabTo('.fact textarea'); await js(`document.activeElement.select()`); await type('12 Example Street, behind the library')
  await tabTo('.fact button[value=accepted]', 'Save change'); await enter()
  await waitFor(has('Changed, not published'), 'edit kept as draft')
  const before = await js(`document.querySelectorAll('.fact').length`)
  await tabTo('.fact button[value=rejected]', 'Remove'); await enter()
  await waitFor(`document.querySelectorAll('.fact').length === ${before - 1}`, 'fact removed')
  await waitFor(has('Publishing will remove'), 'removal previewed')
})
await step('test chat is refused until a spending limit is set, then answers (keyboard)', async () => {
  await go(`${W}/test`)
  await tabTo('#message'); await type('Are you open on Saturday?'); await tabTo('form.composer button', 'Ask'); await enter()
  await waitFor(has('Set a spending limit first'), 'limit required')
  await go(`${W}/usage`)
  await tabTo('#amount'); await type('5'); await enter()
  await waitFor(has('of $5.00'), 'limit saved')
  await go(`${W}/test`)
  await tabTo('#message'); await type('Are you open on Saturday?'); await tabTo('form.composer button', 'Ask'); await enter()
  await waitFor(has('Mon–Sat, 9am–6pm'), 'answer from fact')
  await tabTo('#message'); await type('How much is whitening?'); await tabTo('form.composer button', 'Ask'); await enter()
  await waitFor(has('would go to staff'), 'handoff for unknown')
})
await step('assistant settings: save draft and publish (keyboard)', async () => {
  await go(`${W}/assistant`)
  await tabTo('#handoff_message'); await js(`document.activeElement.select()`); await type('Let me get a colleague to answer that here.')
  await tabTo('input[name=field_email]', 'Email checkbox'); await space()
  await tabTo('form[data-method=PATCH] button', 'Save draft'); await enter()
  await waitFor(has('You have saved changes'), 'draft saved')
  await tabTo('form[data-api$="/behavior/publish"] button', 'Publish'); await enter()
  await waitFor(has('Version 1 published'), 'behaviour published')
})
await step('AI provider: save provider, long model ID, key is masked (keyboard)', async () => {
  await go(`${W}/ai`)
  await tabTo('#model_id'); await type('vendor/an-extremely-long-model-identifier-with-many-parts:2026-11-12-preview'); await enter()
  await waitFor(`!!document.querySelector('#api_key')`, 'config saved')
  await tabTo('#api_key'); await type(['sk', 'test', 'SYNTHETIC', 'KEY', '9f3a'].join('-')); await enter()
  await waitFor(has('••••••••9f3a'), 'masked key')
  if (await js(`document.documentElement.outerHTML.includes('SYNTHETIC-KEY')`)) throw new Error('key present in page')
  await tabTo('form[data-api$="/tests"] button', 'Run mock check'); await enter()
  await waitFor(has('Mock check passed'), 'mock check')
  if (!(await js(`document.querySelector('.actions-row button[disabled]')?.textContent.includes('Run live check')`))) throw new Error('live check should be disabled')
})
await step('WhatsApp: unofficial route needs consent; mock link connects (keyboard)', async () => {
  await go(`${W}/whatsapp`)
  await tabTo('article:nth-of-type(2) button', 'mock connection (unofficial)'); await enter()
  await waitFor(has('not an official WhatsApp integration'), 'disclosure')
  await tabTo('#authorized_number'); await type('+15550100'); await enter()
  await sleep(300)
  if (!(await js(has('not an official WhatsApp integration')))) throw new Error('continued without consent')
  await tabTo('input[name=accept]', 'consent checkbox'); await space()
  await tabTo('form[data-api$="/start"] button', 'Continue'); await enter()
  await waitFor(has('There is nothing to scan'), 'placeholder code')
  await tabTo('form[data-api$="/mock-link"] button.primary', 'Simulate link'); await enter()
  await waitFor(has('••• 0100'), 'connected')
})
let conv = ''
await step('inbox: simulated customer, reply, takeover, staff reply, hand back (keyboard)', async () => {
  await go(`${W}/inbox`)
  await tabTo('.convs summary', 'simulate disclosure'); await enter()
  await tabTo('#sim-new'); await type('What are your opening hours?'); await enter()
  await waitFor(`/inbox\\/[0-9a-f-]{36}$/.test(location.pathname) && ${has('Accepted by the mock')}`, 'bot reply shown')
  conv = await js('location.pathname')
  await tabTo('form[data-api$="/takeover"] button', 'Take over'); await enter()
  await waitFor(has('You’re replying'), 'human mode')
  await tabTo('#reply'); await type('Hi, this is Priya from the clinic.'); await tabTo('form.composer button', 'Send'); await enter()
  await waitFor(has('Hi, this is Priya from the clinic.') + ` && ${has('Staff ·')}`, 'staff message')
  await tabTo('.thread summary', 'simulate next'); await enter()
  await tabTo('#sim-next'); await type('Thanks! And what are your hours again?'); await enter()
  await waitFor(`document.querySelectorAll('.bubble:not(.out)').length === 2`, 'second inbound')
  if ((await js(`document.querySelectorAll('.bubble.out').length`)) !== 2) throw new Error('assistant replied during staff mode')
  await tabTo('form[data-api$="/resume"] button', 'Hand back'); await enter()
  await waitFor(has('The assistant is answering this chat'), 'bot mode')
})
await step('handoff reaches Home and Enquiries; enquiry status changes (keyboard)', async () => {
  await tabTo('.thread summary', 'simulate next'); await enter()
  await tabTo('#sim-next'); await type('My name is Priya Shah, priya@example.test. Can someone call me about braces?'); await enter()
  await waitFor(has('Waiting for staff: Customer asked for a person'), 'handoff banner')
  await waitFor(has('Let me get a colleague to answer that here.'), 'published handoff message used')
  await go(W); await waitFor(has('Customer asked for a person'), 'home waiting list')
  await go(`${W}/enquiries`); await waitFor(has('Priya Shah · priya@example.test'), 'enquiry details')
  await tabTo('select[name=status]'); await key('o', 'KeyO', 79, 'o'); await tabTo('td form button', 'Save status'); await enter()
  await waitFor(`document.querySelector('td .status')?.textContent.includes('Open')`, 'status open')
})
await step('pause and resume from the sidebar (keyboard)', async () => {
  await go(W)
  await tabTo('.side form[data-api$="/pause"] button', 'Pause'); await enter()
  await waitFor(has('Replies are paused'), 'paused')
  await go(conv)
  await tabTo('.thread summary', 'simulate'); await enter(); await tabTo('#sim-next'); await type('Are you open now?'); await enter()
  await sleep(600)
  const outs = await js(`document.querySelectorAll('.bubble.out').length`)
  await go(conv)
  if ((await js(`document.querySelectorAll('.bubble.out').length`)) !== outs) throw new Error('reply count changed')
  await tabTo('.side form[data-api$="/resume-replies"] button', 'Resume'); await enter()
  await waitFor(has('Test mode'), 'resumed')
})
await step('workspace switcher and sign out (keyboard)', async () => {
  await tabTo('.side a.ws', 'workspace switcher'); await enter()
  await waitFor(`location.pathname === '/workspaces'`, 'workspaces')
  await go(W)
})

// ---------------- every screen at three widths
const pages = { home: W, business: `${W}/business`, knowledge: `${W}/knowledge`, assistant: `${W}/assistant`, ai: `${W}/ai`, usage: `${W}/usage`, whatsapp: `${W}/whatsapp`, test: `${W}/test`, inbox: `${W}/inbox`, thread: conv, enquiries: `${W}/enquiries`, notbuilt: `${W}/not-built`, workspaces: '/workspaces', mailbox: '/dev/mailbox', missing: '/w/00000000-0000-4000-8000-000000000000' }
for (const [w, h] of [[320, 640], [390, 844], [1280, 800]]) {
  await size(w, h)
  for (const [name, path] of Object.entries(pages)) {
    await go(path); await sleep(120)
    await audit(`${name}@${w}`)
    await shot(`${name}-${w}`)
  }
  // Narrow widths by touch-sized taps: the composer and Send must be on screen and usable.
  await step(`thread at ${w}px: composer and Send fit and work (click)`, async () => {
    await go(conv)
    await js(`document.querySelector('form[data-api$="/takeover"] button').click()`)
    await waitFor(has('You’re replying'), 'human mode')
    const fit = await js(`(() => { const ok = (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.width > 40 }
      return ok(document.querySelector('#reply')) && ok(document.querySelector('form.composer button')) && [...document.querySelectorAll('.bubble')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth }) })()`)
    if (!fit) throw new Error('composer, Send or a bubble is off screen')
    await js(`document.querySelector('#reply').focus()`); await type(`Reply typed at ${w}px, long enough to wrap onto a second line in the composer.`)
    const r = await js(`(() => { const b = document.querySelector('form.composer button').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await waitFor(has(`Reply typed at ${w}px`) + ` && document.querySelector('#reply').value === ''`, 'sent')
    await audit(`thread-human@${w}`); await shot(`thread-human-${w}`)
    await js(`document.querySelector('form[data-api$="/resume"] button').click()`)
    await waitFor(has('The assistant is answering this chat'), 'handed back')
  })
}
console.log(`\nPROBLEMS (${problems.length}):\n${[...new Set(problems)].join('\n')}`)
ws.close()
