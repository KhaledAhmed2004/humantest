import { FormInputIcon, RouteIcon, ServerIcon, ShieldIcon, type LucideIcon } from 'lucide-react'
import type { PlannedStep } from '@/lib/api'

/** What a test checks. Every test runs in a real browser; this says what it is about. */
export type TestType = 'flow' | 'form' | 'server' | 'access'

export const TEST_TYPES: { id: TestType; label: string; plural: string; icon: LucideIcon; hint: string }[] = [
  { id: 'flow', label: 'User flow', plural: 'User flows', icon: RouteIcon, hint: 'A whole task from start to finish' },
  { id: 'form', label: 'Form check', plural: 'Form checks', icon: FormInputIcon, hint: 'The page stops bad input before anything is sent' },
  { id: 'server', label: 'Server rule', plural: 'Server rules', icon: ServerIcon, hint: 'The server refuses something the page lets through' },
  { id: 'access', label: 'Permission', plural: 'Permissions', icon: ShieldIcon, hint: 'Someone is refused what they may not do' },
]

export const typeInfo = (t: TestType) => TEST_TYPES.find((x) => x.id === t)!

/** Worked out from the steps, so a new test lands in the right group without labelling it. */
export function testType(steps: PlannedStep[]): TestType {
  const texts = steps.map((s) => s.text.trim().toLowerCase())
  const replies = texts.map((t) => /^backend should reply (\d{3})/.exec(t)?.[1]).filter(Boolean) as string[]
  if (texts.some((t) => /^call [a-z]+ \//.test(t)) && replies.some((r) => r === '401' || r === '403')) return 'access'
  if (texts.some((t) => t.startsWith('backend should not receive any request'))) return 'form'
  if (replies.some((r) => r.startsWith('4'))) return 'server'
  return 'flow'
}
