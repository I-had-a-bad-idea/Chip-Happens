# Stay-loose-play-72
A simple oker chip counting system for when you have cars but no chips


Installing Supabase stuff:
```bash
npm install @supabase/supabase-js
```


## How to deploy to prod
1. Create a Supabase account + project
2. Get the Supabase URL and Publishable key (Settings -- API Keys)
3. Create the database using the SQL Editor

```sql
create table games (
    id uuid primary key default gen_random_uuid(),
    code text unique not null,
    pot integer not null default 0,
    round integer not null default 0,
    created_at timestamptz not null default now()
);

create table players (
    id uuid primary key default gen_random_uuid(),
    game_id uuid not null references games(id) on delete cascade,
    name text not null,
    chips integer not null default 0,
    created_at timestamptz not null default now()
);

create index players_game_id_idx
    on players(game_id);
```

4. Enable realtime for the `players` table

```sql
alter publication supabase_realtime
add table players;
```

5. Create a Vercel project
6. Add your Supabase env variables to the project (`NEXT_PUBLIC_SUPABASE_URL` & `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`)