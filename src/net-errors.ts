/**
 * Turn a network failure into something a human can act on.
 *
 * Node's `fetch` reports every failure below the HTTP layer the same way:
 * `TypeError: fetch failed`, with the real reason hidden in `error.cause`.
 * Undici puts the DNS/TCP/TLS code there — `ENOTFOUND`, `ECONNRESET`,
 * `ETIMEDOUT`, `CERT_HAS_EXPIRED` — and that code is the difference between
 * "换台机器" and "等一会儿就好".
 *
 * The plugin used to write that raw string into `state.json` as `lastError`,
 * which is how a transient DNS hiccup ended up as a permanent "fetch failed"
 * on the card with no way to tell what went wrong.
 */

/** Pull the machine-readable reason out of an error, however it is wrapped. */
function codeOf(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) return undefined
    seen.add(current)
    const record = current as { code?: unknown; cause?: unknown }
    if (typeof record.code === 'string' && record.code !== '') return record.code
    current = record.cause
  }
  return undefined
}

/** The message of the innermost cause, which is the informative one. */
function causeMessageOf(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) return undefined
    seen.add(current)
    const record = current as { message?: unknown; cause?: unknown }
    if (typeof record.message === 'string' && record.message !== '' && record.message !== 'fetch failed') {
      return record.message
    }
    current = record.cause
  }
  return undefined
}

const CAUSE_TEXT: Record<string, string> = {
  ENOTFOUND: '域名解析失败（本机 DNS 解析不出 opencode.ai）',
  EAI_AGAIN: '域名解析暂时失败（DNS 服务器没应答，稍后重试即可）',
  ECONNRESET: '连接被重置（代理或上游中途断了连接）',
  ECONNREFUSED: '连接被拒绝（对方端口没在监听）',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达（网络出口不通）',
  ENETUNREACH: '网络不可达',
  EPROTO: 'TLS 协议协商失败（代理拦了这条连接）',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名对不上（中间人代理或 DNS 被改写）',
  CERT_HAS_EXPIRED: '证书已过期（代理或上游证书有问题）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败（代理做了 HTTPS 解密但证书签发不对）',
  DEPTH_ZERO_SELF_SIGNED_CERT: '证书自签名，校验失败',
}

/**
 * Describe a failed request in one sentence.
 *
 * Anything that is not recognisably a network failure keeps its own message:
 * an HTTP error from the gateway ("answered HTTP 503") is already clear and
 * must not be dressed up as a DNS problem.
 */
export function describeNetworkError(error: unknown): string {
  if (error === undefined || error === null) return '网络请求失败'
  const err = error instanceof Error ? error : new Error(String(error))
  const code = codeOf(err)
  if (code !== undefined && CAUSE_TEXT[code] !== undefined) {
    return `${CAUSE_TEXT[code]}（${code}）`
  }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return '请求超时（没在预算内等到答复）'
  }
  if (err.name === 'TypeError' && err.message === 'fetch failed') {
    const detail = causeMessageOf(err)
    return detail === undefined ? '网络请求失败（连接没能建立）' : `网络请求失败：${detail}`
  }
  return err.message === '' ? '网络请求失败' : err.message
}
