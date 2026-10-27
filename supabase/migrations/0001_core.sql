-- SSC Creator core schema: profiles, ideas, workflow, comments, notifications
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null default '', display_name text, employee_code text unique,
  department text, avatar_url text,
  role text not null default 'employee' check (role in ('employee','reviewer','content_manager','admin')),
  is_active boolean not null default true, created_at timestamptz not null default now());

create function public.current_role_name() returns text language sql stable security definer set search_path=public as
$$ select role from profiles where id = auth.uid() and is_active $$;

create function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as
$$ begin insert into profiles(id, full_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name','')); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

create sequence public.idea_seq;
create table public.content_ideas (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default ('SSC-IDEA-' || lpad(nextval('idea_seq')::text,4,'0')),
  owner_id uuid not null references profiles(id) default auth.uid(),
  title text not null check (length(title) between 3 and 200),
  description text, objective text, target_audience text,
  content_type text, related_products text, platforms text[] not null default '{}',
  media_format text, outline text, urgency text, notes text,
  status text not null default 'draft' check (status in ('draft','pending_review','revision_required','reviewed','pending_approval','approved_for_script','script_in_progress','script_review','production','content_review','ready_to_publish','published','completed','rejected','cancelled')),
  assignee_id uuid references profiles(id),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index on content_ideas(owner_id); create index on content_ideas(status);

-- Allowed transitions are data, so Admin can change the policy later.
create table public.workflow_transitions (
  from_status text not null, to_status text not null, allowed_roles text[] not null, owner_only boolean not null default false,
  primary key (from_status,to_status));
insert into workflow_transitions values
 ('draft','pending_review','{employee,reviewer,content_manager,admin}',true),
 ('pending_review','revision_required','{reviewer,content_manager,admin}',false),
 ('pending_review','reviewed','{reviewer,content_manager,admin}',false),
 ('revision_required','pending_review','{employee,reviewer,content_manager,admin}',true),
 ('reviewed','pending_approval','{reviewer,content_manager,admin}',false),
 ('pending_approval','approved_for_script','{content_manager,admin}',false),
 ('pending_approval','revision_required','{content_manager,admin}',false),
 ('approved_for_script','script_in_progress','{content_manager,admin}',false),
 ('script_in_progress','script_review','{content_manager,admin}',false),
 ('script_review','production','{content_manager,admin}',false),
 ('script_review','script_in_progress','{content_manager,admin}',false),
 ('production','content_review','{content_manager,admin}',false),
 ('content_review','ready_to_publish','{content_manager,admin}',false),
 ('content_review','production','{content_manager,admin}',false),
 ('ready_to_publish','published','{content_manager,admin}',false),
 ('published','completed','{content_manager,admin}',false);
-- rejected/cancelled: any open status, manager/admin only, note required (see function)

create table public.workflow_history (
  id bigint generated always as identity primary key,
  idea_id uuid not null references content_ideas(id) on delete cascade,
  actor_id uuid not null references profiles(id), from_status text, to_status text not null,
  note text, created_at timestamptz not null default now());
create index on workflow_history(idea_id);

create table public.comments (
  id bigint generated always as identity primary key,
  idea_id uuid not null references content_ideas(id) on delete cascade,
  author_id uuid not null references profiles(id) default auth.uid(),
  body text not null check (length(body) > 0), created_at timestamptz not null default now());

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  idea_id uuid references content_ideas(id) on delete cascade,
  message text not null, is_read boolean not null default false, created_at timestamptz not null default now());

-- Status can only change through transition_idea()
create function public.guard_status() returns trigger language plpgsql as
$$ begin
  if new.status is distinct from old.status and coalesce(current_setting('app.via_transition',true),'') <> '1' then
    raise exception 'สถานะเปลี่ยนได้ผ่านขั้นตอน Workflow เท่านั้น'; end if;
  if new.owner_id is distinct from old.owner_id or new.code is distinct from old.code then
    raise exception 'ไม่สามารถแก้ไขเจ้าของหรือรหัสไอเดียได้'; end if;
  new.updated_at = now(); return new; end $$;
create trigger content_ideas_guard before update on content_ideas for each row execute function guard_status();

create function public.transition_idea(p_idea uuid, p_to text, p_note text default null)
returns void language plpgsql security definer set search_path=public as $$
declare i content_ideas; r text := current_role_name(); t workflow_transitions; ok boolean := false;
begin
  if r is null then raise exception 'ไม่มีสิทธิ์ใช้งาน'; end if;
  select * into i from content_ideas where id = p_idea for update;
  if not found then raise exception 'ไม่พบไอเดีย'; end if;
  if p_to in ('rejected','cancelled') then
    ok := r in ('content_manager','admin') and i.status not in ('completed','rejected','cancelled');
    if ok and coalesce(trim(p_note),'') = '' then raise exception 'ต้องระบุเหตุผล'; end if;
  else
    select * into t from workflow_transitions where from_status = i.status and to_status = p_to;
    ok := found and r = any(t.allowed_roles) and (not t.owner_only or i.owner_id = auth.uid() or r in ('content_manager','admin'));
    if ok and p_to = 'revision_required' and coalesce(trim(p_note),'') = '' then raise exception 'ต้องระบุสิ่งที่ต้องแก้ไข'; end if;
  end if;
  if not ok then raise exception 'ไม่สามารถเปลี่ยนสถานะ % → % ด้วยสิทธิ์ของคุณ', i.status, p_to; end if;
  perform set_config('app.via_transition','1',true);
  update content_ideas set status = p_to where id = p_idea;
  insert into workflow_history(idea_id,actor_id,from_status,to_status,note) values (p_idea,auth.uid(),i.status,p_to,p_note);
  insert into notifications(user_id,idea_id,message) select i.owner_id,p_idea,i.code||': สถานะเปลี่ยนเป็น '||p_to where i.owner_id <> auth.uid();
end $$;

alter table profiles enable row level security; alter table content_ideas enable row level security;
alter table workflow_transitions enable row level security; alter table workflow_history enable row level security;
alter table comments enable row level security; alter table notifications enable row level security;

create policy profiles_read on profiles for select to authenticated using (true);
create policy profiles_self_update on profiles for update to authenticated using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from profiles where id = auth.uid()));
create policy profiles_admin_all on profiles for all to authenticated using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
create policy ideas_read on content_ideas for select to authenticated using (
  owner_id = auth.uid() or (status <> 'draft' and current_role_name() in ('reviewer','content_manager','admin')));
create policy ideas_insert on content_ideas for insert to authenticated with check (owner_id = auth.uid() and status = 'draft');
create policy ideas_owner_edit on content_ideas for update to authenticated
  using (owner_id = auth.uid() and status in ('draft','revision_required')) with check (owner_id = auth.uid());
create policy ideas_manager_edit on content_ideas for update to authenticated using (current_role_name() in ('content_manager','admin'));
create policy transitions_read on workflow_transitions for select to authenticated using (true);
create policy transitions_admin on workflow_transitions for all to authenticated using (current_role_name()='admin') with check (current_role_name()='admin');
create policy history_read on workflow_history for select to authenticated using (exists (select 1 from content_ideas c where c.id = idea_id));
create policy comments_read on comments for select to authenticated using (exists (select 1 from content_ideas c where c.id = idea_id));
create policy comments_insert on comments for insert to authenticated with check (author_id = auth.uid() and exists (select 1 from content_ideas c where c.id = idea_id));
create policy notif_own on notifications for select to authenticated using (user_id = auth.uid());
create policy notif_mark on notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
