import { extractApiKey, extractPanelToken, verifyPanelSession, timingSafeEqualStr } from './security.mjs'
import { makeError, ErrorType, ErrorCode } from './errors.mjs'
import { makeApiKeyGateError } from '../admin/api-keys.mjs'

/** Panel sessions are accepted only on panel routes; inference must pass managed-key gates. */
export function createRequestAuth({ cfg, apiKeyStore, panelUsers, allowRate, json, validateManagedKey, resolveBuyer }) {
  function rejectAuth(req, res, error) {
    req.authError = {
      code: error?.body?.error?.code || ErrorCode.INVALID_API_KEY,
      message: error?.body?.error?.message || 'Invalid credentials',
      status: error?.status || 401,
    }
    for (const [name, value] of Object.entries(error.headers || {})) {
      if (value != null) res.setHeader?.(name, value)
    }
    json(res, error.status, error.body)
    return false
  }

  function rejectBuyer(res, optionalBuyer) {
    if (!optionalBuyer)
      json(res, 403, { ok: false, error: { code: 'shop_login_required', message: 'Admin login required' } })
    return false
  }

  function authenticate(req, res, allowPanelSession, { keyGate = true, buyer = false, optionalBuyer = false } = {}) {
    req.presentedApiKey = extractApiKey(req)
    const token = allowPanelSession ? extractPanelToken(req) || req.presentedApiKey : req.presentedApiKey
    if (!token) {
      if (buyer) return rejectBuyer(res, optionalBuyer)
      return rejectAuth(
        req,
        res,
        makeError({
          type: ErrorType.AUTH,
          code: ErrorCode.MISSING_API_KEY,
          message: allowPanelSession
            ? 'Missing credentials. Login at /api/panel/login or provide Authorization Bearer token.'
            : 'Missing API key. Provide Authorization Bearer token or x-api-key.',
          status: 401,
        }),
      )
    }
    // Panel session
    const session = allowPanelSession ? verifyPanelSession(token) : null
    if (session) {
      const rec = panelUsers.getByUsername(session.user)
      if (buyer) {
        const owner = (rec?.role || session.role) === 'admin' ? resolveBuyer?.(session, rec) : null
        if (!owner) return rejectBuyer(res, optionalBuyer)
        req.panelBuyerOwner = owner
      }
      if (!allowRate('panel:' + session.user)) {
        return rejectAuth(
          req,
          res,
          makeError({
            type: ErrorType.RATE_LIMIT,
            code: ErrorCode.GATEWAY_RATE_LIMIT,
            message: 'Gateway rate limit exceeded. Retry later.',
            status: 429,
          }),
        )
      }
      req.panelUser = session.user
      req.panelRole = session.role || panelUsers.getByUsername(session.user)?.role || 'user'
      req.panelUserId = rec?.id || null
      req.panelVmCreateQuota = rec?.vm_create_quota ?? 0
      return true
    }
    if (buyer) return rejectBuyer(res, optionalBuyer)
    // Master key uses the gateway bucket only when explicitly configured.
    if (timingSafeEqualStr(token, cfg.api_key)) {
      if (keyGate && cfg.limits?.rate_capacity_explicit && !allowRate(token)) {
        return rejectAuth(
          req,
          res,
          makeError({
            type: ErrorType.RATE_LIMIT,
            code: ErrorCode.GATEWAY_RATE_LIMIT,
            message: 'Gateway rate limit exceeded. Retry later.',
            status: 429,
          }),
        )
      }
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      req.panelUser = 'master'
      return true
    }

    // Managed multi-keys (sub2api-style)
    const managed = apiKeyStore.authenticate(token)
    if (!managed.ok) {
      return rejectAuth(
        req,
        res,
        makeError({
          type: ErrorType.AUTH,
          code: ErrorCode.INVALID_API_KEY,
          message: 'Invalid credentials',
          status: 401,
        }),
      )
    }
    const keyError = validateManagedKey?.(req, managed.record)
    if (keyError) return rejectAuth(req, res, keyError)
    const gate = keyGate ? apiKeyStore.canAccept(managed.record) : { ok: true }
    if (!gate.ok) {
      return rejectAuth(req, res, makeApiKeyGateError(gate))
    }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = managed.record
    return true
  }

  return {
    requireAuth: (req, res, options) => authenticate(req, res, true, options),
    requireProtocolAuth: (req, res, options) => authenticate(req, res, false, options),
  }
}
