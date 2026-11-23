import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function TenantAccountDialog({
  currentUsername,
  onClose,
}: {
  currentUsername: string
  onClose: () => void
}) {
  const [username, setUsername] = useState(currentUsername)
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const signOut = useAuthStore((state) => state.signOut)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const newUsername = username.trim()
  const renamed = newUsername !== currentUsername
  const validUsername = /^[a-zA-Z][a-zA-Z0-9._-]{1,31}$/.test(newUsername)
  const passwordsMatch = password === confirmation
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/me', {
        method: 'PATCH',
        body: JSON.stringify({
          current_password: currentPassword,
          ...(renamed ? { username: newUsername } : {}),
          ...(password ? { password } : {}),
        }),
      }),
    onSuccess: () => {
      signOut({ localOnly: true })
      queryClient.clear()
      onClose()
      toast.success('账号已更新，请重新登录')
      void navigate({ to: '/login', search: {}, replace: true })
    },
  })
  const canSave =
    !!currentPassword &&
    (!renamed || validUsername) &&
    (renamed || !!password) &&
    (!password || password.length >= 8) &&
    passwordsMatch &&
    !save.isPending

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <form
          className='space-y-4'
          onSubmit={(event) => {
            event.preventDefault()
            if (canSave) save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>账号设置</DialogTitle>
            <DialogDescription>保存后需重新登录。</DialogDescription>
          </DialogHeader>
          <div className='space-y-2'>
            <Label htmlFor='tenant-account-username'>登录用户名</Label>
            <Input
              id='tenant-account-username'
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete='username'
              maxLength={32}
              required
            />
            {renamed && !validUsername && (
              <p className='text-sm text-destructive'>
                请输入 2–32 位，以字母开头，可用字母、数字、点、下划线和连字符。
              </p>
            )}
          </div>
          <div className='space-y-2'>
            <Label htmlFor='tenant-account-current-password'>当前密码</Label>
            <Input
              id='tenant-account-current-password'
              type='password'
              autoComplete='current-password'
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              maxLength={128}
              required
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='tenant-account-new-password'>新密码（选填）</Label>
            <Input
              id='tenant-account-new-password'
              type='password'
              autoComplete='new-password'
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              maxLength={128}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='tenant-account-confirmation'>确认新密码</Label>
            <Input
              id='tenant-account-confirmation'
              type='password'
              autoComplete='new-password'
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              maxLength={128}
              required={!!password}
            />
            {!!confirmation && !passwordsMatch && (
              <p className='text-sm text-destructive'>
                两次输入的新密码不一致。
              </p>
            )}
          </div>
          {save.error && (
            <p role='alert' className='text-sm text-destructive'>
              {save.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={onClose}
              disabled={save.isPending}
            >
              取消
            </Button>
            <Button type='submit' disabled={!canSave}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
