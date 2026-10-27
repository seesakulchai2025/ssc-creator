import { corsHeaders, jsonResponse, lockedOut, recordFailure, requestIp, supabase, validPin, verifyCaptcha } from '../_shared/http.ts'

function normalizedPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const phone = value.replace(/[\s-]/g, '')
  return /^0\d{9}$/.test(phone) ? phone : null
}

Deno.serve(async request => {
  const headers = corsHeaders(request.headers.get('origin'))
  if (!headers) return new Response('Forbidden', { status: 403 })
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, headers)

  const ip = requestIp(request)
  try {
    if (await lockedOut(ip, 'register')) return jsonResponse({ error: 'rate_limited' }, 429, headers)
    let body: { full_name?: unknown; phone?: unknown; pin?: unknown; join_code?: unknown; captcha_token?: unknown }
    try { body = await request.json() as typeof body }
    catch { await recordFailure(ip, 'register'); return jsonResponse({ error: 'invalid' }, 400, headers) }

    const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''
    const phone = normalizedPhone(body.phone)
    if (!fullName || fullName.length > 200 || !phone || !validPin(body.pin) ||
      typeof body.join_code !== 'string' || !body.join_code.trim()) {
      await recordFailure(ip, 'register')
      return jsonResponse({ error: 'invalid' }, 400, headers)
    }
    if (!await verifyCaptcha(body.captcha_token, ip)) {
      await recordFailure(ip, 'register')
      return jsonResponse({ error: 'captcha_failed' }, 400, headers)
    }

    const [joinResult, domainResult] = await Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'join_code').single(),
      supabase.from('app_settings').select('value').eq('key', 'pin_domain').single(),
    ])
    if (joinResult.error) throw joinResult.error
    if (domainResult.error) throw domainResult.error
    if (body.join_code.trim() !== joinResult.data.value) {
      await recordFailure(ip, 'register')
      return jsonResponse({ error: 'invalid' }, 400, headers)
    }

    const { data: taken, error: takenError } = await supabase.rpc('pin_taken', { p_pin: body.pin })
    if (takenError) throw takenError
    if (taken) {
      await recordFailure(ip, 'register')
      return jsonResponse({ error: 'pin_taken', code: 'pin_taken' }, 409, headers)
    }

    const email = `${crypto.randomUUID()}@${domainResult.data.value}`
    const password = crypto.randomUUID() + crypto.randomUUID()
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, phone },
    })
    if (createError) {
      await recordFailure(ip, 'register')
      return jsonResponse({ error: 'registration_failed' }, 400, headers)
    }

    const userId = created.user.id
    const { error: pinError } = await supabase.rpc('set_pin_hash', { p_user: userId, p_pin: body.pin })
    if (pinError) {
      await supabase.auth.admin.deleteUser(userId)
      if (pinError.message.includes('PIN นี้ใช้ไม่ได้')) {
        await recordFailure(ip, 'register')
        return jsonResponse({ error: 'pin_taken', code: 'pin_taken' }, 409, headers)
      }
      throw pinError
    }
    const { error: privateError } = await supabase.from('profile_private').insert({ user_id: userId, phone })
    if (privateError) {
      await supabase.auth.admin.deleteUser(userId)
      if (privateError.code === '23505') {
        await recordFailure(ip, 'register')
        return jsonResponse({ error: 'phone_taken', code: 'phone_taken' }, 409, headers)
      }
      throw privateError
    }
    return jsonResponse({ ok: true }, 200, headers)
  } catch (error) {
    console.error('pin-register failed', error)
    return jsonResponse({ error: 'internal_error' }, 500, headers)
  }
})
