# Chip-Happens
A simple poker chip counting system for when you have cards but no chips.

Find the prod deployment here:
https://chip-happens.vercel.app/

## Locally

Get the environemnt keys for the Supabase DB and put them in `.env.local`.

Installing Dependencies
```bash
npm install .
```

Running:

```bash
npm run dev
```

## How to deploy to prod
1. Create a Supabase account + project
2. Get the Supabase URL and Publishable key (Settings -- API Keys)
3. Create the database using the SQL Editor

```sql
-- Drop existing tables (this will delete your data)
drop table if exists players;
drop table if exists games;

create table games (
    id uuid primary key default gen_random_uuid(),
    code text unique not null,
    host uuid,

    buy_in integer not null default 1000,

    small_blind integer not null default 10,
    big_blind integer not null default 20,
    
    status text not null default 'waiting',
    current_dealer uuid,
    betting_round integer not null default 0,
    pot integer not null default 0,
    current_bet integer not null default 0,
    current_player uuid,

    created_at timestamptz not null default now()
);

create table players (
    id uuid primary key default gen_random_uuid(),
    game_id uuid not null references games(id) on delete cascade,
    name text not null,

    seat_position integer not null,

    active boolean not null default true,
    chips integer not null default 0,
    current_bet integer not null default 0,
    total_contribution integer not null default 0,
    has_acted boolean not null default false,
    folded boolean not null default false,
    all_in boolean not null default false,

    created_at timestamptz not null default now()
);

create index players_game_id_idx
    on players(game_id);

create unique index players_game_seat_position_idx
    on players(game_id, seat_position);
```

1. Enable realtime for the tables

```sql
alter publication supabase_realtime
add table players;

alter publication supabase_realtime
add table games;
```

5. Create a Vercel project
6. Add your Supabase env variables to the project (`NEXT_PUBLIC_SUPABASE_URL` & `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`)