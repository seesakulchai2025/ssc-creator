-- Weekly submission rule, admin guard, audit log, assignment
create table public.submission_policy (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  deadline_dow int not null default 1 check (deadline_dow between 1 and 7), -- ISO: 1 = Monday
  required_count int not null default 1 check (required_count >= 1),
  start_date date not null default current_date,  -- only whole weeks that begin after this date are counted
  timezone text not null default 'Asia/Bangkok');
insert into submission_policy default values;
alter table profiles add column exempt_from_submission boolean not null default false;

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid, action text not null, target text, detail jsonb, created_at timestamptz not null default now());

-- Stack rule: week missed => +1; week met => -1 (never below 0). Window = Tue 00:00 .. Mon 24:00 local time.
-- A submission = an idea moved draft -> pending_review by that user.
create function public.compliance_report()
returns table(uid uuid, name text, red_stack int, missed_total int, week_count int, required int, next_deadline date, week_ok boolean)
language plpgsql stable security definer set search_path=public as $$
declare pol submission_policy; viewer text := current_role_name(); tz text; today date; first_d date; next_d date; d date;
        ws timestamptz; we timestamptz; u record; st int; ms int; c int;
begin
  select * into pol from submission_policy;
  if viewer is null or not pol.enabled then return; end if;
  tz := pol.timezone; today := (now() at time zone tz)::date;
  first_d := pol.start_date + 6;
  first_d := first_d + ((pol.deadline_dow - extract(isodow from first_d)::int + 7) % 7);
  next_d := today + ((pol.deadline_dow - extract(isodow from today)::int + 7) % 7);
  for u in select id, full_name, display_name, created_at from profiles
           where is_active and not exempt_from_submission and (viewer in ('content_manager','admin') or id = auth.uid()) order by full_name loop
    st := 0; ms := 0; d := first_d;
    while d < next_d loop
      ws := ((d - 6)::timestamp) at time zone tz; we := ((d + 1)::timestamp) at time zone tz;
      if u.created_at <= ws then
        select count(distinct h.idea_id) into c from workflow_history h
         where h.actor_id = u.id and h.from_status = 'draft' and h.to_status = 'pending_review' and h.created_at >= ws and h.created_at < we;
        if c >= pol.required_count then st := greatest(0, st - 1); else st := st + 1; ms := ms + 1; end if;
      end if;
      d := d + 7;
    end loop;
    ws := ((next_d - 6)::timestamp) at time zone tz; we := ((next_d + 1)::timestamp) at time zone tz;
    select count(distinct h.idea_id) into c from workflow_history h
     where h.actor_id = u.id and h.from_status = 'draft' and h.to_status = 'pending_review' and h.created_at >= ws and h.created_at < we;
    uid := u.id; name := coalesce(nullif(u.display_name,''), nullif(u.full_name,''), 'ผู้ใช้');
    red_stack := st; missed_total := ms; week_count := c; required := pol.required_count; next_deadline := next_d; week_ok := c >= pol.required_count;
    return next;
  end loop;
end $$;

-- Only admins may change role / active / exempt / employee code (also closes self-edit of these fields)
create function public.guard_profile() returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and coalesce(current_role_name(),'') <> 'admin'
     and (new.role is distinct from old.role or new.is_active is distinct from old.is_active
          or new.exempt_from_submission is distinct from old.exempt_from_submission or new.employee_code is distinct from old.employee_code) then
    raise exception 'เฉพาะผู้ดูแลระบบที่แก้ไขสิทธิ์และสถานะบัญชีได้';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on profiles for each row execute function guard_profile();

create function public.audit_profile() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.role is distinct from old.role or new.is_active is distinct from old.is_active or new.exempt_from_submission is distinct from old.exempt_from_submission then
    insert into audit_logs(actor_id,action,target,detail) values (auth.uid(),'profile_update',new.id::text,
      jsonb_build_object('role',jsonb_build_array(old.role,new.role),'is_active',jsonb_build_array(old.is_active,new.is_active),'exempt',jsonb_build_array(old.exempt_from_submission,new.exempt_from_submission)));
  end if; return new;
end $$;
create trigger profiles_audit after update on profiles for each row execute function audit_profile();

create function public.audit_policy() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into audit_logs(actor_id,action,target,detail) values (auth.uid(),'policy_update','submission_policy',jsonb_build_object('before',to_jsonb(old),'after',to_jsonb(new)));
  return new;
end $$;
create trigger policy_audit after update on submission_policy for each row execute function audit_policy();

create function public.notify_assign() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.assignee_id is not null and new.assignee_id is distinct from old.assignee_id then
    insert into notifications(user_id,idea_id,message) values (new.assignee_id,new.id,new.code||': คุณได้รับมอบหมายงาน');
  end if; return new;
end $$;
create trigger idea_assign after update of assignee_id on content_ideas for each row execute function notify_assign();

alter table submission_policy enable row level security; alter table audit_logs enable row level security;
create policy sp_read on submission_policy for select to authenticated using (true);
create policy sp_admin on submission_policy for update to authenticated using (current_role_name() = 'admin') with check (current_role_name() = 'admin');
create policy audit_admin on audit_logs for select to authenticated using (current_role_name() = 'admin');
create policy ideas_assignee_read on content_ideas for select to authenticated using (assignee_id = auth.uid());
