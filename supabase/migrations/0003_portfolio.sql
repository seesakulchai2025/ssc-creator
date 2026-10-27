-- Published content, per-person credits, manual metrics
create table public.published_contents (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references content_ideas(id) on delete restrict,
  title text not null check (length(title) between 2 and 200),
  url text not null check (url ~* '^https?://'),
  platform text not null, published_at timestamptz,
  created_by uuid not null references profiles(id) default auth.uid(), created_at timestamptz not null default now());
create index on published_contents(idea_id);

create table public.portfolio_contributions (
  id bigint generated always as identity primary key,
  published_id uuid not null references published_contents(id) on delete cascade,
  user_id uuid not null references profiles(id), role_label text not null check (length(role_label) > 0),
  unique (published_id, user_id));

create table public.content_metrics (
  id bigint generated always as identity primary key,
  published_id uuid not null references published_contents(id) on delete cascade,
  recorded_on date not null default current_date,
  views int check (views >= 0), reach int check (reach >= 0), impressions int check (impressions >= 0),
  likes int check (likes >= 0), comments int check (comments >= 0), shares int check (shares >= 0),
  saves int check (saves >= 0), clicks int check (clicks >= 0), followers_gained int check (followers_gained >= 0),
  source_note text, recorded_by uuid not null references profiles(id) default auth.uid(), created_at timestamptz not null default now());
create index on content_metrics(published_id, recorded_on);

-- "Published" requires a recorded URL
create function public.gate_published() returns trigger language plpgsql as $$
begin
  if new.status = 'published' and old.status is distinct from new.status
     and not exists (select 1 from published_contents where idea_id = new.id) then
    raise exception 'ต้องบันทึกลิงก์ผลงานที่เผยแพร่ก่อนเปลี่ยนเป็นออนไลน์แล้ว';
  end if;
  return new;
end $$;
create trigger idea_gate_published before update of status on content_ideas for each row execute function gate_published();

alter table published_contents enable row level security; alter table portfolio_contributions enable row level security; alter table content_metrics enable row level security;

create policy contrib_read on portfolio_contributions for select to authenticated using (true);
create policy pub_read on published_contents for select to authenticated using (
  exists (select 1 from content_ideas c where c.id = idea_id)
  or exists (select 1 from portfolio_contributions pc where pc.published_id = published_contents.id and pc.user_id = auth.uid()));
create policy pub_insert on published_contents for insert to authenticated with check (
  created_by = auth.uid()
  and exists (select 1 from content_ideas c where c.id = idea_id and c.status in ('ready_to_publish','published','completed')
              and (c.owner_id = auth.uid() or current_role_name() in ('content_manager','admin'))));
create policy pub_update on published_contents for update to authenticated using (created_by = auth.uid() or current_role_name() in ('content_manager','admin'));
create policy pub_delete on published_contents for delete to authenticated using (created_by = auth.uid() or current_role_name() in ('content_manager','admin'));

create policy contrib_insert on portfolio_contributions for insert to authenticated with check (
  current_role_name() in ('content_manager','admin')
  or exists (select 1 from published_contents p where p.id = published_id and p.created_by = auth.uid()));
create policy contrib_delete on portfolio_contributions for delete to authenticated using (
  current_role_name() in ('content_manager','admin')
  or exists (select 1 from published_contents p where p.id = published_id and p.created_by = auth.uid()));

create policy metrics_read on content_metrics for select to authenticated using (exists (select 1 from published_contents p where p.id = published_id));
create policy metrics_insert on content_metrics for insert to authenticated with check (
  recorded_by = auth.uid() and (current_role_name() in ('content_manager','admin')
   or exists (select 1 from portfolio_contributions pc where pc.published_id = content_metrics.published_id and pc.user_id = auth.uid())));
create policy metrics_delete on content_metrics for delete to authenticated using (recorded_by = auth.uid() or current_role_name() in ('content_manager','admin'));
