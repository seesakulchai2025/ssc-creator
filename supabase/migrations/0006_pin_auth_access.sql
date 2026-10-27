create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'approval_status'
  ) then
    alter table public.profiles add column approval_status text not null default 'pending';
    update public.profiles set approval_status = 'approved';
  end if;
end;
$$;
alter table public.profiles
  drop constraint if exists profiles_approval_status_check;
alter table public.profiles
  add constraint profiles_approval_status_check
  check (approval_status in ('pending', 'approved', 'rejected'));

create table if not exists public.profile_pins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  pin_hash text not null
);
alter table public.profile_pins enable row level security;

create table if not exists public.profile_private (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  phone text unique not null
);
alter table public.profile_private enable row level security;
drop policy if exists profile_private_read on public.profile_private;
create policy profile_private_read on public.profile_private for select to authenticated
  using (user_id = auth.uid() or current_role_name() = 'admin');
drop policy if exists profile_private_update on public.profile_private;
create policy profile_private_update on public.profile_private for update to authenticated
  using (user_id = auth.uid() or current_role_name() = 'admin')
  with check (user_id = auth.uid() or current_role_name() = 'admin');
drop policy if exists profile_private_insert_own on public.profile_private;
create policy profile_private_insert_own on public.profile_private for insert to authenticated
  with check (user_id = auth.uid() or current_role_name() = 'admin');

create table if not exists public.app_settings (
  key text primary key,
  value text not null
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings for all to authenticated
  using (current_role_name() = 'admin')
  with check (current_role_name() = 'admin');
insert into public.app_settings(key, value) values
  ('join_code', '<CHANGE_ME>'),
  ('pin_domain', 'ssc.internal')
on conflict (key) do nothing;

create table if not exists public.pin_attempts (
  ip text not null,
  at timestamptz not null default now(),
  kind text not null
);
create index if not exists pin_attempts_ip_at on public.pin_attempts(ip, at desc);
create index if not exists pin_attempts_at on public.pin_attempts(at desc);
alter table public.pin_attempts enable row level security;

create table if not exists public.pin_change_attempts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now(),
  succeeded boolean not null default false
);
create index if not exists pin_change_attempts_user_at on public.pin_change_attempts(user_id, at desc);
alter table public.pin_change_attempts enable row level security;

create or replace function public.valid_pin(p_pin text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  i int;
  step int;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6,8}$' or p_pin ~ '^([0-9])\1+$' then return false; end if;
  step := ascii(substr(p_pin, 2, 1)) - ascii(substr(p_pin, 1, 1));
  if abs(step) <> 1 then return true; end if;
  for i in 3..length(p_pin) loop
    if ascii(substr(p_pin, i, 1)) - ascii(substr(p_pin, i - 1, 1)) <> step then return true; end if;
  end loop;
  return false;
end;
$$;
revoke all on function public.valid_pin(text) from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin_domain text;
  v_is_pin_user boolean;
begin
  select value into v_pin_domain from public.app_settings where key = 'pin_domain';
  v_is_pin_user := v_pin_domain is not null
    and right(lower(new.email), length(v_pin_domain) + 1) = '@' || lower(v_pin_domain);

  insert into public.profiles(id, full_name, role, approval_status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when v_is_pin_user then 'employee' else 'admin' end,
    case when v_is_pin_user then 'pending' else 'approved' end
  );

  if v_is_pin_user then
    insert into public.notifications(user_id, message)
    select id, 'มีผู้สมัครใหม่รออนุมัติ'
    from public.profiles
    where role = 'admin' and is_active;
  end if;
  return new;
end;
$$;

create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and is_active
    and approval_status = 'approved'
$$;

create or replace function public.guard_profile()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and coalesce(current_role_name(), '') <> 'admin'
     and (new.role is distinct from old.role
          or new.is_active is distinct from old.is_active
          or new.exempt_from_submission is distinct from old.exempt_from_submission
          or new.employee_code is distinct from old.employee_code
          or new.approval_status is distinct from old.approval_status) then
    raise exception 'เฉพาะผู้ดูแลระบบที่แก้ไขสิทธิ์และสถานะบัญชีได้';
  end if;
  return new;
end;
$$;

