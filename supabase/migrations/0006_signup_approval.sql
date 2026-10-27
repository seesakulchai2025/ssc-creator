alter table public.profiles
  add column approval_status text not null default 'pending'
  check (approval_status in ('pending', 'approved', 'rejected'));

update public.profiles set approval_status = 'approved';

create table public.profile_private (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  phone text unique not null
);
alter table public.profile_private enable row level security;
create policy profile_private_read on public.profile_private for select to authenticated
  using (user_id = auth.uid() or current_role_name() = 'admin');
create policy profile_private_update on public.profile_private for update to authenticated
  using (user_id = auth.uid() or current_role_name() = 'admin')
  with check (user_id = auth.uid() or current_role_name() = 'admin');

create table public.app_settings (
  key text primary key,
  value text not null
);
alter table public.app_settings enable row level security;
create policy app_settings_admin on public.app_settings for all to authenticated
  using (current_role_name() = 'admin')
  with check (current_role_name() = 'admin');
insert into public.app_settings(key, value) values ('join_code', '<CHANGE_ME>');

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_metadata jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_full_name text := coalesce(v_metadata->>'full_name', '');
  v_join_code text := nullif(btrim(v_metadata->>'join_code'), '');
  v_phone text := nullif(v_metadata->>'phone', '');
  v_expected_code text;
begin
  insert into public.profiles(id, full_name, approval_status)
  values (new.id, v_full_name, 'pending');

  insert into public.notifications(user_id, message)
  select id, 'มีผู้สมัครใหม่รออนุมัติ'
  from public.profiles
  where role = 'admin' and is_active;

  if v_join_code is null and v_phone is null then
    return new;
  end if;

  select value into v_expected_code
  from public.app_settings
  where key = 'join_code';

  if v_join_code is null or v_join_code is distinct from v_expected_code then
    raise exception 'รหัสเข้าร่วมไม่ถูกต้อง';
  end if;
  if v_phone is null or v_phone !~ '^0[0-9]{9}$' then
    raise exception 'เบอร์โทรศัพท์ไม่ถูกต้อง';
  end if;

  insert into public.profile_private(user_id, phone) values (new.id, v_phone);

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
      auth.uid(),
      'profile_update',
      new.id::text,
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

drop policy profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or current_role_name() is not null);

create or replace function public.compliance_report()
returns table(uid uuid, name text, red_stack int, missed_total int, week_count int, required int, next_deadline date, week_ok boolean)
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
    select id, full_name, display_name, created_at
    from public.profiles
    where is_active
      and approval_status = 'approved'
      and not exempt_from_submission
      and (viewer in ('content_manager', 'admin') or id = auth.uid())
    order by full_name
  loop
    st := 0;
    ms := 0;
    d := first_d;
    while d < next_d loop
      ws := ((d - 6)::timestamp) at time zone tz;
      we := ((d + 1)::timestamp) at time zone tz;
      if u.created_at <= ws then
        select count(distinct h.idea_id) into c
        from workflow_history h
        where h.actor_id = u.id
          and h.from_status = 'draft'
          and h.to_status = 'pending_review'
          and h.created_at >= ws
          and h.created_at < we;
        if c >= pol.required_count then
          st := greatest(0, st - 1);
        else
          st := st + 1;
          ms := ms + 1;
        end if;
      end if;
      d := d + 7;
    end loop;
    ws := ((next_d - 6)::timestamp) at time zone tz;
    we := ((next_d + 1)::timestamp) at time zone tz;
    select count(distinct h.idea_id) into c
    from workflow_history h
    where h.actor_id = u.id
      and h.from_status = 'draft'
      and h.to_status = 'pending_review'
      and h.created_at >= ws
      and h.created_at < we;
    uid := u.id;
    name := coalesce(nullif(u.display_name, ''), nullif(u.full_name, ''), 'ผู้ใช้');
    red_stack := st;
    missed_total := ms;
    week_count := c;
    required := pol.required_count;
    next_deadline := next_d;
    week_ok := c >= pol.required_count;
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

create trigger require_approved_content_ideas
  before insert on public.content_ideas
  for each row execute function public.require_approved();
create trigger require_approved_comments
  before insert on public.comments
  for each row execute function public.require_approved();
create trigger require_approved_idea_attachments
  before insert on public.idea_attachments
  for each row execute function public.require_approved();
create trigger require_approved_published_contents
  before insert on public.published_contents
  for each row execute function public.require_approved();
create trigger require_approved_portfolio_contributions
  before insert on public.portfolio_contributions
  for each row execute function public.require_approved();
create trigger require_approved_content_metrics
  before insert on public.content_metrics
  for each row execute function public.require_approved();
