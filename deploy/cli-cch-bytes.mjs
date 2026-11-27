// Preserve the upstream CCH projection byte for byte, compacting one UTF-8 buffer.
// JSON syntax delimiters are ASCII, so byte scanning preserves non-ASCII text.
export function projectCchBytes(body) {
  let bytes = Buffer.from(body, 'utf8')
  const model = Buffer.from('"model":"')
  let read = 0
  let write = 0
  for (;;) {
    const at = bytes.indexOf(model, read)
    if (at < 0) {
      bytes.copyWithin(write, read)
      write += bytes.length - read
      break
    }
    let end = at + model.length
    while (end < bytes.length) {
      if (bytes[end] === 92 && end + 1 < bytes.length) {
        end += 2
        continue
      }
      if (bytes[end] === 34) break
      end++
    }
    bytes.copyWithin(write, read, at + model.length)
    write += at + model.length - read
    read = end
  }
  bytes = bytes.subarray(0, write)

  const cut = (start, end) => {
    if (end < bytes.length && bytes[end] === 44) end++
    else if (start > 0 && bytes[start - 1] === 44) start--
    bytes.copyWithin(start, end)
    bytes = bytes.subarray(0, bytes.length - (end - start))
  }
  const fallbacks = Buffer.from('"fallbacks":[')
  const fallbackAt = bytes.indexOf(fallbacks)
  if (fallbackAt >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = fallbackAt + fallbacks.length - 1; i < bytes.length; i++) {
      const c = bytes[i]
      if (inString) {
        if (escaped) escaped = false
        else if (c === 92) escaped = true
        else if (c === 34) inString = false
      } else if (c === 34) inString = true
      else if (c === 91) depth++
      else if (c === 93 && --depth === 0) {
        cut(fallbackAt, i + 1)
        break
      }
    }
  }
  const credit = Buffer.from('"fallback_credit_token":"')
  const creditAt = bytes.indexOf(credit)
  if (creditAt >= 0) {
    for (let i = creditAt + credit.length; i < bytes.length; i++) {
      if (bytes[i] === 92 && i + 1 < bytes.length) {
        i++
        continue
      }
      if (bytes[i] === 34) {
        cut(creditAt, i + 1)
        break
      }
    }
  }
  const maxTokens = Buffer.from('"max_tokens":')
  const maxAt = bytes.indexOf(maxTokens)
  if (maxAt >= 0) {
    let end = maxAt + maxTokens.length
    const start = end
    while (end < bytes.length && bytes[end] >= 48 && bytes[end] <= 57) end++
    if (end > start) cut(maxAt, end)
  }
  return bytes
}
