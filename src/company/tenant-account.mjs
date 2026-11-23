import { twoFactorKey } from '../lib/core/panel-2fa.mjs'
import { getPanelAdmin } from '../lib/core/security.mjs'
import { assertPassword, assertUsername, hashPassword, verifyPassword } from '../lib/admin/panel-users.mjs'
import { loadOnboardingState, saveOnboardingState } from '../lib/admin/onboarding.mjs'
import { SettingsRepo } from '../lib/db/repos/settings-repo.mjs'

function accountError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

export function updateTenantAccount(panelUsers, { userId, username }, body) {
  const fields = ['current_password', 'username', 'password']
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.entries(body).some(([key, value]) => !fields.includes(key) || typeof value !== 'string') ||
    !body.current_password ||
    body.current_password.length > 128
  ) {
    throw accountError(400, 'invalid_account_update', '请输入当前密码，只能修改本人用户名和密码')
  }

  const current = panelUsers.getById(userId)
  if (!current?.enabled || current.role !== 'user' || current.username !== username) {
    throw accountError(403, 'account_update_forbidden', '当前会话不能修改此账号')
  }
  if (!verifyPassword(body.current_password, current.password_hash)) {
    throw accountError(403, 'incorrect_current_password', '当前密码不正确')
  }

  const nextUsername = body.username === undefined ? current.username : assertUsername(body.username)
  const renamed = nextUsername !== current.username
  const adminUsername = getPanelAdmin().username.trim().toLowerCase()
  if (renamed && current.username.toLowerCase() === adminUsername) {
    throw accountError(403, 'account_update_forbidden', '系统管理员的登录名不可修改')
  }
  if (renamed && nextUsername.toLowerCase() === adminUsername) {
    throw accountError(409, 'username_exists', '用户名已被使用')
  }
  const passwordHash = body.password === undefined ? current.password_hash : hashPassword(assertPassword(body.password))
  if (!renamed && body.password === undefined) {
    throw accountError(400, 'account_update_empty', '请输入新用户名或新密码')
  }

  const { db, repo } = panelUsers
  db.exec('BEGIN IMMEDIATE')
  try {
    const latest = repo.getById(userId)
    if (
      !latest?.enabled ||
      latest.role !== 'user' ||
      latest.username !== username ||
      latest.password_hash !== current.password_hash
    ) {
      throw accountError(409, 'account_changed', '账号已变更，请重新登录后再试')
    }
    const next = {
      ...latest,
      username: nextUsername,
      password_hash: passwordHash,
      updated_at: new Date().toISOString(),
    }
    if (renamed && latest.email === `${username}@panel.local`) next.email = `${nextUsername}@panel.local`
    repo.update(next)

    if (renamed) {
      const settings = new SettingsRepo(db)
      const oldFactor = twoFactorKey(username)
      const newFactor = twoFactorKey(nextUsername)
      if (oldFactor !== newFactor) {
        settings.remove(newFactor)
        db.prepare('UPDATE settings SET key = ? WHERE key = ?').run(newFactor, oldFactor)
      }
      const state = loadOnboardingState(settings)
      const hadPrevious = Object.hasOwn(state, username)
      if (hadPrevious || Object.hasOwn(state, nextUsername)) {
        if (hadPrevious) state[nextUsername] = state[username]
        else delete state[nextUsername]
        delete state[username]
        saveOnboardingState(settings, state)
      }
    }
    db.exec('COMMIT')
    return nextUsername
  } catch (error) {
    db.exec('ROLLBACK')
    if (
      error.message.includes('UNIQUE constraint failed: users.username') ||
      error.message.includes('UNIQUE constraint failed: users.email')
    ) {
      throw accountError(409, 'username_exists', '用户名已被使用')
    }
    throw error
  }
}
