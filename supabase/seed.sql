-- Demo data. Owned by the first admin account, so sign up and promote an admin first (see README).
-- Every row has is_demo = true. Remove all of it with:  delete from content_ideas where is_demo;
insert into content_ideas (owner_id, title, description, content_type, platforms, status, is_demo)
select p.id, v.t, v.d, v.c, v.pl, v.s, true
from (select id from profiles where role = 'admin' order by created_at limit 1) p,
(values
 ('สอนเลือกสีรองพื้นเหล็กให้เหมาะกับงาน','เปรียบเทียบรองพื้นกันสนิมแต่ละชนิดและงานที่เหมาะ','ให้ความรู้เรื่องสี',array['Facebook','YouTube'],'draft'),
 ('แนะนำการใช้สีย้อมไม้ภายนอก','ขั้นตอนเตรียมผิวและทาสีย้อมไม้ให้ทนแดด','สาธิตวิธีใช้งาน',array['TikTok'],'pending_review'),
 ('เทคนิคพ่นสีรถยนต์สำหรับมือใหม่','วิดีโอสั้นสาธิตการเตรียมผิวและพ่นสีเคลือบ','เทคนิคช่างสี',array['TikTok','YouTube'],'revision_required'),
 ('เปรียบเทียบสีทาอาคารภายใน-ภายนอก','ตารางเทียบความทนทานและการใช้งาน','เปรียบเทียบสินค้า',array['Facebook'],'pending_approval'),
 ('โปรโมชันอุปกรณ์ช่างสีประจำเดือน','ชุดแปรง ลูกกลิ้ง เทปกาว ราคาพิเศษ','โปรโมชันและกิจกรรม',array['LINE','Facebook'],'script_in_progress'),
 ('วิธีใช้สีทาเหล็กกันสนิม','วิดีโอสั้นขั้นตอนขัดสนิมจนทาสีทับหน้า','สาธิตวิธีใช้งาน',array['TikTok'],'production'),
 ('เบื้องหลังการผสมสีในร้าน','ถ่ายการเข้าสีด้วยเครื่องผสม','คอนเทนต์เบื้องหลังร้าน',array['Instagram'],'ready_to_publish'),
 ('ตอบคำถามช่างสี: ทำไมสีลอก','รวมสาเหตุสีลอกและวิธีป้องกัน','ให้ความรู้เรื่องสีและการใช้งาน',array['Facebook'],'rejected')
) as v(t,d,c,pl,s);

-- Demo idea at "ready_to_publish" must have its checklist complete (the gate normally enforces this)
update checklist_items set is_done = true
 where idea_id in (select id from content_ideas where is_demo and status = 'ready_to_publish');
