import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configured } from './lib/supabase'
import { isValidPhone, isValidPin, normalizePhone } from './lib/auth'
import { STATUS, ROLE_TH, type Role, type Transition } from './lib/workflow'

interface Profile { id: string; full_name: string; display_name: string | null; role: Role; approval_status: 'pending' | 'approved' | 'rejected'; employee_code: string | null }
interface Idea { id: string; code: string; title: string; description: string | null; status: string; owner_id: string; assignee_id: string | null; is_demo: boolean; created_at: string }
interface Hist { id: number; from_status: string | null; to_status: string; note: string | null; created_at: string }

const Badge = ({ s }: { s: string }) => <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS[s]?.color}`}>{STATUS[s]?.th ?? s}</span>

interface TurnstileApi {
  render: (container: HTMLElement, options: {
    sitekey: string
    callback: (token: string) => void
    'expired-callback': () => void
    'error-callback': () => void
  }) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

function Turnstile({ onToken, onError, resetKey }: { onToken: (token: string) => void; onError: () => void; resetKey: number }) {
  const container = useRef<HTMLDivElement>(null)
  const tokenHandler = useRef(onToken)
  const errorHandler = useRef(onError)
  const widgetId = useRef<string>()
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined
  tokenHandler.current = onToken
  errorHandler.current = onError

  useEffect(() => {
    if (!siteKey || !container.current) return
    let active = true
    const handleScriptError = () => errorHandler.current()
    const render = () => {
      if (!active || !window.turnstile || !container.current || widgetId.current) return
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        callback: token => tokenHandler.current(token),
        'expired-callback': () => tokenHandler.current(''),
        'error-callback': () => { tokenHandler.current(''); errorHandler.current() },
      })
    }

    if (window.turnstile) render()
    else {
      let script = document.querySelector<HTMLScriptElement>('script[data-turnstile]')
      if (!script) {
        script = document.createElement('script')
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
        script.async = true
        script.defer = true
        script.dataset.turnstile = 'true'
        document.head.appendChild(script)
      }
      script.addEventListener('load', render)
      script.addEventListener('error', handleScriptError)
      return () => {
        active = false
        script?.removeEventListener('load', render)
        script?.removeEventListener('error', handleScriptError)
        if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current)
        widgetId.current = undefined
      }
    }
    return () => {
      active = false
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current)
      widgetId.current = undefined
    }
  }, [siteKey])

  useEffect(() => {
    if (resetKey > 0 && widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current)
  }, [resetKey])

  return siteKey ? <div ref={container} aria-label="การยืนยันความปลอดภัย" /> : null
}

function PinKeypad({ value, onChange, label, enabled = true, keyboardGlobal = false }: { value: string; onChange: (pin: string) => void; label: string; enabled?: boolean; keyboardGlobal?: boolean }) {
  const [focused, setFocused] = useState(false)
  const add = (digit: string) => { if (enabled && value.length < 8) onChange(value + digit) }
  useEffect(() => {
    if (!enabled || (!keyboardGlobal && !focused)) return
    const handleKey = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key)) { event.preventDefault(); add(event.key) }
      else if (event.key === 'Backspace') { event.preventDefault(); onChange(value.slice(0, -1)) }
      else if (event.key === 'Delete' || event.key === 'Escape') { event.preventDefault(); onChange('') }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [enabled, focused, keyboardGlobal, onChange, value])

  return (
    <fieldset className="space-y-2" aria-label={label} tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
      <legend className="text-sm">{label}</legend>
      <output className="block rounded border bg-slate-50 p-3 text-center text-2xl tracking-[0.5em]" aria-label={`กรอกแล้ว ${value.length} หลัก`}>
        {value ? '●'.repeat(value.length) : 'กรุณากรอก PIN'}
      </output>
      <div className="mx-auto grid max-w-xs grid-cols-3 gap-2">
        {['1','2','3','4','5','6','7','8','9','ล้าง','0','ลบ'].map(key => (
          <button key={key} type="button" disabled={!enabled} aria-label={key === 'ลบ' ? 'ลบตัวเลขล่าสุด' : key === 'ล้าง' ? 'ล้าง PIN' : `เลข ${key}`}
            onClick={() => key === 'ลบ' ? onChange(value.slice(0, -1)) : key === 'ล้าง' ? onChange('') : add(key)}
            className="min-h-12 rounded border bg-white text-lg disabled:opacity-50">{key}</button>
        ))}
      </div>
    </fieldset>
  )
}

function Login() {
  const [mode, setMode] = useState<'email' | 'pin' | 'register'>('pin')
  const [pin, setPin] = useState(''); const [confirmPin, setConfirmPin] = useState('')
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [phone, setPhone] = useState(''); const [name, setName] = useState(''); const [joinCode, setJoinCode] = useState('')
  const [captchaToken, setCaptchaToken] = useState(''); const [captchaReset, setCaptchaReset] = useState(0)
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [notice, setNotice] = useState('')
  const signup = mode === 'register'
  async function go(e: FormEvent) {
    e.preventDefault()
    setMsg(''); setNotice(''); setBusy(true)
    try {
      if (signup) {
        if (!name.trim()) { setMsg('กรุณากรอกชื่อ-นามสกุล'); return }
        if (!isValidPhone(phone)) { setMsg('กรุณากรอกเบอร์โทรศัพท์ 10 หลัก โดยขึ้นต้นด้วย 0'); return }
        if (!isValidPin(pin)) { setMsg('PIN ต้องมี 6-8 หลัก และห้ามเป็นเลขซ้ำหรือลำดับตรง'); return }
        if (pin !== confirmPin) { setMsg('PIN และยืนยัน PIN ไม่ตรงกัน'); return }
        if (import.meta.env.VITE_TURNSTILE_SITE_KEY && !captchaToken) { setMsg('กรุณายืนยันความปลอดภัยก่อนสมัคร'); return }
        const { data, error } = await supabase.functions.invoke('pin-register', {
          body: { full_name: name.trim(), phone: normalizePhone(phone), pin, join_code: joinCode.trim(), captcha_token: captchaToken || undefined },
        })
        if (error) {
          const response = error.context instanceof Response ? error.context : null
          const detail = response ? await response.json().catch(() => null) as { code?: string } | null : null
          if (response?.status === 409 && detail?.code === 'pin_taken') setMsg('PIN นี้ใช้ไม่ได้ กรุณาเลือกใหม่')
          else if (response?.status === 429) setMsg('ลองผิดหลายครั้ง กรุณารอสักครู่')
          else setMsg('ลงทะเบียนไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองใหม่')
          setCaptchaToken(''); setCaptchaReset(value => value + 1)
        } else if (data?.ok) {
          setNotice('ส่งคำขอแล้ว รอแอดมินอนุมัติ')
          setMode('pin'); setPin(''); setConfirmPin(''); setPhone(''); setName(''); setJoinCode('')
        }
      } else if (mode === 'email') {
        if (import.meta.env.VITE_TURNSTILE_SITE_KEY && !captchaToken) { setMsg('กรุณายืนยันความปลอดภัยก่อนเข้าสู่ระบบ'); return }
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
          options: captchaToken ? { captchaToken } : undefined,
        })
        if (error) {
          setMsg('อีเมลหรือรหัสผ่านไม่ถูกต้อง')
          setCaptchaToken(''); setCaptchaReset(value => value + 1)
        }
      } else {
        if (!/^\d{6,8}$/.test(pin)) { setMsg('กรุณากรอก PIN 6-8 หลัก'); return }
        const { data, error } = await supabase.functions.invoke('pin-login', { body: { pin } })
        if (error) {
          const response = error.context instanceof Response ? error.context : null
          if (response?.status === 429) setMsg('ลองผิดหลายครั้ง กรุณารอสักครู่')
          else setMsg('PIN ไม่ถูกต้อง')
        } else if (data?.token_hash) {
          const result = await supabase.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' })
          if (result.error) setMsg('PIN ไม่ถูกต้อง')
        } else setMsg('PIN ไม่ถูกต้อง')
      }
    } catch (error) {
      setMsg(signup ? 'ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่' : mode === 'email' ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : 'PIN ไม่ถูกต้อง')
    } finally { setBusy(false) }
  }
  function choose(tab: typeof mode) { setMode(tab); setMsg(''); setNotice(''); setPin(''); setConfirmPin(''); setCaptchaToken(''); setCaptchaReset(value => value + 1) }
  return (
    <div className="grid min-h-screen place-items-center bg-navy p-4">
      <form onSubmit={go} className="w-full max-w-sm space-y-3 rounded-lg bg-white p-6">
        <img src="/ssc-logo-192.png" alt="SSC Creator" className="mx-auto h-24 w-24 object-contain" />
        <h1 className="text-center text-2xl font-semibold text-navy">SSC Creator</h1>
        <p className="text-sm text-slate-500">พื้นที่สร้างสรรค์คอนเทนต์ของ สีสกุลไชย</p>
        <div className="grid grid-cols-3 gap-1" role="tablist" aria-label="วิธีเข้าสู่ระบบ">
          {([['email','อีเมล'],['pin','PIN'],['register','ลงทะเบียนใช้งาน']] as const).map(([key, text]) =>
            <button key={key} type="button" role="tab" aria-selected={mode === key} onClick={() => choose(key)}
              className={`rounded px-2 py-2 text-sm ${mode === key ? 'bg-navy text-white' : 'bg-slate-100'}`}>{text}</button>)}
        </div>
        {mode === 'email' && <>
          <label className="block text-sm">อีเมล<input className="mt-1 w-full rounded border p-2" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
          <label className="block text-sm">รหัสผ่าน<input className="mt-1 w-full rounded border p-2" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        </>}
        {mode === 'pin' && <PinKeypad label="PIN" value={pin} onChange={setPin} keyboardGlobal />}
        {signup && <>
          <label className="block text-sm">ชื่อ-นามสกุล<input className="mt-1 w-full rounded border p-2" autoComplete="name" value={name} onChange={e => setName(e.target.value)} required /></label>
          <label className="block text-sm">เบอร์โทรศัพท์<input className="mt-1 w-full rounded border p-2" type="tel" inputMode="numeric" autoComplete="tel" maxLength={10} value={phone} onChange={e => setPhone(e.target.value)} required /></label>
          <PinKeypad label="ตั้ง PIN" value={pin} onChange={setPin} />
          <PinKeypad label="ยืนยัน PIN" value={confirmPin} onChange={setConfirmPin} />
          <label className="block text-sm">รหัสเข้าร่วมบริษัท<input className="mt-1 w-full rounded border p-2" value={joinCode} onChange={e => setJoinCode(e.target.value)} required /></label>
        </>}
        {(signup || mode === 'email') && <Turnstile onToken={setCaptchaToken} onError={() => setMsg('โหลดการยืนยันความปลอดภัยไม่สำเร็จ กรุณาลองใหม่')} resetKey={captchaReset} />}
        {msg && <p className="text-sm text-red-600" role="alert">{msg}</p>}
        {notice && <p className="text-sm text-green-700" role="status">{notice}</p>}
        <button disabled={busy || (mode === 'pin' && (pin.length < 6 || pin.length > 8))} className="w-full rounded bg-mint p-2 font-medium text-white disabled:opacity-60">{busy ? 'กำลังดำเนินการ…' : signup ? 'ลงทะเบียน' : 'เข้าสู่ระบบ'}</button>
      </form>
    </div>)
}

function ApprovalNotice({ status }: { status: Profile['approval_status'] }) {
    const pending = status === 'pending'
    return (
      <main className="grid min-h-screen place-items-center bg-navy p-4">
        <section className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 text-center">
          <h1 className="text-xl font-semibold text-navy">{pending ? 'บัญชีรอแอดมินอนุมัติ' : 'บัญชีไม่ได้รับการอนุมัติ'}</h1>
          <p>{pending ? 'ผู้ดูแลระบบจะตรวจสอบข้อมูลก่อนเปิดให้ใช้งาน กรุณากลับมาตรวจสอบภายหลัง' : 'กรุณาติดต่อผู้ดูแลระบบของบริษัทหากคิดว่าเกิดข้อผิดพลาด'}</p>
          <button className="rounded bg-mint px-4 py-2 text-white" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>
        </section>
      </main>
    )
}

function ProfilePage({ me, onSaved }: { me: Profile; onSaved: () => void }) {
    const [form, setForm] = useState({ full_name: me.full_name, display_name: me.display_name ?? '', department: '', avatar_url: '', phone: '' })
    const [currentPin, setCurrentPin] = useState(''); const [newPin, setNewPin] = useState(''); const [confirmPin, setConfirmPin] = useState('')
    const [err, setErr] = useState(''); const [msg, setMsg] = useState('')
    useEffect(() => {
      void (async () => {
        const [profile, privateProfile] = await Promise.all([
          supabase.from('profiles').select('department,avatar_url').eq('id', me.id).single(),
          supabase.from('profile_private').select('phone').eq('user_id', me.id).maybeSingle(),
        ])
        if (profile.error) setErr('โหลดข้อมูลโปรไฟล์ไม่สำเร็จ: ' + profile.error.message)
        else setForm(f => ({ ...f, department: profile.data.department ?? '', avatar_url: profile.data.avatar_url ?? '', phone: privateProfile.data?.phone ?? '' }))
        if (privateProfile.error) setErr('โหลดเบอร์โทรศัพท์ไม่สำเร็จ: ' + privateProfile.error.message)
      })()
    }, [me.id])
    async function save(e: FormEvent) {
      e.preventDefault(); setErr(''); setMsg('')
      if (form.phone && !isValidPhone(form.phone)) return setErr('กรุณากรอกเบอร์โทรศัพท์ 10 หลัก โดยขึ้นต้นด้วย 0')
      const { error } = await supabase.from('profiles').update({
        full_name: form.full_name.trim(), display_name: form.display_name.trim() || null,
        department: form.department.trim() || null, avatar_url: form.avatar_url.trim() || null,
      }).eq('id', me.id)
      if (error) return setErr('บันทึกโปรไฟล์ไม่สำเร็จ: ' + error.message)
      if (form.phone) {
        const privateResult = await supabase.from('profile_private').upsert({ user_id: me.id, phone: normalizePhone(form.phone) }, { onConflict: 'user_id' })
        if (privateResult.error) return setErr('บันทึกเบอร์โทรศัพท์ไม่สำเร็จ: ' + privateResult.error.message)
      }
      setMsg('บันทึกโปรไฟล์แล้ว'); onSaved()
    }
    async function savePin(e: FormEvent) {
      e.preventDefault(); setErr(''); setMsg('')
      if (!isValidPin(newPin)) return setErr('PIN ใหม่ต้องมี 6-8 หลัก และห้ามเป็นเลขซ้ำหรือลำดับตรง')
      if (newPin !== confirmPin) return setErr('PIN ใหม่และยืนยัน PIN ไม่ตรงกัน')
      const { data, error } = await supabase.rpc('change_my_pin', { p_old: currentPin, p_new: newPin })
      if (error) setErr('เปลี่ยน PIN ไม่สำเร็จ: ' + error.message)
      else if (data !== 'ok') setErr(data === 'PIN นี้ใช้ไม่ได้ กรุณาเลือกใหม่' ? data : data === 'ลองผิดหลายครั้ง กรุณารอสักครู่' ? data : 'PIN ปัจจุบันไม่ถูกต้อง')
      else { setCurrentPin(''); setNewPin(''); setConfirmPin(''); setMsg('เปลี่ยน PIN แล้ว') }
    }
    return (
      <main className="mx-auto max-w-xl space-y-4 p-4">
        <h1 className="text-lg font-semibold">โปรไฟล์ของฉัน</h1>
        <form onSubmit={save} className="space-y-3 rounded bg-white p-4">
          <label className="block text-sm">ชื่อ-นามสกุล<input className="mt-1 w-full rounded border p-2" autoComplete="name" value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} required /></label>
          <label className="block text-sm">ชื่อที่แสดง<input className="mt-1 w-full rounded border p-2" value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} /></label>
          <label className="block text-sm">เบอร์โทรศัพท์<input className="mt-1 w-full rounded border p-2" type="tel" inputMode="numeric" autoComplete="tel" maxLength={10} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
          <label className="block text-sm">แผนก<input className="mt-1 w-full rounded border p-2" value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} /></label>
          <label className="block text-sm">URL รูปโปรไฟล์<input className="mt-1 w-full rounded border p-2" type="url" value={form.avatar_url} onChange={e => setForm({ ...form, avatar_url: e.target.value })} /></label>
          <dl className="grid grid-cols-2 gap-2 border-t pt-3 text-sm"><dt>บทบาท</dt><dd>{ROLE_TH[me.role]}</dd><dt>รหัสพนักงาน</dt><dd>{me.employee_code ?? '—'}</dd></dl>
          <button className="rounded bg-mint px-4 py-2 text-white">บันทึกโปรไฟล์</button>
        </form>
        {me.role !== 'admin' && <form onSubmit={savePin} className="space-y-3 rounded bg-white p-4">
          <h2 className="font-medium">เปลี่ยน PIN</h2>
          <PinKeypad label="PIN ปัจจุบัน" value={currentPin} onChange={setCurrentPin} />
          <PinKeypad label="PIN ใหม่" value={newPin} onChange={setNewPin} />
          <PinKeypad label="ยืนยัน PIN ใหม่" value={confirmPin} onChange={setConfirmPin} />
          <button className="rounded bg-navy px-4 py-2 text-white">บันทึก PIN ใหม่</button>
        </form>}
        {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
        {msg && <p className="text-sm text-green-700" role="status">{msg}</p>}
      </main>
    )
}

function NewIdea({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ title: '', description: '', objective: '', target_audience: '', content_type: '', platforms: '' })
  const [err, setErr] = useState(''); const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  async function save(e: FormEvent) {
    e.preventDefault(); setErr('')
    const { error } = await supabase.from('content_ideas').insert({ ...f, platforms: f.platforms.split(',').map(s => s.trim()).filter(Boolean) })
    if (error) setErr('บันทึกไม่สำเร็จ: ' + error.message); else onDone()
  }
  return (
    <form onSubmit={save} className="space-y-2 rounded bg-white p-4">
      <h2 className="font-semibold">เสนอไอเดียใหม่ (บันทึกเป็นฉบับร่าง)</h2>
      <input className="w-full rounded border p-2" placeholder="ชื่อหัวข้อ" value={f.title} onChange={set('title')} required minLength={3} />
      <textarea className="w-full rounded border p-2" placeholder="รายละเอียดแนวคิด" value={f.description} onChange={set('description')} />
      <input className="w-full rounded border p-2" placeholder="วัตถุประสงค์" value={f.objective} onChange={set('objective')} />
      <input className="w-full rounded border p-2" placeholder="กลุ่มเป้าหมาย" value={f.target_audience} onChange={set('target_audience')} />
      <input className="w-full rounded border p-2" placeholder="ประเภทคอนเทนต์ เช่น สาธิตวิธีใช้งาน" value={f.content_type} onChange={set('content_type')} />
      <input className="w-full rounded border p-2" placeholder="แพลตฟอร์ม คั่นด้วยจุลภาค เช่น TikTok, Facebook" value={f.platforms} onChange={set('platforms')} />
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <button className="rounded bg-mint px-4 py-2 font-medium text-white">บันทึกร่าง</button>
    </form>)
}

function Detail({ idea, me, rules, onChange }: { idea: Idea; me: Profile; rules: Transition[]; onChange: () => void }) {
  const [hist, setHist] = useState<Hist[]>([]); const [note, setNote] = useState(''); const [err, setErr] = useState('')
  useEffect(() => { supabase.from('workflow_history').select('*').eq('idea_id', idea.id).order('created_at').then(r => setHist((r.data as Hist[]) ?? [])) }, [idea.id, idea.status])
  const open = !['completed', 'rejected', 'cancelled'].includes(idea.status)
  const next = rules.filter(r => r.from_status === idea.status && r.allowed_roles.includes(me.role) && (!r.owner_only || idea.owner_id === me.id || ['content_manager', 'admin'].includes(me.role))).map(r => r.to_status)
  if (open && ['content_manager', 'admin'].includes(me.role)) next.push('rejected', 'cancelled')
  async function move(to: string) {
    setErr(''); const { error } = await supabase.rpc('transition_idea', { p_idea: idea.id, p_to: to, p_note: note || null })
    if (error) setErr(error.message); else { setNote(''); onChange() }
  }
  return (
    <div className="space-y-3 rounded bg-white p-4">
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-slate-500">{idea.code}</span><Badge s={idea.status} />{idea.is_demo && <span className="rounded bg-yellow-100 px-2 text-xs">Demo Data</span>}</div>
      <h2 className="text-lg font-semibold">{idea.title}</h2><p className="whitespace-pre-wrap text-sm">{idea.description}</p>
      {next.length > 0 && (<div className="space-y-2 border-t pt-3">
        <input className="w-full rounded border p-2 text-sm" placeholder="หมายเหตุ (จำเป็นเมื่อส่งกลับแก้ไข / ไม่อนุมัติ / ยกเลิก)" value={note} onChange={e => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">{next.map(s => <button key={s} onClick={() => move(s)} className="rounded border border-navy px-3 py-1 text-sm hover:bg-navy hover:text-white">{STATUS[s].th}</button>)}</div></div>)}
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <ol className="space-y-1 border-t pt-3 text-sm">{hist.length === 0 && <li className="text-slate-400">ยังไม่มีประวัติการเปลี่ยนสถานะ</li>}
        {hist.map(h => <li key={h.id}>{new Date(h.created_at).toLocaleString('th-TH')} — {STATUS[h.from_status ?? '']?.th ?? 'เริ่มต้น'} → {STATUS[h.to_status]?.th}{h.note && ` (${h.note})`}</li>)}</ol>
      <Attachments idea={idea} me={me} />
      <Assign idea={idea} canEdit={["content_manager", "admin"].includes(me.role)} onChange={onChange} />
      <Publish idea={idea} me={me} />
      <Production ideaId={idea.id} canEdit={["content_manager", "admin"].includes(me.role)} />
      <Comments ideaId={idea.id} />
    </div>)
}

interface Cmt { id: number; body: string; created_at: string; author_name: string }
function Comments({ ideaId }: { ideaId: string }) {
  const [list, setList] = useState<Cmt[]>([]); const [body, setBody] = useState(''); const [err, setErr] = useState('')
  const load = useCallback(async () => {
    const r = await supabase.from('comments').select('id,body,author_id,created_at').eq('idea_id', ideaId).order('created_at')
    if (r.error) { setErr('โหลดความคิดเห็นไม่สำเร็จ: ' + r.error.message); return }
    const rows = r.data ?? []
    const authorIds = [...new Set(rows.map(comment => comment.author_id))]
    const names = authorIds.length ? await supabase.from('profile_names').select('id,name').in('id', authorIds) : { data: [], error: null }
    if (names.error) { setErr('โหลดชื่อผู้แสดงความคิดเห็นไม่สำเร็จ: ' + names.error.message); return }
    const nameMap = new Map(((names.data ?? []) as { id: string; name: string }[]).map(person => [person.id, person.name]))
    setList(rows.map(comment => ({ ...comment, author_name: nameMap.get(comment.author_id) ?? 'ผู้ใช้' })))
  }, [ideaId])
  useEffect(() => { load() }, [load])
  async function send(e: FormEvent) {
    e.preventDefault(); if (!body.trim()) return
    const { error } = await supabase.from('comments').insert({ idea_id: ideaId, body: body.trim() })
    if (error) setErr('ส่งความคิดเห็นไม่สำเร็จ: ' + error.message); else { setBody(''); setErr(''); load() }
  }
  return (
    <div className="space-y-2 border-t pt-3 text-sm"><h3 className="font-medium">ความคิดเห็น</h3>
      {list.length === 0 && <p className="text-slate-400">ยังไม่มีความคิดเห็น</p>}
      {list.map(c => <p key={c.id}><b>{c.author_name}</b> <span className="text-xs text-slate-500">{new Date(c.created_at).toLocaleString('th-TH')}</span><br />{c.body}</p>)}
      <form onSubmit={send} className="flex gap-2"><input className="min-w-0 flex-1 rounded border p-2" placeholder="เขียนความคิดเห็น" value={body} onChange={e => setBody(e.target.value)} /><button className="rounded bg-navy px-3 text-white">ส่ง</button></form>
      {err && <p className="text-red-600" role="alert">{err}</p>}
    </div>)
}

function Dashboard({ ideas, me, open }: { ideas: Idea[]; me: Profile; open: (id: string) => void }) {
  const n = (l: Idea[], st: string[]) => l.filter(i => st.includes(i.status)).length
  const mine = ideas.filter(i => i.owner_id === me.id)
  const active = ['pending_review', 'revision_required', 'reviewed', 'pending_approval', 'approved_for_script', 'script_in_progress', 'script_review', 'production', 'content_review', 'ready_to_publish']
  const cards: [string, number][] = me.role === 'employee'
    ? [['ไอเดียที่ส่งแล้ว', mine.length - n(mine, ['draft'])], ['กำลังดำเนินการ', n(mine, active)], ['ต้องแก้ไข', n(mine, ['revision_required'])], ['ออนไลน์แล้ว', n(mine, ['published', 'completed'])]]
    : me.role === 'reviewer'
    ? [['รอตรวจสอบ', n(ideas, ['pending_review'])], ['ส่งกลับแก้ไข', n(ideas, ['revision_required'])], ['ตรวจสอบแล้ว', n(ideas, ['reviewed'])]]
    : [['ไอเดียทั้งหมด', ideas.length], ['รออนุมัติ', n(ideas, ['pending_approval'])], ['กำลังผลิต', n(ideas, ['production'])], ['รอตรวจสื่อ', n(ideas, ['content_review'])], ['พร้อมออนไลน์', n(ideas, ['ready_to_publish'])]]
  const todoStatus = me.role === 'employee' ? ['draft', 'revision_required'] : me.role === 'reviewer' ? ['pending_review'] : ['pending_approval', 'script_review', 'content_review', 'ready_to_publish']
  const todo = ideas.filter(i => todoStatus.includes(i.status) && (me.role !== 'employee' || i.owner_id === me.id))
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">สวัสดี {me.display_name || me.full_name || 'ผู้ใช้'}</h1>
      {ideas.some(i => i.is_demo) && <p className="rounded bg-yellow-100 p-2 text-sm">ตัวเลขด้านล่างรวมข้อมูล Demo (ลบได้ด้วย <code>delete from content_ideas where is_demo;</code>)</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{cards.map(([l, v]) => <div key={l} className="rounded bg-white p-3"><div className="text-2xl font-semibold text-navy">{v}</div><div className="text-sm text-slate-500">{l}</div></div>)}</div>
      <Compliance me={me} />
      {["content_manager", "admin"].includes(me.role) && <PlatformSummary />}
      <section className="rounded bg-white p-4"><h2 className="mb-2 font-medium">งานที่ต้องดำเนินการ</h2>
        {todo.length === 0 ? <p className="text-sm text-slate-500">ไม่มีงานค้าง</p> : todo.map(i => <button key={i.id} onClick={() => open(i.id)} className="mb-1 flex w-full items-center gap-2 rounded p-2 text-left hover:bg-slate-50"><span className="text-xs text-slate-500">{i.code}</span><Badge s={i.status} /><span>{i.title}</span></button>)}</section>
    </div>)
}

function Kanban({ ideas, open, onChange }: { ideas: Idea[]; open: (id: string) => void; onChange: () => void }) {
  const [err, setErr] = useState('')
  async function drop(id: string, to: string) {
    const i = ideas.find(x => x.id === id); if (!i || i.status === to) return; setErr('')
    let note: string | null = null
    if (['revision_required', 'rejected', 'cancelled'].includes(to)) { note = window.prompt('ระบุเหตุผล / สิ่งที่ต้องแก้ไข'); if (!note) return }
    const { error } = await supabase.rpc('transition_idea', { p_idea: id, p_to: to, p_note: note }); if (error) setErr(error.message); else onChange()
  }
  return (
    <div className="p-4"><p className="text-xs text-slate-500">ลากการ์ดไปคอลัมน์ใหม่เพื่อเปลี่ยนสถานะ (ระบบตรวจสิทธิ์และลำดับขั้นตอนที่ฐานข้อมูล) หรือกดการ์ดเพื่อเปิดรายละเอียด</p>{err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <div className="mt-2 flex gap-3 overflow-x-auto">{Object.entries(STATUS).map(([k, v]) => { const l = ideas.filter(i => i.status === k); return (
        <div key={k} className="w-56 shrink-0" onDragOver={e => e.preventDefault()} onDrop={e => drop(e.dataTransfer.getData('id'), k)}><div className="mb-2 flex justify-between text-sm font-medium"><span>{v.th}</span><span>{l.length}</span></div>
          <div className="min-h-16 space-y-2">{l.length === 0 ? <p className="text-xs text-slate-400">ไม่มีงาน</p> : l.map(i => <button key={i.id} draggable onDragStart={e => e.dataTransfer.setData('id', i.id)} onClick={() => open(i.id)} className="block w-full rounded bg-white p-2 text-left text-sm"><span className="text-xs text-slate-500">{i.code}</span><div>{i.title}</div></button>)}</div></div>) })}</div></div>)
}

interface Notif { id: number; idea_id: string | null; message: string; is_read: boolean; created_at: string }
function NotifCenter({ list, open, reload }: { list: Notif[]; open: (id: string) => void; reload: () => void }) {
  async function go(n: Notif) { if (!n.is_read) { await supabase.from('notifications').update({ is_read: true }).eq('id', n.id); reload() } if (n.idea_id) open(n.idea_id) }
  async function all() { await supabase.from('notifications').update({ is_read: true }).eq('is_read', false); reload() }
  return (
    <div className="mx-auto max-w-2xl space-y-2 p-4"><div className="flex justify-between"><h1 className="text-lg font-semibold">การแจ้งเตือน</h1>{list.some(n => !n.is_read) && <button onClick={all} className="text-sm underline">อ่านทั้งหมด</button>}</div>
      {list.length === 0 ? <p className="rounded bg-white p-4 text-slate-500">ยังไม่มีการแจ้งเตือน เมื่อสถานะงานเปลี่ยนหรือมีความคิดเห็นใหม่ จะแสดงที่นี่</p> :
        list.map(n => <button key={n.id} onClick={() => go(n)} className={`block w-full rounded p-3 text-left ${n.is_read ? 'bg-white text-slate-500' : 'bg-white font-medium ring-1 ring-mint'}`}>{n.message}<div className="text-xs font-normal text-slate-400">{new Date(n.created_at).toLocaleString('th-TH')}</div></button>)}</div>)
}

interface Proj { id: string; script: string | null; shot_list: string | null; caption: string | null; hashtags: string | null; cta: string | null; due_date: string | null; publish_at: string | null }
interface Chk { id: number; label: string; is_done: boolean }
interface Ver { id: number; version: number; body: string; created_at: string }
function Production({ ideaId, canEdit }: { ideaId: string; canEdit: boolean }) {
  const [p, setP] = useState<Proj | null>(null); const [orig, setOrig] = useState(''); const [chk, setChk] = useState<Chk[]>([]); const [vers, setVers] = useState<Ver[]>([])
  const [msg, setMsg] = useState('')
  const load = useCallback(async () => {
    const r = await supabase.from('projects').select('*').eq('idea_id', ideaId).maybeSingle()
    const proj = r.data as Proj | null; setP(proj); setOrig(proj?.script ?? '')
    const c = await supabase.from('checklist_items').select('id,label,is_done').eq('idea_id', ideaId).order('id'); setChk((c.data as Chk[]) ?? [])
    if (proj) { const v = await supabase.from('script_versions').select('id,version,body,created_at').eq('project_id', proj.id).order('version', { ascending: false }); setVers((v.data as Ver[]) ?? []) }
  }, [ideaId])
  useEffect(() => { load() }, [load])
  if (!p) return null
  const set = (k: keyof Proj) => (e: { target: { value: string } }) => setP({ ...p, [k]: e.target.value })
  async function save() {
    if (!p) return; setMsg('')
    const { error } = await supabase.from('projects').update({ script: p.script, shot_list: p.shot_list, caption: p.caption, hashtags: p.hashtags, cta: p.cta, due_date: p.due_date || null, publish_at: p.publish_at || null }).eq('id', p.id)
    if (error) return setMsg('บันทึกไม่สำเร็จ: ' + error.message)
    if ((p.script ?? '') !== orig && (p.script ?? '').trim()) {
      const { error: e2 } = await supabase.from('script_versions').insert({ project_id: p.id, version: (vers[0]?.version ?? 0) + 1, body: p.script })
      if (e2) return setMsg('บันทึกเวอร์ชันบทไม่สำเร็จ: ' + e2.message)
    }
    setMsg('บันทึกแล้ว'); load()
  }
  async function toggle(c: Chk) { const { error } = await supabase.from('checklist_items').update({ is_done: !c.is_done }).eq('id', c.id); if (error) setMsg(error.message); else load() }
  const f = (k: keyof Proj, label: string, area = false) => (
    <label className="block text-sm">{label}{area
      ? <textarea disabled={!canEdit} className="mt-1 w-full rounded border p-2 disabled:bg-slate-50" rows={4} value={(p[k] as string) ?? ''} onChange={set(k)} />
      : <input disabled={!canEdit} className="mt-1 w-full rounded border p-2 disabled:bg-slate-50" value={(p[k] as string) ?? ''} onChange={set(k)} />}</label>)
  return (
    <div className="space-y-2 border-t pt-3"><h3 className="font-medium">การผลิตสื่อ</h3>
      {f('script', 'สคริปต์ / บทพูด', true)}{f('shot_list', 'Shot List', true)}{f('caption', 'Caption')}{f('hashtags', 'Hashtags')}{f('cta', 'Call to Action')}
      <div className="grid grid-cols-2 gap-2"><label className="block text-sm">กำหนดส่งงาน<input type="date" disabled={!canEdit} className="mt-1 w-full rounded border p-2" value={p.due_date ?? ''} onChange={set('due_date')} /></label>
        <label className="block text-sm">กำหนดเผยแพร่<input type="datetime-local" disabled={!canEdit} className="mt-1 w-full rounded border p-2" value={(p.publish_at ?? '').slice(0, 16)} onChange={set('publish_at')} /></label></div>
      {canEdit && <button onClick={save} className="rounded bg-mint px-4 py-2 text-white">บันทึกข้อมูลการผลิต</button>}
      {msg && <p className="text-sm" role="status">{msg}</p>}
      <details className="text-sm"><summary>เวอร์ชันของบท ({vers.length})</summary>{vers.map(v => <div key={v.id} className="mt-1 rounded bg-slate-50 p-2"><b>v{v.version}</b> {new Date(v.created_at).toLocaleString('th-TH')}<p className="whitespace-pre-wrap">{v.body}</p></div>)}</details>
      <div><h4 className="text-sm font-medium">Checklist ก่อนเผยแพร่ (ต้องครบก่อนเป็น “พร้อมออนไลน์”)</h4>
        {chk.map(c => <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={c.is_done} onChange={() => toggle(c)} />{c.label}</label>)}</div>
    </div>)
}

interface Met { id: number; recorded_on: string; views: number | null; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; clicks: number | null; followers_gained: number | null; source_note: string | null }
interface Contribution { user_id: string; role_label: string; name: string }
interface Pub { id: string; idea_id: string; title: string; url: string; platform: string; published_at: string | null; created_by: string; portfolio_contributions: Contribution[] }
const PLATFORMS = ['Facebook', 'TikTok', 'YouTube', 'Instagram', 'LINE', 'เว็บไซต์', 'อื่น ๆ']
const MKEYS = [['views', 'ยอดเข้าชม'], ['reach', 'Reach'], ['impressions', 'Impressions'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'], ['clicks', 'Clicks'], ['followers_gained', 'ผู้ติดตามเพิ่ม']] as const
const num = (v: number | null) => (v === null ? '—' : v.toLocaleString('th-TH'))
const er = (m: Met) => (m.reach && m.reach > 0 && m.likes !== null && m.comments !== null && m.shares !== null && m.saves !== null ? ((m.likes + m.comments + m.shares + m.saves) / m.reach * 100).toFixed(2) + '%' : '—')
const nameOf = (p: { full_name: string; display_name: string | null } | null) => p?.display_name || p?.full_name || 'ผู้ใช้'

function Metrics({ pubId }: { pubId: string }) {
  const [rows, setRows] = useState<Met[]>([]); const [f, setF] = useState<Record<string, string>>({}); const [err, setErr] = useState('')
  const load = useCallback(() => { supabase.from('content_metrics').select('*').eq('published_id', pubId).order('recorded_on').then(r => setRows((r.data as Met[]) ?? [])) }, [pubId])
  useEffect(() => { load() }, [load])
  async function add(e: FormEvent) {
    e.preventDefault(); setErr(''); const row: Record<string, unknown> = { published_id: pubId, source_note: f.source_note || null }
    if (f.recorded_on) row.recorded_on = f.recorded_on
    for (const [k, l] of MKEYS) { const v = (f[k] ?? '').trim(); if (v === '') { row[k] = null; continue } const n = Number(v); if (!Number.isInteger(n) || n < 0) return setErr(`${l}: กรอกจำนวนเต็มตั้งแต่ 0 ขึ้นไป`); row[k] = n }
    if (MKEYS.every(([k]) => row[k] === null)) return setErr('กรอกตัวเลขอย่างน้อย 1 ช่อง')
    const { error } = await supabase.from('content_metrics').insert(row); if (error) setErr('บันทึกไม่สำเร็จ: ' + error.message); else { setF({}); load() }
  }
  const pts = rows.filter(r => r.views !== null); const max = Math.max(1, ...pts.map(r => r.views as number))
  return (
    <div className="space-y-2 border-t pt-3 text-sm"><h3 className="font-medium">สถิติผลงาน (กรอกด้วยตนเอง)</h3>
      {rows.length === 0 ? <p className="text-slate-500">ยังไม่มีข้อมูลสถิติ</p> : <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th>วันที่</th>{MKEYS.map(([k, l]) => <th key={k}>{l}</th>)}<th>ER*</th></tr></thead><tbody>
        {rows.map(r => <tr key={r.id} className="border-t"><td>{r.recorded_on}</td>{MKEYS.map(([k]) => <td key={k}>{num(r[k])}</td>)}<td>{er(r)}</td></tr>)}</tbody></table></div>}
      <p className="text-xs text-slate-500">*ER = (Likes + Comments + Shares + Saves) ÷ Reach × 100 คำนวณเมื่อมีครบทุกค่า “—” คือไม่ได้บันทึก ไม่ใช่ 0 ข้อมูลทั้งหมดกรอกเอง ระบบไม่ได้ดึงจากแพลตฟอร์ม</p>
      {pts.length >= 2 ? <svg viewBox="0 0 300 80" className="w-full max-w-md" role="img" aria-label="แนวโน้มยอดเข้าชม"><polyline fill="none" stroke="#14B8A6" strokeWidth="2" points={pts.map((r, i) => `${10 + i * 280 / (pts.length - 1)},${70 - (r.views as number) / max * 60}`).join(' ')} /></svg> : <p className="text-slate-400">กราฟแสดงเมื่อมียอดเข้าชมอย่างน้อย 2 วัน</p>}
      <form onSubmit={add} className="grid grid-cols-2 gap-2 md:grid-cols-4"><label>วันที่บันทึก<input type="date" className="w-full rounded border p-1" value={f.recorded_on ?? ''} onChange={e => setF({ ...f, recorded_on: e.target.value })} /></label>
        {MKEYS.map(([k, l]) => <label key={k}>{l}<input inputMode="numeric" className="w-full rounded border p-1" value={f[k] ?? ''} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>)}
        <label className="col-span-2">แหล่งที่มา / หมายเหตุ<input className="w-full rounded border p-1" value={f.source_note ?? ''} onChange={e => setF({ ...f, source_note: e.target.value })} /></label>
        <button className="rounded bg-navy px-3 py-1 text-white">บันทึกสถิติ</button></form>
      {err && <p className="text-red-600" role="alert">{err}</p>}
    </div>)
}

function Publish({ idea, me }: { idea: Idea; me: Profile }) {
  const [list, setList] = useState<{ id: string; title: string; url: string; platform: string }[]>([]); const [f, setF] = useState({ title: idea.title, url: '', platform: 'Facebook', published_at: '' }); const [err, setErr] = useState('')
  const load = useCallback(() => { supabase.from('published_contents').select('id,title,url,platform').eq('idea_id', idea.id).then(r => setList((r.data as typeof list) ?? [])) }, [idea.id])
  useEffect(() => { load() }, [load])
  if (!['ready_to_publish', 'published', 'completed'].includes(idea.status)) return null
  const can = idea.owner_id === me.id || ['content_manager', 'admin'].includes(me.role)
  async function add(e: FormEvent) {
    e.preventDefault(); setErr('')
    try { const u = new URL(f.url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error() } catch { return setErr('ลิงก์ไม่ถูกต้อง ต้องขึ้นต้นด้วย https:// หรือ http://') }
    const r = await supabase.from('published_contents').insert({ idea_id: idea.id, title: f.title, url: f.url, platform: f.platform, published_at: f.published_at ? new Date(f.published_at).toISOString() : null }).select('id').single()
    if (r.error) return setErr('บันทึกไม่สำเร็จ: ' + r.error.message)
    await supabase.from('portfolio_contributions').insert({ published_id: r.data.id, user_id: me.id, role_label: 'ผู้บันทึกผลงาน' }); setF({ ...f, url: '' }); load()
  }
  return (
    <div className="space-y-2 border-t pt-3 text-sm"><h3 className="font-medium">ลิงก์ผลงานที่เผยแพร่</h3>
      {list.length === 0 && <p className="text-slate-500">ยังไม่มีลิงก์ ต้องบันทึกก่อนเปลี่ยนสถานะเป็น “ออนไลน์แล้ว”</p>}
      {list.map(x => <p key={x.id}>{x.platform}: <a className="text-navy underline" href={x.url} target="_blank" rel="noopener noreferrer">{x.title}</a></p>)}
      {can && <form onSubmit={add} className="space-y-1"><input className="w-full rounded border p-2" placeholder="ชื่อผลงาน" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} required />
        <input className="w-full rounded border p-2" placeholder="https://..." value={f.url} onChange={e => setF({ ...f, url: e.target.value })} required />
        <div className="flex gap-2"><select className="rounded border p-2" value={f.platform} onChange={e => setF({ ...f, platform: e.target.value })}>{PLATFORMS.map(p => <option key={p}>{p}</option>)}</select>
          <input type="datetime-local" className="min-w-0 flex-1 rounded border p-2" value={f.published_at} onChange={e => setF({ ...f, published_at: e.target.value })} /></div>
        <button className="rounded bg-mint px-3 py-1 text-white">บันทึกลิงก์</button></form>}
      {err && <p className="text-red-600" role="alert">{err}</p>}
    </div>)
}

function Portfolio({ me, ideas, open }: { me: Profile; ideas: Idea[]; open: (id: string) => void }) {
  const [pubs, setPubs] = useState<Pub[]>([]); const [top, setTop] = useState<{ title: string; views: number } | null>(null); const [sel, setSel] = useState<string | null>(null)
  const [pf, setPf] = useState(''); const [month, setMonth] = useState(''); const [grid, setGrid] = useState(true); const [loading, setLoading] = useState(true)
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]); const [who, setWho] = useState(''); const [role, setRole] = useState(''); const [err, setErr] = useState('')
  const load = useCallback(async () => {
    const r = await supabase.from('published_contents').select('*').order('published_at', { ascending: false, nullsFirst: false })
    if (r.error) { setErr('โหลดผลงานไม่สำเร็จ: ' + r.error.message); setLoading(false); return }
    const published = (r.data ?? []) as Omit<Pub, 'portfolio_contributions'>[]
    const contributionResult = published.length
      ? await supabase.from('portfolio_contributions').select('published_id,user_id,role_label').in('published_id', published.map(item => item.id))
      : { data: [], error: null }
    if (contributionResult.error) { setErr('โหลดผู้ร่วมสร้างไม่สำเร็จ: ' + contributionResult.error.message); setLoading(false); return }
    const contributions = (contributionResult.data ?? []) as { published_id: string; user_id: string; role_label: string }[]
    const userIds = [...new Set(contributions.map(item => item.user_id))]
    const namesResult = userIds.length ? await supabase.from('profile_names').select('id,name').in('id', userIds) : { data: [], error: null }
    if (namesResult.error) { setErr('โหลดชื่อผู้ร่วมสร้างไม่สำเร็จ: ' + namesResult.error.message); setLoading(false); return }
    const nameMap = new Map(((namesResult.data ?? []) as { id: string; name: string }[]).map(person => [person.id, person.name]))
    const withContrib = published.map(item => ({
      ...item,
      portfolio_contributions: contributions.filter(contribution => contribution.published_id === item.id)
        .map(contribution => ({ ...contribution, name: nameMap.get(contribution.user_id) ?? 'ผู้ใช้' })),
    })) as Pub[]
    const mine = withContrib.filter(x => x.created_by === me.id || x.portfolio_contributions.some(c => c.user_id === me.id)); setPubs(mine); setLoading(false)
    if (mine.length) { const m = await supabase.from('content_metrics').select('published_id,views,recorded_on').in('published_id', mine.map(x => x.id)).not('views', 'is', null).order('recorded_on', { ascending: false })
      const seen = new Set<string>(); let best: { title: string; views: number } | null = null
      for (const x of (m.data ?? []) as { published_id: string; views: number }[]) { if (seen.has(x.published_id)) continue; seen.add(x.published_id); if (!best || x.views > best.views) best = { title: mine.find(p => p.id === x.published_id)!.title, views: x.views } }
      setTop(best) }
    const pr = await supabase.from('profile_names').select('id,name').order('name'); setPeople((pr.data as typeof people) ?? [])
  }, [me.id])
  useEffect(() => { load() }, [load])
  const shown = pubs.filter(x => (!pf || x.platform === pf) && (!month || (x.published_at ?? '').startsWith(month)))
  const cur = pubs.find(x => x.id === sel)
  const running = ideas.filter(i => i.owner_id === me.id && !['draft', 'published', 'completed', 'rejected', 'cancelled'].includes(i.status)).length
  async function addPerson() {
    if (!cur || !who || !role.trim()) return setErr('เลือกคนและระบุบทบาท'); setErr('')
    const { error } = await supabase.from('portfolio_contributions').insert({ published_id: cur.id, user_id: who, role_label: role.trim() }); if (error) setErr(error.message); else { setWho(''); setRole(''); load() }
  }
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4"><h1 className="text-lg font-semibold">My Portfolio</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{([['ผลงานที่ออนไลน์แล้ว', String(pubs.length)], ['ไอเดียที่กำลังดำเนินการ', String(running)], ['ผลงานล่าสุด', pubs[0]?.title ?? '—'], ['ยอดเข้าชมสูงสุด', top ? `${top.title} (${top.views.toLocaleString('th-TH')})` : 'ยังไม่มีข้อมูลสถิติ']] as const).map(([l, v]) => <div key={l} className="rounded bg-white p-3"><div className="truncate font-semibold text-navy">{v}</div><div className="text-sm text-slate-500">{l}</div></div>)}</div>
      <div className="flex flex-wrap gap-2"><select className="rounded border p-2" value={pf} onChange={e => setPf(e.target.value)}><option value="">ทุกแพลตฟอร์ม</option>{PLATFORMS.map(p => <option key={p}>{p}</option>)}</select>
        <input type="month" className="rounded border p-2" value={month} onChange={e => setMonth(e.target.value)} aria-label="เดือนที่เผยแพร่" /><button className="rounded border px-3" onClick={() => setGrid(!grid)}>{grid ? 'มุมมองรายการ' : 'มุมมอง Grid'}</button></div>
      {loading ? <p>กำลังโหลด…</p> : shown.length === 0 ? <p className="rounded bg-white p-4 text-slate-500">ยังไม่มีผลงาน เมื่องานพร้อมออนไลน์ ให้บันทึกลิงก์ในหน้ารายละเอียดไอเดีย</p> :
        <div className={grid ? 'grid gap-3 md:grid-cols-3' : 'space-y-2'}>{shown.map(x => <button key={x.id} onClick={() => setSel(x.id)} className={`rounded bg-white p-3 text-left ${sel === x.id ? 'ring-2 ring-mint' : ''}`}><div className="font-medium">{x.title}</div><div className="text-xs text-slate-500">{x.platform} · {x.published_at ? new Date(x.published_at).toLocaleDateString('th-TH') : 'ไม่ระบุวันที่'}</div></button>)}</div>}
      {cur && <div className="space-y-2 rounded bg-white p-4 text-sm"><h2 className="text-base font-semibold">{cur.title}</h2>
        <a className="text-navy underline" href={cur.url} target="_blank" rel="noopener noreferrer">เปิดลิงก์ผลงาน ({cur.platform})</a> <button className="ml-3 underline" onClick={() => open(cur.idea_id)}>ดู Workflow ต้นทาง</button>
        <div><b>ผู้ร่วมสร้าง</b>{cur.portfolio_contributions.map(c => <div key={c.user_id}>{c.name} — {c.role_label}</div>)}</div>
        {(cur.created_by === me.id || ['content_manager', 'admin'].includes(me.role)) && <div className="flex flex-wrap gap-2"><select className="rounded border p-1" value={who} onChange={e => setWho(e.target.value)}><option value="">เลือกคน</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input className="rounded border p-1" placeholder="บทบาท เช่น ตัดต่อ" value={role} onChange={e => setRole(e.target.value)} /><button className="rounded bg-navy px-3 text-white" onClick={addPerson}>เพิ่มเครดิต</button></div>}
        {err && <p className="text-red-600" role="alert">{err}</p>}<Metrics pubId={cur.id} /></div>}
    </div>)
}

function Analytics() {
  const [pubs, setPubs] = useState<{ id: string; title: string; platform: string }[]>([]); const [sel, setSel] = useState('')
  useEffect(() => { supabase.from('published_contents').select('id,title,platform').order('created_at', { ascending: false }).then(r => setPubs((r.data as typeof pubs) ?? [])) }, [])
  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4"><h1 className="text-lg font-semibold">Analytics</h1>
      {pubs.length === 0 ? <p className="rounded bg-white p-4 text-slate-500">ยังไม่มีผลงานที่เผยแพร่ให้บันทึกสถิติ</p> : <select className="rounded border p-2" value={sel} onChange={e => setSel(e.target.value)}><option value="">เลือกผลงาน</option>{pubs.map(x => <option key={x.id} value={x.id}>{x.title} ({x.platform})</option>)}</select>}
      {sel && <div className="rounded bg-white p-4"><Metrics pubId={sel} /></div>}{pubs.length > 1 && <Compare pubs={pubs} />}</div>)
}

interface Comp { uid: string; red_stack: number; missed_total: number; week_count: number; required: number; next_deadline: string; week_ok: boolean }
function Compliance({ me }: { me: Profile }) {
  const [rows, setRows] = useState<Comp[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    void (async () => {
      const report = await supabase.rpc('compliance_report')
      if (report.error) return
      const data = (report.data as Comp[]) ?? []
      setRows(data)
      const profileNames = data.length ? await supabase.from('profile_names').select('id,name').in('id', data.map(row => row.uid)) : { data: [], error: null }
      if (!profileNames.error) setNames(new Map(((profileNames.data ?? []) as { id: string; name: string }[]).map(profile => [profile.id, profile.name])))
    })()
  }, [])
  const mine = rows.find(r => r.uid === me.id); const all = ['content_manager', 'admin'].includes(me.role)
  const day = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })
  if (rows.length === 0) return null
  return (
    <section className="space-y-2">
      {mine && <div className={`rounded p-4 ${mine.red_stack > 0 ? 'bg-red-50 ring-2 ring-red-500' : 'bg-white'}`}>
        <div className="flex items-center gap-2 font-medium">{mine.red_stack > 0 && <span className="rounded-full bg-red-600 px-2 text-sm text-white" role="status">ค้างส่ง {mine.red_stack}</span>}
          {mine.week_ok ? 'สัปดาห์นี้ส่งไอเดียแล้ว' : `สัปดาห์นี้ยังไม่ส่ง (${mine.week_count}/${mine.required}) ส่งก่อนสิ้นวัน${day(mine.next_deadline)}`}</div>
        {mine.red_stack > 0 && <p className="text-sm text-red-700">แต่ละสัปดาห์ที่ส่งตามกำหนดจะลดตัวเลขลงทีละ 1 เท่านั้น ส่งเกินกำหนดไม่ได้ช่วยลดเพิ่ม</p>}</div>}
      {all && <div className="overflow-x-auto rounded bg-white p-4"><h2 className="mb-2 font-medium">การส่งไอเดียประจำสัปดาห์ (ส่งก่อนสิ้นวัน{day(rows[0].next_deadline)})</h2>
        <table className="w-full text-left text-sm"><thead><tr><th>ชื่อ</th><th>สัปดาห์นี้</th><th>ค้างส่ง</th><th>พลาดสะสม</th></tr></thead><tbody>
          {[...rows].sort((a, b) => b.red_stack - a.red_stack).map(r => <tr key={r.uid} className="border-t"><td>{r.red_stack > 0 && <span className="text-red-600">● </span>}{names.get(r.uid) ?? (r.uid === me.id ? nameOf(me) : 'ผู้ใช้')}</td><td>{r.week_ok ? 'ส่งแล้ว' : `ยังไม่ส่ง (${r.week_count}/${r.required})`}</td><td className={r.red_stack > 0 ? 'font-semibold text-red-600' : ''}>{r.red_stack}</td><td>{r.missed_total}</td></tr>)}</tbody></table></div>}
    </section>)
}

interface Prof {
  id: string
  full_name: string
  display_name: string | null
  role: Role
  is_active: boolean
  exempt_from_submission: boolean
  employee_code: string | null
  approval_status: 'pending' | 'approved' | 'rejected'
  created_at: string
  department: string | null
  avatar_url: string | null
  phone: string
}
interface PendingProf { id: string; full_name: string; phone: string | null; created_at: string }
type ProfileDraft = Pick<Prof, 'full_name' | 'display_name' | 'role' | 'is_active' | 'exempt_from_submission' | 'employee_code' | 'approval_status' | 'department' | 'avatar_url' | 'phone'>
interface Pol { enabled: boolean; deadline_dow: number; required_count: number; start_date: string }
const DOW = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์']

const ADMIN_DATA_TABLES = [
  { table: 'content_ideas', label: 'ไอเดีย', key: 'id', sample: { title: '', status: 'draft' } },
  { table: 'projects', label: 'โครงการและบท', key: 'id', sample: { idea_id: '', script: '', shot_list: '' } },
  { table: 'script_versions', label: 'เวอร์ชันบท', key: 'id', sample: { project_id: '', version: 1, body: '' } },
  { table: 'checklist_items', label: 'Checklist', key: 'id', sample: { idea_id: '', label: '', is_required: true } },
  { table: 'published_contents', label: 'ผลงานที่เผยแพร่', key: 'id', sample: { idea_id: '', title: '', url: 'https://', platform: 'Facebook' } },
  { table: 'content_metrics', label: 'สถิติผลงาน', key: 'id', sample: { published_id: '', recorded_on: new Date().toLocaleDateString('sv-SE') } },
  { table: 'comments', label: 'ความคิดเห็น', key: 'id', sample: { idea_id: '', body: '' } },
  { table: 'idea_attachments', label: 'ไฟล์แนบ', key: 'id', sample: { idea_id: '', path: '', file_name: '' } },
  { table: 'content_categories', label: 'หมวดหมู่', key: 'id', sample: { name: '', sort_order: 0 } },
  { table: 'products', label: 'สินค้า', key: 'id', sample: { name: '', is_active: true } },
  { table: 'departments', label: 'แผนก', key: 'id', sample: { name: '' } },
  { table: 'platform_settings', label: 'แพลตฟอร์ม', key: 'platform', sample: { platform: '', is_active: true } },
] as const
type AdminDataTable = typeof ADMIN_DATA_TABLES[number]['table']
type AdminDataRow = Record<string, unknown>

function AdminDataEditor() {
  const [table, setTable] = useState<AdminDataTable>('content_ideas')
  const [rows, setRows] = useState<AdminDataRow[]>([])
  const [selected, setSelected] = useState<AdminDataRow | null>(null)
  const [editor, setEditor] = useState('{}')
  const [insertEditor, setInsertEditor] = useState(JSON.stringify(ADMIN_DATA_TABLES[0].sample, null, 2))
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const config = ADMIN_DATA_TABLES.find(item => item.table === table)!
  const load = useCallback(async () => {
    const result = await supabase.from(table as 'content_ideas').select('*').limit(100)
    if (result.error) { setErr('โหลดข้อมูลไม่สำเร็จ: ' + result.error.message); return }
    setRows((result.data ?? []) as unknown as AdminDataRow[])
    setErr('')
  }, [table])
  useEffect(() => { void load() }, [load])
  function chooseTable(next: AdminDataTable) {
    setTable(next)
    const nextConfig = ADMIN_DATA_TABLES.find(item => item.table === next)!
    setInsertEditor(JSON.stringify(nextConfig.sample, null, 2))
    setSelected(null)
  }
  function parseEditor(text: string): AdminDataRow | null {
    try {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value as AdminDataRow
    } catch {
      setErr('ข้อมูลต้องเป็น JSON object ที่ถูกต้อง')
      return null
    }
  }
  function explainError(message: string, code?: string) {
    if (code === '23503') return 'ยังมีข้อมูลที่เชื่อมโยงอยู่ ไม่สามารถดำเนินการได้'
    if (code === '23505') return 'ข้อมูลซ้ำกับรายการที่มีอยู่แล้ว'
    if (code === '23502' || code === '23514') return 'ข้อมูลไม่ครบหรือไม่ผ่านเงื่อนไขของฐานข้อมูล'
    return message
  }
  async function insertRow() {
    setErr(''); setMsg('')
    const value = parseEditor(insertEditor)
    if (!value) return
    const result = await supabase.from(table as 'content_ideas').insert(value as never)
    if (result.error) setErr('เพิ่มข้อมูลไม่สำเร็จ: ' + explainError(result.error.message, result.error.code))
    else { setMsg('เพิ่มข้อมูลแล้ว'); await load() }
  }
  async function updateRow() {
    if (!selected) return
    setErr(''); setMsg('')
    const value = parseEditor(editor)
    if (!value) return
    const id = value[config.key]
    if (id === undefined || id === null || id === '') return setErr(`ต้องมีค่า ${config.key}`)
    const result = await supabase.from(table as 'content_ideas').update(value as never).eq(config.key, String(id))
    if (result.error) setErr('แก้ไขข้อมูลไม่สำเร็จ: ' + explainError(result.error.message, result.error.code))
    else { setMsg('แก้ไขข้อมูลแล้ว'); setSelected(value); await load() }
  }
  async function deleteRow(row: AdminDataRow) {
    const id = row[config.key]
    if (id === undefined || id === null) return setErr(`ไม่พบค่า ${config.key}`)
    if (!window.confirm(`ยืนยันลบ${config.label}รายการนี้หรือไม่ การลบอาจกระทบข้อมูลที่เชื่อมโยง`)) return
    setErr(''); setMsg('')
    const result = await supabase.from(table as 'content_ideas').delete().eq(config.key, String(id))
    if (result.error) return setErr('ลบข้อมูลไม่สำเร็จ: ' + explainError(result.error.message, result.error.code))
    if (table === 'idea_attachments' && typeof row.path === 'string') {
      const storageResult = await supabase.storage.from('idea-files').remove([row.path])
      if (storageResult.error) {
        setErr('ลบข้อมูลไฟล์แนบแล้ว แต่ลบไฟล์ใน Storage ไม่สำเร็จ: ' + storageResult.error.message)
        await load()
        return
      }
    }
    setMsg('ลบข้อมูลแล้ว'); if (selected?.[config.key] === id) setSelected(null); await load()
  }
  return (
    <section className="space-y-3 rounded bg-white p-4 text-sm">
      <h2 className="font-medium">จัดการข้อมูลและเนื้อหา</h2>
      <label className="block">ประเภทข้อมูล
        <select className="mt-1 w-full rounded border p-2" value={table} onChange={e => chooseTable(e.target.value as AdminDataTable)}>
          {ADMIN_DATA_TABLES.map(item => <option key={item.table} value={item.table}>{item.label}</option>)}
        </select>
      </label>
      {rows.length === 0 ? <p className="text-slate-500">ไม่มีรายการ</p> : <div className="max-h-64 space-y-1 overflow-auto">
        {rows.map((row, index) => {
          const key = row[config.key]
          return <div key={String(key ?? index)} className="flex items-start gap-2 rounded bg-slate-50 p-2">
            <button className="min-w-0 flex-1 break-all text-left hover:underline" onClick={() => { setSelected(row); setEditor(JSON.stringify(row, null, 2)); setErr('') }}>
              {String(key ?? index)} · {String(row.title ?? row.name ?? row.platform ?? row.label ?? row.body ?? row.file_name ?? 'รายการ')}
            </button>
            <button className="text-red-700 underline" onClick={() => deleteRow(row)} aria-label={`ลบรายการ ${String(key ?? index)}`}>ลบ</button>
          </div>
        })}
      </div>}
      {selected && <div className="space-y-2 border-t pt-3">
        <label className="block">แก้ไขข้อมูล (JSON)
          <textarea className="mt-1 min-h-40 w-full rounded border p-2 font-mono text-xs" value={editor} onChange={e => setEditor(e.target.value)} />
        </label>
        <button className="rounded bg-navy px-3 py-1 text-white" onClick={updateRow}>บันทึกการแก้ไข</button>
      </div>}
      <details className="border-t pt-3">
        <summary className="cursor-pointer">เพิ่ม{config.label}</summary>
        <label className="mt-2 block">ข้อมูลใหม่ (JSON)
          <textarea className="mt-1 min-h-32 w-full rounded border p-2 font-mono text-xs" value={insertEditor} onChange={e => setInsertEditor(e.target.value)} />
        </label>
        <button className="mt-2 rounded bg-mint px-3 py-1 text-white" onClick={insertRow}>เพิ่มข้อมูล</button>
      </details>
      {err && <p className="text-red-600" role="alert">{err}</p>}
      {msg && <p role="status">{msg}</p>}
    </section>
  )
}

function AdminForceStatus() {
  const [ideas, setIdeas] = useState<{ id: string; code: string; title: string; status: string }[]>([])
  const [id, setId] = useState(''); const [status, setStatus] = useState('draft'); const [note, setNote] = useState('')
  const [err, setErr] = useState(''); const [msg, setMsg] = useState('')
  useEffect(() => {
    supabase.from('content_ideas').select('id,code,title,status').order('created_at', { ascending: false }).limit(200)
      .then(result => { if (result.error) setErr('โหลดไอเดียไม่สำเร็จ: ' + result.error.message); else setIdeas(result.data ?? []) })
  }, [])
  async function force() {
    if (!id || !note.trim()) { setErr('เลือกไอเดียและระบุหมายเหตุ'); return }
    if (!window.confirm('ยืนยันบังคับเปลี่ยนสถานะไอเดียหรือไม่')) return
    const { error } = await supabase.rpc('admin_force_status', { p_idea: id, p_status: status, p_note: note.trim() })
    if (error) setErr('บังคับเปลี่ยนสถานะไม่สำเร็จ: ' + error.message)
    else { setMsg('เปลี่ยนสถานะแล้ว'); setErr(''); setNote('') }
  }
  return <section className="space-y-2 rounded bg-white p-4 text-sm">
    <h2 className="font-medium">บังคับเปลี่ยนสถานะ</h2>
    <label className="block">ไอเดีย<select className="mt-1 w-full rounded border p-2" value={id} onChange={e => setId(e.target.value)}><option value="">เลือกไอเดีย</option>{ideas.map(idea => <option key={idea.id} value={idea.id}>{idea.code} · {idea.title} ({STATUS[idea.status]?.th ?? idea.status})</option>)}</select></label>
    <label className="block">สถานะใหม่<select className="mt-1 w-full rounded border p-2" value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(STATUS).map(([key, value]) => <option key={key} value={key}>{value.th}</option>)}</select></label>
    <label className="block">หมายเหตุ (จำเป็น)<textarea className="mt-1 w-full rounded border p-2" value={note} onChange={e => setNote(e.target.value)} /></label>
    <button className="rounded bg-navy px-3 py-1 text-white" onClick={force}>ยืนยันบังคับเปลี่ยนสถานะ</button>
    {err && <p role="alert" className="text-red-600">{err}</p>}{msg && <p role="status">{msg}</p>}
  </section>
}

function Admin() {
  const [users, setUsers] = useState<Prof[]>([])
  const [pending, setPending] = useState<PendingProf[]>([])
  const [approveRoles, setApproveRoles] = useState<Record<string, Role>>({})
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({})
  const [generatedPins, setGeneratedPins] = useState<Record<string, string>>({})
  const [pol, setPol] = useState<Pol | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [aud, setAud] = useState<{ id: number; action: string; detail: unknown; created_at: string }[]>([])
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const load = useCallback(async () => {
    const [u, p, a, setting] = await Promise.all([
      supabase.from('profiles').select('id,full_name,display_name,role,is_active,exempt_from_submission,employee_code,approval_status,created_at,department,avatar_url').order('full_name'),
      supabase.from('submission_policy').select('enabled,deadline_dow,required_count,start_date').single(),
      supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('app_settings').select('value').eq('key', 'join_code').single(),
    ])
    if (u.error || p.error || a.error || setting.error) {
      setErr('โหลดข้อมูลผู้ดูแลไม่สำเร็จ: ' + (u.error ?? p.error ?? a.error ?? setting.error)?.message)
      return
    }
    const rawProfiles = (u.data ?? []) as Omit<Prof, 'phone'>[]
    const privateResult = rawProfiles.length
      ? await supabase.from('profile_private').select('user_id,phone').in('user_id', rawProfiles.map(profile => profile.id))
      : { data: [], error: null }
    if (privateResult.error) {
      setErr('โหลดเบอร์โทรศัพท์ผู้ใช้ไม่สำเร็จ: ' + privateResult.error.message)
      return
    }
    const phoneMap = new Map(((privateResult.data ?? []) as { user_id: string; phone: string }[]).map(row => [row.user_id, row.phone]))
    const profiles = rawProfiles.map(profile => ({ ...profile, phone: phoneMap.get(profile.id) ?? '' })) as Prof[]
    setUsers(profiles)
    setDrafts(Object.fromEntries(profiles.map(profile => [profile.id, {
      full_name: profile.full_name, display_name: profile.display_name, role: profile.role,
      is_active: profile.is_active, exempt_from_submission: profile.exempt_from_submission,
      employee_code: profile.employee_code, approval_status: profile.approval_status,
      department: profile.department, avatar_url: profile.avatar_url, phone: profile.phone,
    }])))
    const waiting = profiles.filter(profile => profile.approval_status === 'pending')
    setPending(waiting.map(profile => ({ id: profile.id, full_name: profile.full_name, phone: profile.phone || null, created_at: profile.created_at })))
    setApproveRoles(current => Object.fromEntries(waiting.map(profile => [profile.id, current[profile.id] ?? 'employee'])))
    setPol(p.data as Pol | null)
    setAud((a.data as typeof aud) ?? [])
    setJoinCode(setting.data.value)
    setErr('')
  }, [])
  useEffect(() => { load() }, [load])
  function editUser(id: string, patch: Partial<ProfileDraft>) {
    setDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }))
  }
  async function saveUser(id: string) {
    setErr('')
    const draft = drafts[id]
    if (!draft) return
    if (draft.phone && !isValidPhone(draft.phone)) { setErr('เบอร์โทรศัพท์ต้องมี 10 หลักและขึ้นต้นด้วย 0'); return }
    const current = users.find(user => user.id === id)
    const destructive = current && (
      (current.is_active && !draft.is_active)
      || (current.approval_status !== 'rejected' && draft.approval_status === 'rejected')
      || (current.role !== draft.role)
      || (Boolean(current.phone) && !draft.phone.trim())
    )
    if (destructive && !window.confirm('ยืนยันเปลี่ยนสิทธิ์ ปิดบัญชี ปฏิเสธคำขอ หรือลบเบอร์โทรศัพท์ของผู้ใช้นี้หรือไม่')) return
    const { error } = await supabase.from('profiles').update({
      full_name: draft.full_name.trim(), display_name: draft.display_name?.trim() || null,
      role: draft.role, is_active: draft.is_active, exempt_from_submission: draft.exempt_from_submission,
      employee_code: draft.employee_code?.trim() || null, approval_status: draft.approval_status,
      department: draft.department?.trim() || null, avatar_url: draft.avatar_url?.trim() || null,
    }).eq('id', id)
    if (error) { setErr('บันทึกข้อมูลผู้ใช้ไม่สำเร็จ: ' + error.message); return }
    if (draft.phone) {
      const { error: phoneError } = await supabase.from('profile_private').upsert({ user_id: id, phone: normalizePhone(draft.phone) }, { onConflict: 'user_id' })
      if (phoneError) { setErr('บันทึกเบอร์โทรศัพท์ไม่สำเร็จ: ' + phoneError.message); return }
    } else {
      const { error: phoneError } = await supabase.from('profile_private').delete().eq('user_id', id)
      if (phoneError) { setErr('ลบเบอร์โทรศัพท์ไม่สำเร็จ: ' + phoneError.message); return }
    }
    setMsg('บันทึกข้อมูลผู้ใช้แล้ว')
    await load()
  }
  async function approve(user: PendingProf) {
    editUser(user.id, { role: approveRoles[user.id] ?? 'employee', approval_status: 'approved' })
    setDrafts(current => ({ ...current, [user.id]: { ...current[user.id], role: approveRoles[user.id] ?? 'employee', approval_status: 'approved' } }))
    const { error } = await supabase.from('profiles').update({ role: approveRoles[user.id] ?? 'employee', approval_status: 'approved' }).eq('id', user.id)
    if (error) setErr('อนุมัติบัญชีไม่สำเร็จ: ' + error.message)
    else { setMsg('อนุมัติบัญชีแล้ว'); await load() }
  }
  async function resetPin(user: Prof) {
    const numbers = new Uint32Array(16)
    let generated = ''
    for (const number of crypto.getRandomValues(numbers)) {
      const candidate = String(number % 100_000_000).padStart(8, '0')
      if (isValidPin(candidate)) { generated = candidate; break }
    }
    if (!generated) { setErr('สร้าง PIN ไม่สำเร็จ กรุณาลองอีกครั้ง'); return }
    const { error } = await supabase.rpc('admin_set_pin', { p_user: user.id, p_new: generated })
    if (error) setErr(error.message.includes('PIN นี้ใช้ไม่ได้') ? error.message : 'รีเซ็ต PIN ไม่สำเร็จ: ' + error.message)
    else {
      setGeneratedPins(current => ({ ...current, [user.id]: generated }))
      setMsg(`รีเซ็ต PIN ของ ${nameOf(user)} แล้ว จด PIN นี้ไว้ก่อนปิดหน้านี้`)
    }
  }
  async function savePol() {
    if (!pol) return
    const { error } = await supabase.from('submission_policy').update(pol).eq('id', true)
    if (error) setErr('บันทึกกติกาไม่สำเร็จ: ' + error.message)
    else { setMsg('บันทึกกติกาแล้ว'); await load() }
  }
  async function saveJoinCode() {
    if (!joinCode.trim()) {
      setErr('รหัสเข้าร่วมต้องไม่เว้นว่าง')
      return
    }
    const { error } = await supabase.from('app_settings').update({ value: joinCode.trim() }).eq('key', 'join_code')
    if (error) setErr('เปลี่ยนรหัสเข้าร่วมไม่สำเร็จ: ' + error.message)
    else setMsg('เปลี่ยนรหัสเข้าร่วมแล้ว')
  }
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4"><h1 className="text-lg font-semibold">การจัดการระบบ</h1>
      <aside className="rounded border border-amber-300 bg-amber-50 p-3 text-sm" aria-label="คำแนะนำการรีเซ็ต PIN">
        หากพนักงานลืม PIN ให้กด “รีเซ็ต PIN” ในรายการผู้ใช้ แล้วแจ้ง PIN ใหม่ผ่านช่องทางส่วนตัวที่ปลอดภัย PIN จะแสดงในหน้านี้ครั้งเดียว ควรให้ผู้ใช้เปลี่ยน PIN หลังเข้าสู่ระบบ
      </aside>
      {msg && <p className="text-sm" role="status">{msg}</p>}{err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <section className="space-y-3 rounded bg-white p-4 text-sm">
        <h2 className="font-medium">รออนุมัติ</h2>
        {pending.length === 0 ? <p className="text-slate-500">ไม่มีบัญชีรออนุมัติ</p> : <div className="space-y-3">
          {pending.map(user => <div key={user.id} className="flex flex-wrap items-center gap-2 border-t pt-3">
            <div className="min-w-48 flex-1"><b>{user.full_name || 'ไม่ระบุชื่อ'}</b><div>{user.phone ?? 'ไม่มีเบอร์โทรศัพท์'}</div><div className="text-slate-500">สมัครเมื่อ {new Date(user.created_at).toLocaleString('th-TH')}</div></div>
            {user.phone
              ? <>
                <label>บทบาทหลังอนุมัติ
                  <select className="ml-1 rounded border p-1" value={approveRoles[user.id] ?? 'employee'} onChange={e => setApproveRoles({ ...approveRoles, [user.id]: e.target.value as Role })}>
                    {(Object.keys(ROLE_TH) as Role[]).map(role => <option key={role} value={role}>{ROLE_TH[role]}</option>)}
                  </select>
                </label>
                <button className="rounded bg-mint px-3 py-1 text-white" onClick={() => approve(user)}>อนุมัติ</button>
                <button className="rounded border border-red-300 px-3 py-1 text-red-700" onClick={() => {
                  if (window.confirm(`ยืนยันปฏิเสธคำขอของ ${user.full_name} หรือไม่`)) {
                    void supabase.from('profiles').update({ approval_status: 'rejected' }).eq('id', user.id).then(result => {
                      if (result.error) setErr('ปฏิเสธคำขอไม่สำเร็จ: ' + result.error.message)
                      else { setMsg('ปฏิเสธคำขอแล้ว'); void load() }
                    })
                  }
                }}>ปฏิเสธ</button>
              </>
              : <p className="text-amber-800">บัญชีที่สร้างจาก Dashboard ต้องกำหนด role และอนุมัติผ่าน SQL</p>}
          </div>)}
        </div>}
      </section>
      <section className="space-y-2 rounded bg-white p-4 text-sm">
        <h2 className="font-medium">รหัสเข้าร่วมบริษัท</h2>
        <label className="block">รหัสเข้าร่วม
          <input className="mt-1 w-full rounded border p-2" value={joinCode} onChange={e => setJoinCode(e.target.value)} />
        </label>
        <button onClick={saveJoinCode} className="rounded bg-mint px-3 py-1 text-white">บันทึกรหัสเข้าร่วม</button>
      </section>
      {pol && <div className="space-y-2 rounded bg-white p-4 text-sm"><h2 className="font-medium">กติกาส่งไอเดียประจำสัปดาห์</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={pol.enabled} onChange={e => setPol({ ...pol, enabled: e.target.checked })} />เปิดใช้งาน</label>
        <div className="flex flex-wrap gap-3"><label>กำหนดส่ง (สิ้นวัน)<select className="ml-1 rounded border p-1" value={pol.deadline_dow} onChange={e => setPol({ ...pol, deadline_dow: Number(e.target.value) })}>{DOW.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>
          <label>ส่งอย่างน้อย/สัปดาห์<input type="number" min={1} className="ml-1 w-16 rounded border p-1" value={pol.required_count} onChange={e => setPol({ ...pol, required_count: Math.max(1, Number(e.target.value)) })} /></label>
          <label>เริ่มนับสัปดาห์หลังวันที่<input type="date" className="ml-1 rounded border p-1" value={pol.start_date} onChange={e => setPol({ ...pol, start_date: e.target.value })} /></label></div>
        <button onClick={savePol} className="rounded bg-mint px-3 py-1 text-white">บันทึกกติกา</button> <button className="rounded border px-3 py-1" onClick={async () => { const { error } = await supabase.rpc('send_compliance_reminders'); setMsg(error ? error.message : 'ส่งแจ้งเตือนแล้ว') }}>ส่งแจ้งเตือนคนค้างส่งตอนนี้</button></div>}
      <section className="space-y-3 rounded bg-white p-4 text-sm">
        <h2 className="font-medium">ผู้ใช้งาน</h2>
        {users.map(user => {
          const draft = drafts[user.id]
          if (!draft) return null
          return <div key={user.id} className="space-y-2 border-t pt-3">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <label>ชื่อ-นามสกุล<input className="mt-1 w-full rounded border p-2" value={draft.full_name} onChange={e => editUser(user.id, { full_name: e.target.value })} /></label>
              <label>ชื่อที่แสดง<input className="mt-1 w-full rounded border p-2" value={draft.display_name ?? ''} onChange={e => editUser(user.id, { display_name: e.target.value })} /></label>
              <label>เบอร์โทรศัพท์<input className="mt-1 w-full rounded border p-2" inputMode="numeric" maxLength={10} value={draft.phone} onChange={e => editUser(user.id, { phone: e.target.value })} /></label>
              <label>บทบาท<select className="mt-1 w-full rounded border p-2" value={draft.role} onChange={e => editUser(user.id, { role: e.target.value as Role })}>{(Object.keys(ROLE_TH) as Role[]).map(role => <option key={role} value={role}>{ROLE_TH[role]}</option>)}</select></label>
              <label>รหัสพนักงาน<input className="mt-1 w-full rounded border p-2" value={draft.employee_code ?? ''} onChange={e => editUser(user.id, { employee_code: e.target.value })} /></label>
              <label>แผนก<input className="mt-1 w-full rounded border p-2" value={draft.department ?? ''} onChange={e => editUser(user.id, { department: e.target.value })} /></label>
              <label>สถานะอนุมัติ<select className="mt-1 w-full rounded border p-2" value={draft.approval_status} onChange={e => editUser(user.id, { approval_status: e.target.value as Prof['approval_status'] })}><option value="pending">รออนุมัติ</option><option value="approved">อนุมัติแล้ว</option><option value="rejected">ปฏิเสธ</option></select></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={draft.is_active} onChange={e => editUser(user.id, { is_active: e.target.checked })} />เปิดใช้งาน</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={draft.exempt_from_submission} onChange={e => editUser(user.id, { exempt_from_submission: e.target.checked })} />ยกเว้นกติกาส่งงาน</label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded bg-mint px-3 py-1 text-white" onClick={() => saveUser(user.id)}>บันทึกข้อมูลผู้ใช้</button>
              {user.phone && <button className="rounded border px-3 py-1" onClick={() => resetPin(user)}>รีเซ็ต PIN</button>}
              {generatedPins[user.id] && <p className="rounded bg-amber-50 p-2" role="status">PIN ใหม่ (แสดงครั้งเดียว): <strong>{generatedPins[user.id]}</strong></p>}
            </div>
          </div>
        })}
      </section>
      <AdminForceStatus />
      <AdminDataEditor />
      <div className="rounded bg-white p-4 text-sm"><h2 className="mb-2 font-medium">Audit Log ล่าสุด</h2>{aud.length === 0 ? <p className="text-slate-500">ยังไม่มีบันทึก</p> : aud.map(a => <p key={a.id} className="break-all">{new Date(a.created_at).toLocaleString('th-TH')} · {a.action} · {JSON.stringify(a.detail)}</p>)}</div>
    </div>)
}

function CalendarView({ open }: { open: (id: string) => void }) {
  const [ev, setEv] = useState<{ date: string; kind: string; idea_id: string; label: string }[]>([])
  useEffect(() => {
    supabase.from('projects').select('due_date,publish_at,idea_id,content_ideas(code,title)').then(r => {
      const out: typeof ev = []
      for (const p of (r.data ?? []) as unknown as { due_date: string | null; publish_at: string | null; idea_id: string; content_ideas: { code: string; title: string } | null }[]) {
        const label = `${p.content_ideas?.code ?? ''} ${p.content_ideas?.title ?? ''}`
        if (p.due_date) out.push({ date: p.due_date, kind: 'กำหนดส่งงาน', idea_id: p.idea_id, label })
        if (p.publish_at) out.push({ date: new Date(p.publish_at).toLocaleDateString('sv-SE'), kind: 'เผยแพร่', idea_id: p.idea_id, label })
      }
      setEv(out.sort((a, b) => a.date.localeCompare(b.date)))
    })
  }, [])
  const today = new Date().toLocaleDateString('sv-SE')
  return (
    <div className="mx-auto max-w-2xl space-y-2 p-4"><h1 className="text-lg font-semibold">ปฏิทินกำหนดส่งและเผยแพร่</h1>
      {ev.length === 0 ? <p className="rounded bg-white p-4 text-slate-500">ยังไม่มีกำหนดการ ผู้จัดการตั้งกำหนดส่งและวันเผยแพร่ได้ในส่วนการผลิตสื่อของแต่ละงาน</p> :
        ev.map((e, i) => <button key={i} onClick={() => open(e.idea_id)} className={`block w-full rounded bg-white p-3 text-left ${e.date < today ? 'text-slate-400' : ''}`}><b>{new Date(e.date + 'T00:00:00').toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })}</b> · {e.kind}<div>{e.label}</div></button>)}</div>)
}

function Assign({ idea, canEdit, onChange }: { idea: Idea; canEdit: boolean; onChange: () => void }) {
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]); const [err, setErr] = useState('')
  useEffect(() => { supabase.from('profile_names').select('id,name').order('name').then(r => setPeople((r.data as typeof people) ?? [])) }, [])
  const cur = people.find(p => p.id === idea.assignee_id)
  if (!canEdit) return cur ? <p className="text-sm">ผู้รับผิดชอบ: {cur.name}</p> : null
  return (
    <label className="block text-sm">ผู้รับผิดชอบ
      <select className="ml-2 rounded border p-1" value={idea.assignee_id ?? ''} onChange={async e => { const { error } = await supabase.from('content_ideas').update({ assignee_id: e.target.value || null }).eq('id', idea.id); if (error) setErr(error.message); else onChange() }}>
        <option value="">ยังไม่มอบหมาย</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>{err && <span className="ml-2 text-red-600" role="alert">{err}</span>}</label>)
}

interface Att { id: number; path: string; file_name: string }
const OK_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
function Attachments({ idea, me }: { idea: Idea; me: Profile }) {
  const [list, setList] = useState<Att[]>([]); const [err, setErr] = useState('')
  const load = useCallback(() => { supabase.from('idea_attachments').select('id,path,file_name').eq('idea_id', idea.id).order('id').then(r => setList((r.data as Att[]) ?? [])) }, [idea.id])
  useEffect(() => { load() }, [load])
  const can = idea.owner_id === me.id || ['content_manager', 'admin'].includes(me.role)
  async function up(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setErr('')
    if (!OK_MIME.includes(f.type)) return setErr('รองรับเฉพาะ PNG, JPG, WEBP และ PDF'); if (f.size > 10 * 1024 * 1024) return setErr('ไฟล์ต้องไม่เกิน 10 MB')
    const path = `${idea.id}/${crypto.randomUUID()}-${f.name.replace(/[^\w.-]/g, '_')}`
    const u = await supabase.storage.from('idea-files').upload(path, f, { contentType: f.type }); if (u.error) return setErr('อัปโหลดไม่สำเร็จ: ' + u.error.message)
    const { error } = await supabase.from('idea_attachments').insert({ idea_id: idea.id, path, file_name: f.name, mime: f.type, size_bytes: f.size }); if (error) setErr(error.message); else load()
  }
  async function view(a: Att) { const r = await supabase.storage.from('idea-files').createSignedUrl(a.path, 60); if (r.data) window.open(r.data.signedUrl, '_blank', 'noopener,noreferrer') }
  async function del(a: Att) {
    if (!window.confirm(`ยืนยันลบไฟล์ ${a.file_name} หรือไม่`)) return
    const storage = await supabase.storage.from('idea-files').remove([a.path])
    if (storage.error) { setErr('ลบไฟล์จาก Storage ไม่สำเร็จ: ' + storage.error.message); return }
    const { error } = await supabase.from('idea_attachments').delete().eq('id', a.id)
    if (error) setErr('ลบข้อมูลไฟล์แนบไม่สำเร็จ: ' + error.message)
    else load()
  }
  return (
    <div className="space-y-1 border-t pt-3 text-sm"><h3 className="font-medium">ไฟล์แนบ</h3>{list.length === 0 && <p className="text-slate-500">ยังไม่มีไฟล์แนบ</p>}
      {list.map(a => <p key={a.id}><button className="text-navy underline" onClick={() => view(a)}>{a.file_name}</button>{can && <button className="ml-2 text-red-600" onClick={() => del(a)} aria-label="ลบไฟล์">ลบ</button>}</p>)}
      {can && <input type="file" accept=".png,.jpg,.jpeg,.webp,.pdf" onChange={up} />}{err && <p className="text-red-600" role="alert">{err}</p>}</div>)
}

function PlatformSummary() {
  const [m, setM] = useState<Record<string, number>>({})
  useEffect(() => { supabase.from('published_contents').select('platform').then(r => { const o: Record<string, number> = {}; for (const x of (r.data ?? []) as { platform: string }[]) o[x.platform] = (o[x.platform] ?? 0) + 1; setM(o) }) }, [])
  const e = Object.entries(m); if (e.length === 0) return null
  return <div className="rounded bg-white p-4 text-sm"><h2 className="mb-2 font-medium">ผลงานที่เผยแพร่แยกตามแพลตฟอร์ม</h2><div className="flex flex-wrap gap-2">{e.map(([k, v]) => <span key={k} className="rounded bg-slate-100 px-3 py-1">{k}: <b>{v}</b></span>)}</div></div>
}

function Compare({ pubs }: { pubs: { id: string; title: string; platform: string }[] }) {
  const [a, setA] = useState(''); const [b, setB] = useState(''); const [rows, setRows] = useState<Record<string, Met | null>>({})
  useEffect(() => { for (const id of [a, b]) if (id) supabase.from('content_metrics').select('*').eq('published_id', id).order('recorded_on', { ascending: false }).limit(1).then(r => setRows(o => ({ ...o, [id]: (r.data?.[0] as Met) ?? null }))) }, [a, b])
  const pa = pubs.find(x => x.id === a); const pb = pubs.find(x => x.id === b); const ma = rows[a]; const mb = rows[b]
  return (
    <div className="space-y-2 rounded bg-white p-4 text-sm"><h2 className="font-medium">เปรียบเทียบผลงาน</h2>
      <div className="flex flex-wrap gap-2">{[[a, setA], [b, setB]].map(([v, f], i) => <select key={i} className="rounded border p-2" value={v as string} onChange={e => (f as (x: string) => void)(e.target.value)}><option value="">เลือกผลงาน</option>{pubs.map(x => <option key={x.id} value={x.id}>{x.title} ({x.platform})</option>)}</select>)}</div>
      {pa && pb && (pa.platform !== pb.platform ? <p className="text-amber-700">ต่างแพลตฟอร์มกัน ({pa.platform} / {pb.platform}) ตัวเลขไม่ควรนำมาเทียบกัน</p> : !ma || !mb ? <p className="text-slate-500">ยังไม่มีข้อมูลสถิติของบางชิ้น</p> :
        <table className="w-full text-left"><thead><tr><th></th><th>{pa.title}</th><th>{pb.title}</th></tr></thead><tbody>
          <tr><td>วันที่บันทึกล่าสุด</td><td>{ma.recorded_on}</td><td>{mb.recorded_on}</td></tr>
          {MKEYS.map(([k, l]) => <tr key={k} className="border-t"><td>{l}</td><td>{num(ma[k])}</td><td>{num(mb[k])}</td></tr>)}<tr className="border-t"><td>ER</td><td>{er(ma)}</td><td>{er(mb)}</td></tr></tbody></table>)}
    </div>)
}

type WorkspaceTab = 'dash' | 'ideas' | 'kanban' | 'notif' | 'portfolio' | 'analytics' | 'calendar' | 'admin' | 'profile'
function Workspace({ me }: { me: Profile }) {
  const [ideas, setIdeas] = useState<Idea[]>([]); const [rules, setRules] = useState<Transition[]>([]); const [notifs, setNotifs] = useState<Notif[]>([])
  const [sel, setSel] = useState<string | null>(null); const [adding, setAdding] = useState(false)
  const [q, setQ] = useState(''); const [fs, setFs] = useState(''); const [loading, setLoading] = useState(true); const [err, setErr] = useState('')
  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([supabase.from('content_ideas').select('*').order('created_at', { ascending: false }), supabase.from('workflow_transitions').select('*'), supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(50)])
    if (a.error) setErr('โหลดข้อมูลไม่สำเร็จ: ' + a.error.message); else setIdeas(a.data as Idea[])
    setRules((b.data as Transition[]) ?? []); setNotifs((c.data as Notif[]) ?? []); setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])
  const shown = ideas.filter(i => (!fs || i.status === fs) && (i.title + i.code).toLowerCase().includes(q.toLowerCase()))
  const cur = ideas.find(i => i.id === sel)
  const [tab, setTab] = useState<WorkspaceTab>('dash')
  const unread = notifs.filter(n => !n.is_read).length
  const menus: [WorkspaceTab, string][] = [['dash', 'Dashboard'], ['ideas', 'ไอเดีย']]
  if (['reviewer', 'content_manager', 'admin'].includes(me.role)) menus.push(['kanban', 'Kanban'], ['calendar', 'ปฏิทิน'])
  menus.push(['portfolio', 'My Portfolio'])
  if (['content_manager', 'admin'].includes(me.role)) menus.push(['analytics', 'Analytics'])
  menus.push(['notif', 'แจ้งเตือน' + (unread ? ` (${unread})` : '')], ['profile', 'โปรไฟล์ของฉัน'])
  if (me.role === 'admin') menus.push(['admin', 'การจัดการระบบ'])
  const open = (id: string) => { setSel(id); setAdding(false); setTab('ideas') }
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-y-2 bg-navy px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <img src="/ssc-logo-192.png" alt="SSC Creator" className="h-10 w-10 rounded bg-white object-contain" />
          <b>SSC Creator</b>
        </div><span className="flex min-w-0 flex-wrap items-center justify-end text-right text-xs sm:text-sm">{me.display_name || me.full_name || 'ผู้ใช้'} · {ROLE_TH[me.role]} <button className="ml-3 underline" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button></span>
      </header>
      <nav className="flex gap-1 overflow-x-auto bg-white px-4 shadow-sm">{menus.map(([k, label]) => <button key={k} onClick={() => setTab(k)} className={`whitespace-nowrap px-3 py-2 text-sm ${tab === k ? 'border-b-2 border-mint font-medium' : 'text-slate-500'}`}>{label}</button>)}</nav>
      {tab === 'dash' && <Dashboard ideas={ideas} me={me} open={open} />}
      {tab === 'notif' && <NotifCenter list={notifs} open={open} reload={load} />}
      {tab === 'portfolio' && <Portfolio me={me} ideas={ideas} open={open} />}
      {tab === 'analytics' && ['content_manager', 'admin'].includes(me.role) && <Analytics />}
      {tab === 'calendar' && ['reviewer', 'content_manager', 'admin'].includes(me.role) && <CalendarView open={open} />}
      {tab === 'admin' && me.role === 'admin' && <Admin />}
      {tab === 'profile' && <ProfilePage me={me} onSaved={() => window.location.reload()} />}
      {tab === 'kanban' && ['reviewer', 'content_manager', 'admin'].includes(me.role) && <Kanban ideas={ideas} open={open} onChange={load} />}
      {tab === 'ideas' && <main className="mx-auto grid max-w-6xl gap-4 p-4 md:grid-cols-2">
        <section className="space-y-2">
          <div className="flex gap-2">
            <input className="min-w-0 flex-1 rounded border p-2" placeholder="ค้นหาชื่อหัวข้อหรือรหัส" value={q} onChange={e => setQ(e.target.value)} />
            <select className="rounded border p-2" value={fs} onChange={e => setFs(e.target.value)}><option value="">ทุกสถานะ</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.th}</option>)}</select>
            <button className="rounded bg-mint px-3 font-medium text-white" onClick={() => setAdding(true)}>เสนอไอเดีย</button>
          </div>
          {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
          {loading ? <p className="text-slate-500">กำลังโหลด…</p> : shown.length === 0 ? <p className="rounded bg-white p-4 text-slate-500">ยังไม่มีไอเดีย กด “เสนอไอเดีย” เพื่อเริ่มต้น</p> :
            shown.map(i => <button key={i.id} onClick={() => { setSel(i.id); setAdding(false) }} className={`block w-full rounded bg-white p-3 text-left ${sel === i.id ? 'ring-2 ring-mint' : ''}`}>
              <span className="text-xs text-slate-500">{i.code}</span> <Badge s={i.status} /><div className="font-medium">{i.title}</div></button>)}
        </section>
        <section>{adding ? <NewIdea onDone={() => { setAdding(false); load() }} /> : cur ? <Detail idea={cur} me={me} rules={rules} onChange={load} /> : <p className="rounded bg-white p-4 text-slate-500">เลือกไอเดียเพื่อดูรายละเอียดและความคืบหน้า</p>}</section>
      </main>}
    </div>)
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null); const [me, setMe] = useState<Profile | null>(null); const [ready, setReady] = useState(false)
  const [profileError, setProfileError] = useState('')
  useEffect(() => {
    if (!configured) { setReady(true); return }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s)); return () => data.subscription.unsubscribe()
  }, [])
  useEffect(() => {
    if (!session) { setMe(null); setProfileError(''); return }
    setMe(null)
    void (async () => {
      try {
        const r = await supabase.from('profiles').select('id,full_name,display_name,role,approval_status,employee_code').eq('id', session.user.id).single()
        if (r.error) setProfileError('โหลดโปรไฟล์ไม่สำเร็จ: ' + r.error.message)
        else { setMe(r.data as Profile); setProfileError('') }
      } catch (error) {
        setProfileError('โหลดโปรไฟล์ไม่สำเร็จ: ' + (error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'))
      }
    })()
  }, [session])
  if (!configured) return <div className="p-8"><h1 className="text-xl font-semibold">ยังไม่ได้ตั้งค่า Supabase</h1><p>คัดลอก .env.example เป็น .env แล้วใส่ URL และ anon key (ดู README)</p></div>
  if (!ready) return <p className="p-8">กำลังโหลด…</p>
  if (!session) return <Login />
  if (profileError) return <main className="p-8"><p className="text-red-600" role="alert">{profileError}</p><button className="mt-3 underline" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button></main>
  if (!me) return <p className="p-8">กำลังโหลดโปรไฟล์… หากค้างอยู่ ให้ตรวจว่ารัน migration แล้ว</p>
  if (me.approval_status !== 'approved') return <ApprovalNotice status={me.approval_status} />
  return <Workspace me={me} />
}
