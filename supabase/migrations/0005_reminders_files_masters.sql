-- Reminders, attachments (Storage), master data tables
create function public.send_compliance_reminders() returns void language plpgsql security definer set search_path=public as $$
declare adm uuid; r record; m text;
begin
  if not ((auth.uid() is not null and current_role_name() = 'admin') or (auth.uid() is null and session_user in ('postgres','supabase_admin'))) then
    raise exception 'ไม่มีสิทธิ์'; end if;
  select id into adm from profiles where role = 'admin' and is_active order by created_at limit 1;
  if adm is null then return; end if;
  perform set_config('request.jwt.claim.sub', adm::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', adm::text, 'role', 'authenticated')::text, true);
  for r in select * from compliance_report() loop
    if not r.week_ok then
      m := 'เตือน: สัปดาห์นี้ยังไม่ส่งไอเดีย ส่งก่อนสิ้นวันที่ ' || to_char(r.next_deadline, 'DD/MM/YYYY');
      insert into notifications(user_id, message) select r.uid, m where not exists (select 1 from notifications n where n.user_id = r.uid and n.message = m and n.created_at::date = current_date);
    end if;
    if r.red_stack > 0 then
      m := 'คุณมีตัวแดงค้างส่ง ' || r.red_stack || ' สัปดาห์ (ส่งตามกำหนดแต่ละสัปดาห์จะลดทีละ 1)';
      insert into notifications(user_id, message) select r.uid, m where not exists (select 1 from notifications n where n.user_id = r.uid and n.message = m and n.created_at::date = current_date);
    end if;
  end loop;
end $$;
revoke execute on function public.send_compliance_reminders() from public, anon;

create table public.idea_attachments (
  id bigint generated always as identity primary key,
  idea_id uuid not null references content_ideas(id) on delete cascade,
  path text not null unique, file_name text not null, mime text, size_bytes bigint,
  uploaded_by uuid references profiles(id) default auth.uid(), created_at timestamptz not null default now());
alter table idea_attachments enable row level security;
create policy att_read on idea_attachments for select to authenticated using (exists (select 1 from content_ideas c where c.id = idea_id));
create policy att_insert on idea_attachments for insert to authenticated with check (uploaded_by = auth.uid() and exists (select 1 from content_ideas c where c.id = idea_id and (c.owner_id = auth.uid() or current_role_name() in ('content_manager','admin'))));
create policy att_delete on idea_attachments for delete to authenticated using (uploaded_by = auth.uid() or current_role_name() in ('content_manager','admin'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('idea-files', 'idea-files', false, 10485760, array['image/png','image/jpeg','image/webp','application/pdf']) on conflict (id) do nothing;
create policy idea_files_read on storage.objects for select to authenticated using (bucket_id = 'idea-files' and exists (select 1 from content_ideas c where c.id = ((storage.foldername(name))[1])::uuid));
create policy idea_files_insert on storage.objects for insert to authenticated with check (bucket_id = 'idea-files' and exists (select 1 from content_ideas c where c.id = ((storage.foldername(name))[1])::uuid and (c.owner_id = auth.uid() or current_role_name() in ('content_manager','admin'))));
create policy idea_files_delete on storage.objects for delete to authenticated using (bucket_id = 'idea-files' and (owner = auth.uid() or current_role_name() in ('content_manager','admin')));

-- Master data (tables only; not yet wired into forms)
create table public.departments (id int generated always as identity primary key, name text unique not null);
create table public.content_categories (id int generated always as identity primary key, name text unique not null, sort_order int not null default 0);
create table public.products (id int generated always as identity primary key, name text not null, brand text, category text, is_active boolean not null default true);
create table public.platform_settings (platform text primary key, is_active boolean not null default true);
insert into content_categories(name, sort_order) values ('ให้ความรู้เรื่องสีและการใช้งาน',1),('แนะนำสินค้า',2),('สาธิตวิธีใช้งาน',3),('เทคนิคช่างสี',4),('เปรียบเทียบสินค้า',5),('โปรโมชันและกิจกรรม',6),('คอนเทนต์สร้างการมีส่วนร่วม',7),('คอนเทนต์เบื้องหลังร้าน',8),('อื่น ๆ',9);
insert into platform_settings(platform) values ('Facebook'),('TikTok'),('YouTube'),('Instagram'),('LINE'),('เว็บไซต์'),('อื่น ๆ');
do $$ declare t text; begin
  foreach t in array array['departments','content_categories','products','platform_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t||'_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (current_role_name() = ''admin'') with check (current_role_name() = ''admin'')', t||'_admin', t);
  end loop; end $$;
