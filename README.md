# SSC Creator (เฟส 1: แกนหลัก)

## ติดตั้ง
1. สร้างโปรเจกต์ที่ supabase.com แล้วเปิด SQL Editor
2. ใน Supabase > Authentication > Providers > Email ให้เปิด Sign-ups, ปิด Confirm email และตั้ง Minimum password length เป็น 6
3. เปิด CAPTCHA ใน Supabase Auth โดยเลือก Cloudflare Turnstile ตั้งค่า Site key และ Secret key ที่ Cloudflare/Supabase แล้วใส่ Site key ใน `VITE_TURNSTILE_SITE_KEY` ใน `.env` (ห้ามใส่ CAPTCHA secret หรือ service_role key ใน frontend)
4. รันไฟล์ `supabase/migrations/0001_core.sql` ถึง `supabase/migrations/0006_signup_approval.sql` ตามลำดับใน SQL Editor
5. คัดลอก `.env.example` เป็น `.env` แล้วใส่ Project URL และ anon key (Settings > API) กำหนด `VITE_LOGIN_DOMAIN` ให้ตรงกับ domain สำหรับบัญชีพนักงาน (ค่าเริ่มต้น `ssc.internal`) และตั้งค่า `VITE_TURNSTILE_SITE_KEY`
6. ใน Supabase Dashboard > Authentication > Users > Add user สร้างบัญชีผู้ดูแลด้วยอีเมลจริง รหัสผ่าน และเปิด Auto Confirm User จากนั้นแก้และรันคำสั่งใน `supabase/admin/make_admin.sql` เพื่อกำหนด role เป็น admin
7. เปลี่ยนค่าเริ่มต้น `<CHANGE_ME>` ของรหัสเข้าร่วมในหน้าผู้ดูแลระบบก่อนเปิดให้พนักงานสมัคร
8. รัน `npm install` แล้ว `npm run dev`

### การสมัครและอนุมัติบัญชี
- พนักงานสมัครด้วยชื่อ เบอร์โทรศัพท์ PIN 6-8 หลัก และรหัสเข้าร่วม จากนั้นบัญชีจะรอผู้ดูแลอนุมัติ ผู้ดูแลกำหนดบทบาทหรือปฏิเสธได้ในหน้า Administration
- พนักงานเข้าสู่ระบบด้วยเบอร์โทรศัพท์และ PIN ผู้ดูแลเข้าสู่ระบบด้วยอีเมลจริงและรหัสผ่านที่สร้างใน Supabase
- เบอร์โทรศัพท์จัดเก็บแยกใน `profile_private` และอ่านได้เฉพาะเจ้าของบัญชีกับผู้ดูแลระบบ ผู้ใช้อื่นไม่เห็นเบอร์โทรศัพท์ตามหลักการคุ้มครองข้อมูลส่วนบุคคล (PDPA)
- หากลืม PIN ให้ผู้ดูแลใช้คำสั่งตัวอย่างใน `supabase/admin/reset_pin.sql` จาก SQL Editor และส่ง PIN ใหม่ให้เจ้าของบัญชีผ่านช่องทางที่ปลอดภัย

## ใช้งานบนมือถือ
- ติดตั้งเว็บเป็นแอปได้บน Android และ iOS เมื่อเปิดผ่าน HTTPS
- Android: เปิด URL ด้วย Chrome แล้วเลือก “ติดตั้งแอป” หรือ “เพิ่มลงในหน้าจอหลัก” จากเมนูเบราว์เซอร์
- iPhone/iPad: เปิด URL ด้วย Safari กดแชร์ แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”
- แอปแคชหน้าเริ่มต้นและไฟล์ UI เพื่อเปิดแบบออฟไลน์ได้ แต่การเข้าสู่ระบบและข้อมูลจาก Supabase ต้องใช้อินเทอร์เน็ต

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
- ยังไม่ได้ทดสอบการสมัคร/ล็อกอิน, การตรวจรหัสเข้าร่วม, การอนุมัติ/ปฏิเสธ, RLS ของเบอร์โทรศัพท์, CAPTCHA หรือการรีเซ็ต PIN กับ Supabase project จริง ต้องตั้งค่าและทดสอบรายการเหล่านี้ใน project ของผู้ใช้ก่อนเปิดใช้งาน
