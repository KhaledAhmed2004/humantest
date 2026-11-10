import {
  AccessibilityIcon, BoxIcon, FormInputIcon, KeyRoundIcon, MapIcon, RouteIcon,
  ServerIcon, ShieldIcon, TriangleAlertIcon, UnplugIcon, type LucideIcon,
} from 'lucide-react'
import type { PlannedStep, TestInfo } from '@/lib/api'
import { actors, isJourney } from '@/lib/happy'

export { actors }

/**
 * The kinds of test a web app needs, grouped the way the industry groups them, so nobody has to
 * remember the list. Each test lands in one kind, worked out from its steps: no labels to write.
 * A kind with no test yet is still listed, with the sentence that starts one.
 */
export type CategoryId = 'happy' | 'input' | 'auth' | 'break' | 'a11y'
export type TestType =
  | 'journey' | 'flow'
  | 'form' | 'server'
  | 'login' | 'access'
  | 'failure'
  | 'a11y'

export interface KindInfo { id: TestType; category: CategoryId; label: string; icon: LucideIcon; hint: string; example: string }
export interface CategoryInfo { id: CategoryId; label: string; icon: LucideIcon; hint: string; kinds: KindInfo[] }

const kind = (id: TestType, category: CategoryId, label: string, icon: LucideIcon, hint: string, example: string): KindInfo =>
  ({ id, category, label, icon, hint, example })

const KINDS: KindInfo[] = [
  // The happy path by scope (src/lib/happy.ts). What a test checks (an email, a reload, a second
  // role) is shown on the test itself, since one test can check several.
  kind('journey', 'happy', 'Full user journey', MapIcon, 'One story across several parts of the app, start to finish', 'As admin: add a route … As operator: schedule a trip on it … As traveller: book it'),
  kind('flow', 'happy', 'Feature flow', BoxIcon, 'One part of the app, its whole flow: add, change, remove', 'As admin: go to routes page, click "Add Route" … should see "Route created"'),
  kind('form', 'input', 'Page stops it', FormInputIcon, 'Bad input is stopped before anything is sent', 'click "Save", then backend should not receive any request'),
  kind('server', 'input', 'Server refuses it', ServerIcon, 'The server says no to what the page lets through', 'backend should reply 409'),
  kind('login', 'auth', 'Login & sign-up', KeyRoundIcon, 'Logging in, signing up, codes and passwords', 'go to login page … backend should reply 401'),
  kind('access', 'auth', 'Permission', ShieldIcon, 'Someone is refused what they may not do', 'As traveller: call POST /api/routes, backend should reply 403'),
  kind('failure', 'break', 'Server or network fails', UnplugIcon, 'What the user sees when the server fails, is slow, or the internet is off', 'when the server fails on POST /api/orders'),
  kind('a11y', 'a11y', 'Accessibility', AccessibilityIcon, 'Usable with a keyboard and a screen reader', 'the page should have no accessibility problems'),
]

export const CATEGORIES: CategoryInfo[] = ([
  ['happy', 'Happy path', RouteIcon, 'The work gets done, for every role'],
  ['input', 'Wrong input', TriangleAlertIcon, 'Bad or missing input is stopped'],
  ['auth', 'Auth & permission', ShieldIcon, 'Who can log in, and who can do what'],
  ['break', 'When things break', UnplugIcon, 'Errors, slow servers and no internet'],
  ['a11y', 'Accessibility', AccessibilityIcon, 'Everyone can use it'],
] as const).map(([id, label, icon, hint]) => ({ id, label, icon, hint, kinds: KINDS.filter((k) => k.category === id) }))

export const typeInfo = (t: TestType) => KINDS.find((x) => x.id === t)!

const AUTH_PATH = /\/(auth|login|signin|sign-in|signup|sign-up|register|verify|password|otp)\b/
const AUTH_PAGE = /^go to (the )?(login|signin|sign in|signup|sign up|register|forgot password|reset password) page/

/** Worked out from the steps, so a new test lands in the right group without labelling it. */
export function testType(test: Pick<TestInfo, 'steps'> | PlannedStep[]): TestType {
  const steps = Array.isArray(test) ? test : test.steps
  const texts = steps.map((s) => s.text.trim().toLowerCase())
  const has = (re: RegExp) => texts.some((t) => re.test(t))
  const replies = texts.map((t) => /^backend should reply (\d{3})/.exec(t)?.[1]).filter(Boolean) as string[]

  if (has(/^(when (the server|the internet|get|post|put|patch|delete) |on a .*network|on (slow |fast )?[34]g)/)) return 'failure'
  if (has(/accessibility problems/)) return 'a11y'
  if (replies.some((r) => r === '403') || (has(/^call [a-z]+ \//) && replies.includes('401'))) return 'access'
  // About logging in or signing up only: a longer flow that signs up on the way is a journey.
  const sent = texts.filter((t) => /^backend should receive/.test(t))
  const authOnly = sent.every((t) => AUTH_PATH.test(t))
  if (authOnly && (has(AUTH_PAGE) || has(/remember the code in the email/) || sent.length > 0)) return 'login'
  if (has(/^backend should not receive any request/)) return 'form'
  if (replies.some((r) => r.startsWith('4'))) return 'server'
  return isJourney(steps) ? 'journey' : 'flow'
}
