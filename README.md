# SSC Creator (เฟส 1: แกนหลัก)

## ติดตั้ง
1. สร้างโปรเจกต์ที่ supabase.com แล้วเปิด SQL Editor
2. ใน Supabase > Authentication > Providers > Email ปิด **Allow new users to sign up** (พนักงานสมัครผ่าน Edge Function ฝั่งเซิร์ฟเวอร์) จากนั้นตั้งรหัสผ่านขั้นต่ำ 6 ตัวอักษรและเปิด CAPTCHA ใน Authentication settings; ผู้ดูแลเลือก **Auto Confirm User** ตอนสร้างบัญชี จึงไม่ต้องพึ่งการยืนยันอีเมล
3. สร้าง Cloudflare Turnstile widget แล้วเปิด CAPTCHA ใน Supabase Auth ตั้งค่า Turnstile Site key และ Secret key; frontend รับเฉพาะ Site key และ Edge Function ตรวจ token ซ้ำ
4. รัน `supabase/migrations/0001_core.sql` ถึง `0005_reminders_files_masters.sql` แล้วรัน `supabase/migrations/0006_pin_auth_access.sql` ตามลำดับใน SQL Editor
5. ใน Supabase Dashboard > Authentication > Users > Add user สร้างบัญชีผู้ดูแลคนแรกด้วยอีเมลจริง รหัสผ่าน และเลือก Auto Confirm User หลัง migration บัญชีอีเมลที่ไม่ลงท้ายด้วย PIN domain จะเป็นผู้ดูแลระบบที่อนุมัติแล้วโดยอัตโนมัติ (ดูตัวอย่าง SQL ใน `supabase/admin/make_admin.sql`)
6. ติดตั้ง Supabase CLI หากยังไม่มี แล้วตั้งค่าโปรเจกต์:
   ```powershell
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   ```
7. ตั้งค่า Edge Function secrets โดยแทนค่าตัวอย่างด้วยข้อมูลจริง (ห้ามใส่ service role key ใน `.env` หรือ VITE variable):
   ```powershell
   npx supabase secrets set ALLOWED_ORIGINS=https://your-app.example.com TURNSTILE_SECRET_KEY=replace-with-turnstile-secret
   npx supabase functions deploy pin-login --no-verify-jwt
   npx supabase functions deploy pin-register --no-verify-jwt
   ```
   `ALLOWED_ORIGINS` รับ origin ที่อนุญาตหลายค่า คั่นด้วย comma เช่น `https://app.example.com,http://localhost:5173`
8. คัดลอก `.env.example` เป็น `.env` แล้วใส่เฉพาะ Project URL, anon key และ `VITE_TURNSTILE_SITE_KEY` (public) ห้ามใส่ service role key ใน frontend หรือในตัวแปรชื่อ `VITE_`
9. เปลี่ยนรหัสเข้าร่วมเริ่มต้น `<CHANGE_ME>` ในหน้าการจัดการระบบก่อนเปิดรับคำขอ แล้วรัน `npm install` และ `npm run dev`

### การสมัครและอนุมัติบัญชี
- พนักงานสมัครด้วยชื่อ เบอร์โทรศัพท์ PIN 6-8 หลัก และรหัสเข้าร่วม ผ่าน `pin-register`; PIN ต้องไม่เป็นเลขซ้ำหรือลำดับตรง บัญชี Auth จะใช้อีเมลสุ่มรูปแบบ `<uuid>@ssc.internal` (แก้ได้ที่ `app_settings.pin_domain`) โดยไม่เปิดเผยให้ผู้ใช้กรอก บัญชีเริ่มต้นเป็นพนักงานและรออนุมัติ
- พนักงานเข้าสู่ระบบด้วย PIN ผ่าน `pin-login` โดยไม่กรอกเบอร์/ชื่อ/อีเมล ส่วนผู้ดูแลใช้แท็บ “อีเมล” และอีเมลจริงกับรหัสผ่าน
- ระบบล็อกอิน PIN จำกัดความล้มเหลว 8 ครั้งต่อ IP ใน 10 นาที และ 60 ครั้งรวมทุก IP ใน 10 นาที เมื่อเกินกำหนดจะตอบ 429 และแสดงข้อความให้รอสักครู่
- ผู้ดูแลอนุมัติ/ปฏิเสธคำขอ เปลี่ยนบทบาท และรีเซ็ต PIN ในหน้าการจัดการระบบ PIN ใหม่ที่สร้างโดยผู้ดูแลจะแสดงให้จดไว้ทันทีเพียงครั้งเดียว ผู้ใช้เปลี่ยน PIN ของตนได้ในหน้าโปรไฟล์
- เบอร์โทรศัพท์จัดเก็บใน `profile_private` แยกจากโปรไฟล์ ผู้ใช้เห็นเบอร์ของตนเองและผู้ดูแลเห็นเบอร์เพื่อดูแลบัญชีเท่านั้น เบอร์ของพนักงานไม่เปิดให้ผู้ใช้คนอื่นอ่าน ตามหลักการคุ้มครองข้อมูลส่วนบุคคล (PDPA)

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
- รูปปกผลงาน, วิดีโอไฟล์ใหญ่ (เกิน 10 MB ให้ใช้ลิงก์แทน)
- ปฏิทินแบบตารางเดือน, ลากวางบนมือถือ
- เชื่อม API แพลตฟอร์มเพื่อดึงสถิติ, อีเมล/Push
- การทดสอบอัตโนมัติ (ยังไม่มี test suite)
- ยังไม่ได้ทดสอบ migration, Edge Functions, CAPTCHA, rate limit, การสมัคร/ล็อกอิน PIN และอีเมล, magic link, RLS/PDPA, การอนุมัติ/ปฏิเสธ, การเปลี่ยน/รีเซ็ต PIN หรือ CRUD กับ Supabase project จริง ต้อง deploy และทดสอบใน project แยกก่อนใช้งานจริง
