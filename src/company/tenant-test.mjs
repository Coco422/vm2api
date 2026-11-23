import { keyScopeFromRequest, keyAllowsVm } from '../lib/admin/key-scope.mjs'
import { vmOwnerId } from '../lib/admin/resource-owner.mjs'

/** A panel test uses the tenant's existing credential and normal inference gates. */
export function tenantTestKey({ store, userId, vm }) {
  if (!userId || vmOwnerId(vm) !== userId) return null
  for (const rec of store.list()) {
    if (rec.user_id !== userId || rec.category === 'api' || !store.canAccept(rec).ok) continue
    if (!keyAllowsVm(keyScopeFromRequest({ apiKeyKind: 'managed', apiKeyRecord: rec }), vm)) continue
    const revealed = store.reveal(rec.id)
    if (revealed?.ok) return revealed.key
  }
  return null
}
