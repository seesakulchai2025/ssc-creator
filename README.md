# SSC Creator (เฟส 1: แกนหลัก)

## ติดตั้ง
1. สร้างโปรเจกต์ที่ supabase.com แล้วเปิด SQL Editor
2. รันไฟล์ `supabase/migrations/0001_core.sql` แล้วตามด้วย `0002_production.sql` `0003_portfolio.sql` `0004_admin_compliance.sql` และ `0005_reminders_files_masters.sql`
3. `cp .env.example .env` แล้วใส่ Project URL และ anon key (Settings > API) **ห้ามใส่ service_role key**
4. `npm install` แล้ว `npm run dev`
5. สมัครบัญชีในหน้า Login จากนั้นเลื่อนสิทธิ์ใน SQL Editor:
   `update profiles set role='admin' where id = (select id from auth.users where email='you@example.com');`

## เสร็จแล้ว
Login (Supabase Auth), 4 บทบาท, ตาราง + RLS, เสนอไอเดีย (ร่าง), รหัส SSC-IDEA-xxxx, Workflow 15 สถานะผ่านฟังก์ชัน `transition_idea` พร้อมประวัติและแจ้งเตือน (บันทึกลงตาราง), ค้นหา/กรอง

## เฟส 2
Dashboard (Employee / Reviewer / Manager+Admin), Kanban (กดการ์ดเพื่อเปิดงาน), ความคิดเห็น, `supabase/seed.sql` (Demo ติดป้าย is_demo, รันหลังตั้งแอดมินแล้ว)

## เฟส 3
Notification Center (+แจ้งเตือนเมื่อมีความคิดเห็น), พื้นที่ผลิต (สคริปต์ มีเวอร์ชัน, Shot List, Caption, Hashtags, CTA, กำหนดส่ง/เผยแพร่), Checklist บังคับก่อน Ready to Publish (บังคับที่ฐานข้อมูล)

## เฟส 4
บันทึกลิงก์ผลงาน (ตรวจรูปแบบ URL, เปิดลิงก์แบบ noopener; “ออนไลน์แล้ว” ต้องมีลิงก์ก่อน), My Portfolio (Grid/List, กรองแพลตฟอร์ม/เดือน, เครดิตผู้ร่วมสร้างพร้อมบทบาท), สถิติกรอกเอง + ER + กราฟยอดเข้าชม ไม่มีสถิติ Demo

## เฟส 5
- **กติกาส่งไอเดียรายสัปดาห์:** ทุกคน (ที่ไม่ถูกยกเว้น) ต้องส่งไอเดียจากฉบับร่างเข้าสู่ “รอตรวจสอบ” อย่างน้อย 1 ครั้งก่อนสิ้นวันจันทร์ (เวลา Asia/Bangkok, นับช่วงอังคาร 00:00 ถึงจันทร์ 24:00) สัปดาห์ที่พลาด +1 ตัวแดง สัปดาห์ที่ส่งครบ -1 (ไม่ต่ำกว่า 0) นับเฉพาะสัปดาห์เต็มหลังวันที่เริ่มกติกา ปรับค่าได้ในหน้า Administration
- หน้า Administration (บทบาท เปิด/ปิดบัญชี ยกเว้นกติกา กติกาส่งงาน Audit Log), มอบหมายผู้รับผิดชอบ + แจ้งเตือน, ปฏิทิน
- ปิดช่องโหว่: ผู้ใช้ทั่วไปแก้บทบาท/สถานะบัญชีของตนเองไม่ได้ (trigger `guard_profile`)

## เฟส 6
- แจ้งเตือนคนค้างส่ง/ใกล้กำหนด: ปุ่ม “ส่งแจ้งเตือนตอนนี้” ในหน้า Administration (ส่งซ้ำในวันเดียวกันไม่ซ้อน) หรือตั้งอัตโนมัติด้วย pg_cron (เปิด Extension pg_cron ใน Supabase ก่อน แล้วรัน):
  `select cron.schedule('ssc-reminders','0 2 * * 1,5',$$select public.send_compliance_reminders()$$);`  (09:00 น. เวลาไทย จันทร์และศุกร์)
- ไฟล์แนบของไอเดีย (Supabase Storage, PNG/JPG/WEBP/PDF ไม่เกิน 10 MB, bucket ส่วนตัว เปิดผ่านลิงก์ชั่วคราว 60 วินาที)
- Kanban ลากวางเปลี่ยนสถานะ, สรุปผลงานตามแพลตฟอร์ม, เปรียบเทียบผลงาน (เฉพาะแพลตฟอร์มเดียวกัน)
- ตาราง departments, content_categories, products, platform_settings (มีข้อมูลตั้งต้นของหมวดและแพลตฟอร์ม)

## ยังไม่ได้ทำ
- ฟอร์มและหน้า Admin สำหรับจัดการ departments / products / categories / platforms (ตารางพร้อม ยังไม่ได้ต่อกับ UI)
- รูปปกผลงาน, วิดีโอไฟล์ใหญ่ (เกิน 10 MB ให้ใช้ลิงก์แทน)
- ปฏิทินแบบตารางเดือน, ลากวางบนมือถือ
- เชื่อม API แพลตฟอร์มเพื่อดึงสถิติ, อีเมล/Push
- การทดสอบอัตโนมัติ (ยังไม่มี test suite)
