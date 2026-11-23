import type { MeResponse } from '@/types/panel-auth'
import { create } from 'zustand'
import { logoutRequest } from '@/lib/api'
import {
  clearSession,
  hasSession,
  sessionToken,
  setSession,
  storedUser,
} from '@/lib/session'

type AuthState = {
  token: string
  user: string
  me: MeResponse | null
  setMe: (me: MeResponse | null) => void
  signIn: (token: string, user: string) => void
  signOut: (options?: { localOnly?: boolean }) => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  token: sessionToken(),
  user: storedUser(),
  me: null,
  setMe: (me) =>
    set({
      me,
      user: me?.user || storedUser(),
    }),
  signIn: (token, user) => {
    setSession(token, user)
    set({ token, user, me: null })
  },
  signOut: (options) => {
    if (!options?.localOnly) logoutRequest()
    clearSession()
    set({ token: '', user: '', me: null })
  },
}))

export function isSignedIn(): boolean {
  return hasSession()
}
