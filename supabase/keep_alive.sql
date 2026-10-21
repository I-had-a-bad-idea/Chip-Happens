create table if not exists public.keep_alive (
    id boolean primary key default true check (id),
    last_ping timestamptz not null default now()
);

alter table public.keep_alive enable row level security;

revoke all on public.keep_alive from anon, authenticated;
grant select, insert, update on public.keep_alive to service_role;
