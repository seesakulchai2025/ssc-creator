import { corsHeaders, jsonResponse, lockedOut, recordFailure, requestIp, supabase } from '../_shared/http.ts'

Deno.serve(async request => {
  const headers = corsHeaders(request.headers.get('origin'))
  if (!headers) return new Response('Forbidden', { status: 403 })
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, headers)

  const ip = requestIp(request)
  try {
    if (await lockedOut(ip, 'login')) return jsonResponse({ error: 'rate_limited' }, 429, headers)
    let body: { pin?: unknown }
    try { body = await request.json() as { pin?: unknown } }
    catch { await recordFailure(ip, 'login'); return jsonResponse({ error: 'invalid' }, 400, headers) }

    if (typeof body.pin !== 'string' || !/^\d{6,8}$/.test(body.pin)) {
      await recordFailure(ip, 'login')
      return jsonResponse({ error: 'invalid' }, 401, headers)
    }

    const { data, error } = await supabase.rpc('find_user_by_pin', { p_pin: body.pin })
    if (error) throw error
    const match = (data as { email: string }[] | null)?.[0]
    if (!match) {
      await recordFailure(ip, 'login')
      return jsonResponse({ error: 'invalid' }, 401, headers)
    }

    const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: match.email,
    })
    if (linkError || !link.properties?.hashed_token) {
      if (linkError) throw linkError
      throw new Error('Magic link did not return a token hash')
    }
    return jsonResponse({ token_hash: link.properties.hashed_token }, 200, headers)
  } catch (error) {
    console.error('pin-login failed', error)
    return jsonResponse({ error: 'internal_error' }, 500, headers)
  }
})