create or replace function public.audit_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     or new.is_active is distinct from old.is_active
     or new.exempt_from_submission is distinct from old.exempt_from_submission
     or new.employee_code is distinct from old.employee_code
     or new.approval_status is distinct from old.approval_status then
    insert into public.audit_logs(actor_id, action, target, detail)
    values (
      auth.uid(), 'profile_update', new.id::text,
      jsonb_build_object(
        'role', jsonb_build_array(old.role, new.role),
        'is_active', jsonb_build_array(old.is_active, new.is_active),
        'exempt', jsonb_build_array(old.exempt_from_submission, new.exempt_from_submission),
        'employee_code', jsonb_build_array(old.employee_code, new.employee_code),
        'approval_status', jsonb_build_array(old.approval_status, new.approval_status)
      )
    );
  end if;
  return new;
end;
$$;

create or replace function public.find_user_by_pin(p_pin text)
returns table(email text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select u.email
  from public.profile_pins pp
  join public.profiles p on p.id = pp.user_id
  join auth.users u on u.id = pp.user_id
  where p.is_active
    and p.approval_status = 'approved'
    and pp.pin_hash = extensions.crypt(p_pin, pp.pin_hash)
  limit 1
$$;

create or replace function public.pin_taken(p_pin text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.profile_pins pp
    where pp.pin_hash = extensions.crypt(p_pin, pp.pin_hash)
  )
$$;

create or replace function public.set_pin_hash(p_user uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.valid_pin(p_pin) then
    raise exception 'PIN ไม่ผ่านข้อกำหนด';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_pin, 0));
  if exists (
    select 1 from public.profile_pins pp
    where pp.user_id <> p_user
      and pp.pin_hash = extensions.crypt(p_pin, pp.pin_hash)
  ) then
    raise exception 'PIN นี้ใช้ไม่ได้ กรุณาเลือกใหม่';
  end if;
  insert into public.profile_pins(user_id, pin_hash)
  values (p_user, extensions.crypt(p_pin, extensions.gen_salt('bf')))
  on conflict (user_id) do update set pin_hash = excluded.pin_hash;
end;
$$;

revoke all on function public.find_user_by_pin(text) from public, anon, authenticated;
revoke all on function public.pin_taken(text) from public, anon, authenticated;
revoke all on function public.set_pin_hash(uuid, text) from public, anon, authenticated;
grant execute on function public.find_user_by_pin(text) to service_role;
grant execute on function public.pin_taken(text) to service_role;
grant execute on function public.set_pin_hash(uuid, text) to service_role;

