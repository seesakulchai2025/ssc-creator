import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

const origins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)

export function corsHeaders(origin: string | null): Record<string, string> | null {
  if (!origin || !origins.includes(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

export function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

export function requestIp(request: Request): string {
  return (request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-real-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    ?? 'unknown').slice(0, 128)
}

export async function lockedOut(ip: string, kind: 'login' | 'register'): Promise<boolean> {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const perIpQuery = supabase.from('pin_attempts').select('ip', { count: 'exact', head: true })
    .eq('ip', ip).eq('kind', kind).gte('at', since)
  const globalQuery = kind === 'login'
    ? supabase.from('pin_attempts').select('ip', { count: 'exact', head: true })
      .eq('ip', '__global__').eq('kind', kind).gte('at', since)
    : Promise.resolve({ count: 0, error: null })
  const [perIp, global] = await Promise.all([perIpQuery, globalQuery])
  if (perIp.error) throw perIp.error
  if (global.error) throw global.error
  return (perIp.count ?? 0) >= 8 || (global.count ?? 0) >= 60
}

export async function recordFailure(ip: string, kind: string): Promise<void> {
  const { error: cleanupError } = await supabase.from('pin_attempts').delete()
    .lt('at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  if (cleanupError) throw cleanupError
  const { error } = await supabase.from('pin_attempts').insert([
    { ip, kind },
    { ip: '__global__', kind },
  ])
  if (error) throw error
}

export function validPin(pin: unknown): pin is string {
  if (typeof pin !== 'string' || !/^\d{6,8}$/.test(pin) || /^(\d)\1+$/.test(pin)) return false
  const digits = [...pin].map(Number)
  return !digits.every((digit, index) => index === 0 || digit === digits[index - 1] + 1)
    && !digits.every((digit, index) => index === 0 || digit === digits[index - 1] - 1)
}

export async function verifyCaptcha(token: unknown, ip: string): Promise<boolean> {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')
  if (!secret || typeof token !== 'string' || !token) return false
  const form = new URLSearchParams({ secret, response: token, remoteip: ip })
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) return false
  const result = await response.json() as { success?: boolean }
  return result.success === true
}
