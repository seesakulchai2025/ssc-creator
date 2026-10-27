-- Production workspace, script versions, mandatory pre-publish checklist, comment notifications
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null unique references content_ideas(id) on delete cascade,
  script text, shot_list text, caption text, hashtags text, cta text, notes text,
  due_date date, publish_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table public.script_versions (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects(id) on delete cascade,
  version int not null, body text not null,
  created_by uuid references profiles(id) default auth.uid(), created_at timestamptz not null default now(),
  unique (project_id, version));

create table public.checklist_items (
  id bigint generated always as identity primary key,
  idea_id uuid not null references content_ideas(id) on delete cascade,
  label text not null, is_required boolean not null default true,
  is_done boolean not null default false, done_by uuid references profiles(id), done_at timestamptz);
create index on checklist_items(idea_id);

create function public.create_project_for(p_idea uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  insert into projects(idea_id) values (p_idea) on conflict (idea_id) do nothing;
  if not exists (select 1 from checklist_items where idea_id = p_idea) then
    insert into checklist_items(idea_id,label) values
      (p_idea,'ตรวจสอบข้อมูลสินค้าแล้ว'),(p_idea,'ตรวจสอบราคาและโปรโมชันแล้ว'),(p_idea,'ตรวจสอบข้อความและการสะกดแล้ว'),
      (p_idea,'ตรวจสอบโลโก้และองค์ประกอบแบรนด์แล้ว'),(p_idea,'ตรวจสอบความถูกต้องของสื่อแล้ว'),(p_idea,'ได้รับอนุมัติขั้นสุดท้ายแล้ว');
  end if;
end $$;

create function public.on_idea_stage() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('approved_for_script','script_in_progress','script_review','production','content_review','ready_to_publish','published','completed') then
    perform create_project_for(new.id);
  end if;
  return new;
end $$;
create trigger idea_stage after insert or update of status on content_ideas for each row execute function on_idea_stage();

-- Required checklist items must be done before Ready to Publish
create function public.gate_ready() returns trigger language plpgsql as $$
begin
  if new.status = 'ready_to_publish' and old.status is distinct from new.status
     and exists (select 1 from checklist_items where idea_id = new.id and is_required and not is_done) then
    raise exception 'ยังตรวจสอบ Checklist ก่อนเผยแพร่ไม่ครบ';
  end if;
  return new;
end $$;
create trigger idea_gate before update of status on content_ideas for each row execute function gate_ready();

create function public.stamp_checklist() returns trigger language plpgsql as $$
begin
  if new.is_done and not old.is_done then new.done_by = auth.uid(); new.done_at = now();
  elsif not new.is_done then new.done_by = null; new.done_at = null; end if;
  return new;
end $$;
create trigger checklist_stamp before update on checklist_items for each row execute function stamp_checklist();

create function public.notify_comment() returns trigger language plpgsql security definer set search_path=public as $$
declare o uuid; c text;
begin
  select owner_id, code into o, c from content_ideas where id = new.idea_id;
  if o is not null and o <> new.author_id then
    insert into notifications(user_id,idea_id,message) values (o,new.idea_id,c||': มีความคิดเห็นใหม่');
  end if;
  return new;
end $$;
create trigger comment_notify after insert on comments for each row execute function notify_comment();

-- backfill ideas already past the approval step
select create_project_for(id) from content_ideas
 where status in ('approved_for_script','script_in_progress','script_review','production','content_review','ready_to_publish','published','completed');

alter table projects enable row level security; alter table script_versions enable row level security; alter table checklist_items enable row level security;
create policy projects_read on projects for select to authenticated using (exists (select 1 from content_ideas c where c.id = idea_id));
create policy projects_write on projects for update to authenticated using (current_role_name() in ('content_manager','admin'));
create policy versions_read on script_versions for select to authenticated using (exists (select 1 from projects p where p.id = project_id));
create policy versions_insert on script_versions for insert to authenticated with check (current_role_name() in ('content_manager','admin') and created_by = auth.uid());
create policy checklist_read on checklist_items for select to authenticated using (exists (select 1 from content_ideas c where c.id = idea_id));
create policy checklist_write on checklist_items for update to authenticated using (current_role_name() in ('content_manager','admin'));
