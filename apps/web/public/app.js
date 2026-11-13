// Forms marked data-api send JSON to the control API, then reload or go to data-next.
async function call(url, method, body, headers) {
  const res = await fetch(url, { method, body, headers })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error?.message || json.message || 'Something went wrong. Try again.')
  return 'data' in json ? json.data : json
}
document.addEventListener('submit', async (e) => {
  const form = e.target
  if (!form.dataset.api) return
  e.preventDefault()
  const btn = e.submitter
  const err = form.querySelector('[role=alert]')
  if (err) err.textContent = ''
  // Read the form before disabling the button: a disabled button's name and value are left out.
  const fields = Object.fromEntries(new FormData(form, btn))
  if (btn) btn.disabled = true
  try {
    let data
    const picker = form.querySelector('input[type=file]')
    if (picker) {
      if (picker.files.length > 10) throw new Error('Choose up to 10 files at a time.')
      for (const f of picker.files)
        data = await call(form.dataset.api, 'POST', f, { 'Content-Type': 'text/plain', 'X-Filename': encodeURIComponent(f.name) })
    } else {
      data = await call(form.dataset.api.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(fields[k] ?? '')), form.dataset.method || 'POST', JSON.stringify(fields), { 'Content-Type': 'application/json' })
    }
    const next = form.dataset.next?.replace('{id}', data?.id ?? data?.conversation_id ?? '')
    if (next) location.href = next
    else location.reload()
  } catch (x) {
    if (err) err.textContent = x.message
    if (btn) btn.disabled = false
  }
})
document.querySelector('.msgs')?.scrollTo(0, 1e9)
// Pages waiting on something outside the browser (a QR code, a provider check) reload themselves.
const waiting = document.querySelector('[data-refresh]')
if (waiting) setTimeout(() => location.reload(), waiting.dataset.refresh * 1000)
