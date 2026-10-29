/** Runs in the inspected page. Reads only visible DOM, never application globals. */
export function readAuditPage(site) {
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const text = (selector) => {
    const el = document.querySelector(selector)
    return visible(el) ? el.innerText.trim() : ''
  }
  const ips = (root) => Array.from(root?.querySelectorAll('.ip-mask-target') || []).map((el) => el.textContent.trim())
  const body = (document.body?.innerText || '').slice(0, 16000)
  const challengeWidget = document.querySelector(
    '.cf-turnstile, #captcha-element, iframe[src^="https://challenges.cloudflare.com/"], iframe[src*="captcha"]',
  )
  const challenge =
    !!challengeWidget ||
    /Just a moment|Verify you are human|Checking your browser|验证您是真人|安全验证|人机验证/i.test(body)
  if (challenge) return { complete: false, error: 'challenge_required' }
  if (document.readyState === 'complete' && !body.trim() && !document.body?.children.length)
    return { complete: false, error: 'empty_response' }
  if (site === 'net-coffee') {
    const leak = (selector) => {
      const el = document.querySelector(selector)
      const tag = el?.querySelector('.risk-value .tag')
      return {
        complete: visible(tag) && !el.querySelector('.loading-bar'),
        text: visible(el) ? el.innerText.slice(0, 1200) : '',
        green: !!tag?.classList.contains('tag-safe'),
        warning: !!el?.querySelector('.tag-warn, .tag-danger'),
        ips: ips(el),
      }
    }
    const raw = text('#ipAddrClaude')
    const ip = raw.match(/(?:\d{1,3}\.){3}\d{1,3}|[\da-f]{0,4}:(?:[\da-f]{0,4}:){1,6}[\da-f]{0,4}/i)?.[0] || ''
    const score = text('#gaugeScore')
    return {
      complete: !!ip && /^\d/.test(score),
      ip,
      score,
      dns: leak('#dnsLeakContent'),
      webrtc: leak('#udpLeakContent'),
    }
  }
  if (site === 'fuck-claude') {
    const button = document.querySelector('#retest')
    const result = document.querySelector('#result')
    return {
      complete: visible(result) && !!button && !button.disabled && /again|再|重新|重测/i.test(button.innerText),
      score: text('#score-value'),
      details: text('#result-hits').slice(0, 1500),
    }
  }
  if (site === 'ping0') {
    const green = (color) => {
      const rgb = color.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/)
      if (!rgb || Math.max(+rgb[1], +rgb[2], +rgb[3]) - Math.min(+rgb[1], +rgb[2], +rgb[3]) <= 40) return null
      return +rgb[2] > 70 && +rgb[2] > +rgb[1] * 1.35 && +rgb[2] > +rgb[3] * 1.1
    }
    // Current Ping0 marks the selected risk band by background, and AI in scene cards.
    const selected = Array.from(document.querySelectorAll('.line-risk .riskcurrent')).filter(visible)
    const aiCards = Array.from(document.querySelectorAll('.line-sceneinfo .scene-card')).filter(
      (card) =>
        visible(card) &&
        /^AI\s*(?:应用|适用性|Applications?)?$/i.test(card.querySelector('.scene-name')?.innerText.trim() || ''),
    )
    if (selected.length === 1 || aiCards.length === 1) {
      const risk = selected.length === 1 ? selected[0] : null
      const advice = aiCards.length === 1 ? aiCards[0].querySelector('.advice') : null
      const ip = body.match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0] || ''
      return {
        complete: !!ip && visible(risk) && visible(advice),
        ip,
        purity_green: risk ? green(getComputedStyle(risk).backgroundColor) : null,
        ai_green: visible(advice) ? green(getComputedStyle(advice).color) : null,
        purity_text: visible(risk) ? risk.innerText.trim().slice(0, 300) : '',
        ai_text: visible(advice) ? advice.innerText.trim().slice(0, 300) : '',
        error: risk && visible(advice) ? null : 'unsupported_layout',
      }
    }
    // Fail closed on an unfamiliar layout. A green navigation link is not a result.
    const leaves = Array.from(document.querySelectorAll('body *')).filter((el) => visible(el) && !el.children.length)
    const field = (pattern) => {
      const labels = leaves.filter((el) => pattern.test(el.textContent.trim()))
      if (labels.length !== 1) return null
      let row = labels[0].parentElement
      for (let i = 0; row && i < 3; i++, row = row.parentElement) {
        if (row.innerText.length > 500) break
        const values = Array.from(row.querySelectorAll('*')).filter(
          (el) => visible(el) && !el.children.length && el !== labels[0] && el.textContent.trim(),
        )
        if (!values.length) continue
        const value = values.map((el) => el.textContent.trim()).join(' ')
        const colors = values.map((el) => getComputedStyle(el).color)
        const tones = colors.flatMap((c) => {
          const rgb = c.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/)
          if (!rgb || Math.max(+rgb[1], +rgb[2], +rgb[3]) - Math.min(+rgb[1], +rgb[2], +rgb[3]) <= 40) return []
          return [+rgb[2] > 70 && +rgb[2] > +rgb[1] * 1.35 && +rgb[2] > +rgb[3] * 1.1]
        })
        const green = !tones.length || (tones.some(Boolean) && !tones.every(Boolean)) ? null : tones.every(Boolean)
        return { text: value.slice(0, 300), green }
      }
      return null
    }
    const purity = field(/^(?:纯净度|IP纯净度|IP 纯净度|风控值)[：:]?$/)
    const ai = field(/^(?:AI|AI适用性|AI 适用性|AI适用|AI 适用)[：:]?$/i)
    const ip = body.match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0] || ''
    return {
      complete: !!ip && !!purity && !!ai,
      ip,
      purity_green: purity?.green ?? null,
      ai_green: ai?.green ?? null,
      purity_text: purity?.text || '',
      ai_text: ai?.text || '',
      error: purity && ai ? null : 'unsupported_layout',
    }
  }
  return { complete: false, error: 'unsupported_site' }
}
