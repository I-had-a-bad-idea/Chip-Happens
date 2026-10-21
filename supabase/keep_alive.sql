drop table if exists public.keep_alive;

create table if not exists public.keep_alive (
    id boolean primary key default true check (id),
    last_ping timestamptz not null default now()
);

alter table public.keep_alive enable row level security;

revoke all on public.keep_alive from anon, authenticated;
grant select, insert, update on public.keep_alive to anon;

create policy "Allow anon heartbeat access"
on public.keep_alive
for all
to anon
using (true)
with check (true);