create or replace function public.change_my_pin(p_old text, p_new text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_hash text;
begin
  if v_user is null or current_role_name() is null then raise exception 'ไม่มีสิทธิ์'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  if (select count(*) from public.pin_change_attempts
      where user_id = v_user and not succeeded and at > now() - interval '1 hour') >= 5 then
    return 'ลองผิดหลายครั้ง กรุณารอสักครู่';
  end if;
  select pin_hash into v_hash from public.profile_pins where user_id = v_user for update;
  if v_hash is null or extensions.crypt(p_old, v_hash) <> v_hash then
    insert into public.pin_change_attempts(user_id, succeeded) values (v_user, false);
    return 'PIN ปัจจุบันไม่ถูกต้อง';
  end if;
  if not public.valid_pin(p_new) then
    return 'PIN ไม่ผ่านข้อกำหนด';
  end if;
  if public.pin_taken(p_new) then return 'PIN นี้ใช้ไม่ได้ กรุณาเลือกใหม่'; end if;
  perform public.set_pin_hash(v_user, p_new);
  insert into public.pin_change_attempts(user_id, succeeded) values (v_user, true);
  return 'ok';
end;
$$;
revoke all on function public.change_my_pin(text, text) from public, anon;
grant execute on function public.change_my_pin(text, text) to authenticated;

create or replace function public.admin_set_pin(p_user uuid, p_new text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if current_role_name() is distinct from 'admin' then raise exception 'ไม่มีสิทธิ์'; end if;
  if not public.valid_pin(p_new) then
    raise exception 'PIN ไม่ผ่านข้อกำหนด';
  end if;
  if public.pin_taken(p_new) then raise exception 'PIN นี้ใช้ไม่ได้ กรุณาเลือกใหม่'; end if;
  perform public.set_pin_hash(p_user, p_new);
  insert into public.audit_logs(actor_id, action, target, detail)
  values (auth.uid(), 'admin_set_pin', p_user::text, jsonb_build_object('pin_reset', true));
end;
$$;
revoke all on function public.admin_set_pin(uuid, text) from public, anon;
grant execute on function public.admin_set_pin(uuid, text) to authenticated;

create or replace function public.admin_force_status(p_idea uuid, p_status text, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idea public.content_ideas%rowtype;
begin
  if current_role_name() is distinct from 'admin' then raise exception 'ไม่มีสิทธิ์'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'ต้องระบุหมายเหตุ'; end if;
  select * into v_idea from public.content_ideas where id = p_idea for update;
  if not found then raise exception 'ไม่พบไอเดีย'; end if;
  perform set_config('app.via_transition', '1', true);
  update public.content_ideas set status = p_status where id = p_idea;
  insert into public.workflow_history(idea_id, actor_id, from_status, to_status, note)
  values (p_idea, auth.uid(), v_idea.status, p_status, btrim(p_note));
  insert into public.audit_logs(actor_id, action, target, detail)
  values (auth.uid(), 'admin_force_status', p_idea::text,
          jsonb_build_object('from', v_idea.status, 'to', p_status, 'note', btrim(p_note)));
end;
$$;
revoke all on function public.admin_force_status(uuid, text, text) from public, anon;
grant execute on function public.admin_force_status(uuid, text, text) to authenticated;

create or replace function public.guard_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and coalesce(current_setting('app.via_transition', true), '') <> '1' then
    raise exception 'สถานะเปลี่ยนได้ผ่านขั้นตอน Workflow เท่านั้น';
  end if;
  if current_role_name() is distinct from 'admin'
     and (new.owner_id is distinct from old.owner_id or new.code is distinct from old.code) then
    raise exception 'ไม่สามารถแก้ไขเจ้าของหรือรหัสไอเดียได้';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.gate_ready()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'ready_to_publish' and old.status is distinct from new.status
     and not (current_role_name() = 'admin' and coalesce(current_setting('app.via_transition', true), '') = '1')
     and exists (select 1 from public.checklist_items where idea_id = new.id and is_required and not is_done) then
    raise exception 'ยังตรวจสอบ Checklist ก่อนเผยแพร่ไม่ครบ';
  end if;
  return new;
end;
$$;

create or replace function public.gate_published()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'published' and old.status is distinct from new.status
     and not (current_role_name() = 'admin' and coalesce(current_setting('app.via_transition', true), '') = '1')
     and not exists (select 1 from public.published_contents where idea_id = new.id) then
    raise exception 'ต้องบันทึกลิงก์ผลงานที่เผยแพร่ก่อนเปลี่ยนเป็นออนไลน์แล้ว';
  end if;
  return new;
end;
$$;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or current_role_name() in ('reviewer', 'content_manager', 'admin')
  );

create or replace view public.profile_names
with (security_barrier = true)
as
select id, coalesce(nullif(display_name, ''), nullif(full_name, ''), 'ผู้ใช้') as name
from public.profiles
where is_active and approval_status = 'approved'
  and current_role_name() is not null;
grant select on public.profile_names to authenticated;

drop function if exists public.compliance_report();
create function public.compliance_report()
returns table(uid uuid, red_stack int, missed_total int, week_count int, required int, next_deadline date, week_ok boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pol submission_policy;
  viewer text := current_role_name();
  tz text;
  today date;
  first_d date;
  next_d date;
  d date;
  ws timestamptz;
  we timestamptz;
  u record;
  st int;
  ms int;
  c int;
begin
  select * into pol from submission_policy;
  if viewer is null or not pol.enabled then return; end if;
  tz := pol.timezone;
  today := (now() at time zone tz)::date;
  first_d := pol.start_date + 6;
  first_d := first_d + ((pol.deadline_dow - extract(isodow from first_d)::int + 7) % 7);
  next_d := today + ((pol.deadline_dow - extract(isodow from today)::int + 7) % 7);
  for u in
    select id, created_at from public.profiles
    where is_active and approval_status = 'approved' and not exempt_from_submission
      and (viewer in ('content_manager', 'admin') or id = auth.uid())
    order by full_name
  loop
    st := 0; ms := 0; d := first_d;
    while d < next_d loop
      ws := ((d - 6)::timestamp) at time zone tz;
      we := ((d + 1)::timestamp) at time zone tz;
      if u.created_at <= ws then
        select count(distinct h.idea_id) into c from workflow_history h
        where h.actor_id = u.id and h.from_status = 'draft' and h.to_status = 'pending_review'
          and h.created_at >= ws and h.created_at < we;
        if c >= pol.required_count then st := greatest(0, st - 1);
        else st := st + 1; ms := ms + 1; end if;
      end if;
      d := d + 7;
    end loop;
    ws := ((next_d - 6)::timestamp) at time zone tz;
    we := ((next_d + 1)::timestamp) at time zone tz;
    select count(distinct h.idea_id) into c from workflow_history h
    where h.actor_id = u.id and h.from_status = 'draft' and h.to_status = 'pending_review'
      and h.created_at >= ws and h.created_at < we;
    uid := u.id; red_stack := st; missed_total := ms; week_count := c;
    required := pol.required_count; next_deadline := next_d; week_ok := c >= pol.required_count;
    return next;
  end loop;
end;
$$;

create or replace function public.require_approved()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and current_role_name() is null then
    raise exception 'บัญชียังไม่ได้รับอนุมัติ';
  end if;
  return new;
end;
$$;

drop trigger if exists require_approved_content_ideas on public.content_ideas;
create trigger require_approved_content_ideas before insert on public.content_ideas
  for each row execute function public.require_approved();
drop trigger if exists require_approved_comments on public.comments;
create trigger require_approved_comments before insert on public.comments
  for each row execute function public.require_approved();
drop trigger if exists require_approved_idea_attachments on public.idea_attachments;
create trigger require_approved_idea_attachments before insert on public.idea_attachments
  for each row execute function public.require_approved();
drop trigger if exists require_approved_published_contents on public.published_contents;
create trigger require_approved_published_contents before insert on public.published_contents
  for each row execute function public.require_approved();
drop trigger if exists require_approved_portfolio_contributions on public.portfolio_contributions;
create trigger require_approved_portfolio_contributions before insert on public.portfolio_contributions
  for each row execute function public.require_approved();
drop trigger if exists require_approved_content_metrics on public.content_metrics;
create trigger require_approved_content_metrics before insert on public.content_metrics
  for each row execute function public.require_approved();

drop policy if exists ideas_read on public.content_ideas;
create policy ideas_read on public.content_ideas for select to authenticated using (
  owner_id = auth.uid()
  or (status <> 'draft' and current_role_name() in ('reviewer', 'content_manager', 'admin'))
  or current_role_name() = 'admin'
);
drop policy if exists ideas_assignee_read on public.content_ideas;
create policy ideas_assignee_read on public.content_ideas for select to authenticated using (
  assignee_id = auth.uid()
  and current_role_name() in ('reviewer', 'content_manager', 'admin')
);

do $$
declare
  t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename <> 'audit_logs'
      and tablename <> 'profile_pins'
  loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('drop policy if exists %I on public.%I', 'admin_all_' || t.tablename, t.tablename);
    execute format(
      'create policy %I on public.%I for all to authenticated using (current_role_name() = ''admin'') with check (current_role_name() = ''admin'')',
      'admin_all_' || t.tablename, t.tablename
    );
  end loop;
end;
$$;

drop policy if exists idea_files_admin_read on storage.objects;
create policy idea_files_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'idea-files' and current_role_name() = 'admin');
drop policy if exists idea_files_admin_insert on storage.objects;
create policy idea_files_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'idea-files' and current_role_name() = 'admin');
drop policy if exists idea_files_admin_delete on storage.objects;
create policy idea_files_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'idea-files' and current_role_name() = 'admin');

revoke all on public.profile_pins from anon, authenticated;
grant all on public.pin_attempts, public.pin_change_attempts to authenticated;
grant all on public.profile_pins, public.pin_attempts, public.pin_change_attempts to service_role;
