drop table if exists public.players;
drop table if exists public.games;

create table public.games (
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

create table public.players (
    id uuid primary key default gen_random_uuid(),
    game_id uuid not null references public.games(id) on delete cascade,
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

create index players_game_id_idx on public.players(game_id);
create unique index players_game_seat_position_idx on public.players(game_id, seat_position);

alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.games;

create or replace function public.create_game(
    p_code text,
    p_name text, p_seat_position integer
    p_buy_in integer, p_small_blind integer, p_big_blind integer
) returns uuid
language plpgsql
as $$
declare
    v_game_id uuid;
    v_player_id uuid;
begin
    if trim(p_name) = '' or p_seat_position not between 1 and 10 or p_buy_in <= 0
       or p_small_blind <= 0 or p_big_blind < p_small_blind then
        raise exception 'Invalid game or player details.';
    end if;

    insert into public.games(code, buy_in, small_blind, big_blind)
    values (upper(p_code), p_buy_in, p_small_blind, p_big_blind)
    returning id into v_game_id;

    insert into public.players(game_id, name, seat_position, chips)
    values (v_game_id, trim(p_name), p_seat_position, p_buy_in)
    returning id into v_player_id;

    update public.games
    set host = v_player_id, current_dealer = v_player_id, current_player = v_player_id
    where id = v_game_id;

    return v_player_id;
end;
$$;
