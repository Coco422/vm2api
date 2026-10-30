import { extractApiKey, extractPanelToken, verifyPanelSession, timingSafeEqualStr } from './security.mjs'
import { makeError, ErrorType, ErrorCode } from './errors.mjs'

/** Panel sessions are accepted only on panel routes; inference must pass managed-key gates. */
export function createRequestAuth({ cfg, apiKeyStore, panelUsers, allowRate, json }) {
  function rejectAuth(req, res, error) {
    req.authError = {
      code: error?.body?.error?.code || ErrorCode.INVALID_API_KEY,
      message: error?.body?.error?.message || 'Invalid credentials',
      status: error?.status || 401,
    }
    json(res, error.status, error.body)
    return false
  }

  function authenticate(req, res, allowPanelSession) {
    req.presentedApiKey = extractApiKey(req)
    const token = allowPanelSession ? extractPanelToken(req) || req.presentedApiKey : req.presentedApiKey
    if (!token) {
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
      const rec = panelUsers.getByUsername(session.user)
      req.panelUserId = rec?.id || null
      req.panelVmCreateQuota = rec?.vm_create_quota ?? 0
      return true
    }
    // Master env API key — unlimited admin
    if (timingSafeEqualStr(token, cfg.api_key)) {
      if (!allowRate(token)) {
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
    const gate = apiKeyStore.canAccept(managed.record)
    if (!gate.ok) {
      const type =
        gate.status === 429
          ? gate.code.includes('quota')
            ? ErrorType.QUOTA
            : ErrorType.RATE_LIMIT
          : ErrorType.PERMISSION
      return rejectAuth(
        req,
        res,
        makeError({
          type,
          code: gate.code,
          message: gate.message,
          status: gate.status,
          details: gate.detail || undefined,
        }),
      )
    }
    if (!allowRate(token)) {
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
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = managed.record
    return true
  }

  return {
    requireAuth: (req, res) => authenticate(req, res, true),
    requireProtocolAuth: (req, res) => authenticate(req, res, false),
  }
}
