export const STATUS: Record<string, { th: string; color: string }> = {
  draft: { th: 'ฉบับร่าง', color: 'bg-slate-200 text-slate-700' },
  pending_review: { th: 'รอตรวจสอบ', color: 'bg-amber-100 text-amber-800' },
  revision_required: { th: 'รอแก้ไข', color: 'bg-orange-100 text-orange-800' },
  reviewed: { th: 'ตรวจสอบแล้ว', color: 'bg-sky-100 text-sky-800' },
  pending_approval: { th: 'รออนุมัติ', color: 'bg-violet-100 text-violet-800' },
  approved_for_script: { th: 'อนุมัติทำบท', color: 'bg-emerald-100 text-emerald-800' },
  script_in_progress: { th: 'กำลังทำบท', color: 'bg-teal-100 text-teal-800' },
  script_review: { th: 'รอตรวจบท', color: 'bg-indigo-100 text-indigo-800' },
  production: { th: 'กำลังผลิตสื่อ', color: 'bg-blue-100 text-blue-800' },
  content_review: { th: 'รอตรวจสื่อ', color: 'bg-fuchsia-100 text-fuchsia-800' },
  ready_to_publish: { th: 'พร้อมออนไลน์', color: 'bg-lime-100 text-lime-800' },
  published: { th: 'ออนไลน์แล้ว', color: 'bg-green-200 text-green-900' },
  completed: { th: 'เสร็จสิ้น', color: 'bg-green-700 text-white' },
  rejected: { th: 'ไม่อนุมัติ', color: 'bg-red-100 text-red-800' },
  cancelled: { th: 'ยกเลิก', color: 'bg-red-100 text-red-800' },
}
export type Role = 'employee' | 'reviewer' | 'content_manager' | 'admin'
export const ROLE_TH: Record<Role, string> = { employee: 'พนักงาน', reviewer: 'ผู้ตรวจสอบ', content_manager: 'ผู้จัดการคอนเทนต์', admin: 'ผู้ดูแลระบบ' }
// UI hint only. The database function transition_idea() is the real authority.
export interface Transition { from_status: string; to_status: string; allowed_roles: string[]; owner_only: boolean }
