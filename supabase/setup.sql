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

create or replace function public.get_join_seats(p_code text)
returns integer[]
language plpgsql stable
as $$
declare
    v_game_id uuid;
    v_seats integer[];
begin
    select id into v_game_id from public.games where code = upper(p_code);
    if v_game_id is null then
        raise exception 'Game not found.';
    end if;

    select coalesce(array_agg(seat_position order by seat_position), '{}'::integer[])
    into v_seats from public.players where game_id = v_game_id;
    return v_seats;
end;
$$;

create or replace function public.join_game(
    p_code text,
    p_name text,
    p_seat_position integer
) returns uuid
language plpgsql
as $$
declare
    v_game public.games%rowtype;
    v_player_id uuid;
begin
    if trim(p_name) = '' or p_seat_position not between 1 and 10 then
        raise exception 'Enter a name and choose a valid seat.';
    end if;

    select * into v_game from public.games where code = upper(p_code) for update;
    if not found then
        raise exception 'Game not found.';
    end if;
    if exists (select 1 from public.players where game_id = v_game.id and seat_position = p_seat_position) then
        raise exception 'That seat was just taken. Choose another seat.';
    end if;

    insert into public.players(game_id, name, seat_position, chips)
    values (v_game.id, trim(p_name), p_seat_position, v_game.buy_in)
    returning id into v_player_id;
    return v_player_id;
end;
$$;

create or replace function public.get_game(p_code text)
returns jsonb
language plpgsql stable
as $$
declare
    v_snapshot jsonb;
begin
    select jsonb_build_object(
        'game', to_jsonb(g),
        'players', coalesce((
            select jsonb_agg(to_jsonb(p) order by p.seat_position)
            from public.players p where p.game_id = g.id
        ), '[]'::jsonb)
    ) into v_snapshot
    from public.games g where g.code = upper(p_code);

    if v_snapshot is null then
        raise exception 'Game not found.';
    end if;
    return v_snapshot;
end;
$$;

create or replace function public._chip_happens_start_hand(p_game_id uuid, p_first_hand boolean)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
    v_game public.games%rowtype;
    v_player_ids uuid[];
    v_count integer;
    v_dealer_index integer;
    v_dealer uuid;
    v_small_blind_player uuid;
    v_big_blind_player uuid;
    v_first_to_act uuid;
    v_small_blind integer;
    v_big_blind integer;
begin
    select * into v_game from public.games where id = p_game_id for update;
    select array_agg(id order by seat_position), count(*)
    into v_player_ids, v_count
    from public.players where game_id = p_game_id and active;

    if v_count < 2 then
        raise exception 'You need at least 2 active players to start.';
    end if;

    v_dealer_index := array_position(v_player_ids, v_game.current_dealer);
    if p_first_hand then
        v_dealer_index := coalesce(v_dealer_index, 1);
    else
        v_dealer_index := case when v_dealer_index is null then 1 else (v_dealer_index % v_count) + 1 end;
    end if;

    v_dealer := v_player_ids[v_dealer_index];
    v_small_blind_player := v_player_ids[(v_dealer_index % v_count) + 1];
    v_big_blind_player := v_player_ids[((v_dealer_index + 1) % v_count) + 1];
    v_first_to_act := v_player_ids[((v_dealer_index + 2) % v_count) + 1];

    select least(v_game.small_blind, chips) into v_small_blind
    from public.players where id = v_small_blind_player;
    select least(v_game.big_blind, chips) into v_big_blind
    from public.players where id = v_big_blind_player;

    update public.players
    set chips = chips - v_small_blind,
        current_bet = v_small_blind,
        total_contribution = total_contribution + v_small_blind,
        all_in = chips - v_small_blind = 0,
        has_acted = false
    where id = v_small_blind_player;

    update public.players
    set chips = chips - v_big_blind,
        current_bet = v_big_blind,
        total_contribution = total_contribution + v_big_blind,
        all_in = chips - v_big_blind = 0,
        has_acted = false
    where id = v_big_blind_player;

    update public.games
    set pot = v_small_blind + v_big_blind,
        current_bet = v_big_blind,
        betting_round = 0,
        status = 'playing',
        current_dealer = v_dealer,
        current_player = v_first_to_act
    where id = p_game_id;
end;
$$;

create or replace function public._chip_happens_advance(p_game_id uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
    v_game public.games%rowtype;
    v_active_ids uuid[];
    v_count integer;
    v_actor_index integer;
    v_next_id uuid;
    v_candidate uuid;
    v_round integer;
    v_offset integer;
begin
    select * into v_game from public.games where id = p_game_id for update;

    if (select count(*) from public.players where game_id = p_game_id and active and not folded) <= 1
       or not exists (
           select 1 from public.players
           where game_id = p_game_id and active and not folded and not all_in
       ) then
        update public.games set betting_round = 4, current_player = null where id = p_game_id;
        return;
    end if;

    select array_agg(id order by seat_position), count(*)
    into v_active_ids, v_count
    from public.players where game_id = p_game_id and active;
    v_actor_index := array_position(v_active_ids, p_actor_id);

    for v_offset in 1..v_count loop
        v_candidate := v_active_ids[((coalesce(v_actor_index, 1) - 1 + v_offset) % v_count) + 1];
        if exists (
            select 1 from public.players
            where id = v_candidate and active and not folded and not all_in
              and (current_bet < v_game.current_bet or not has_acted)
        ) then
            v_next_id := v_candidate;
            exit;
        end if;
    end loop;

    if v_next_id is not null then
        update public.games set current_player = v_next_id where id = p_game_id;
        return;
    end if;

    v_round := v_game.betting_round + 1;
    if v_round >= 4 then
        update public.games set betting_round = 4, current_player = null where id = p_game_id;
        return;
    end if;

    update public.players set current_bet = 0, has_acted = false where game_id = p_game_id;
    select array_agg(id order by seat_position), count(*)
    into v_active_ids, v_count
    from public.players where game_id = p_game_id and active;
    v_actor_index := array_position(v_active_ids, v_game.current_dealer);
    v_next_id := null;

    for v_offset in 1..v_count loop
        v_candidate := v_active_ids[((coalesce(v_actor_index, 1) - 1 + v_offset) % v_count) + 1];
        if exists (select 1 from public.players where id = v_candidate and active and not folded and not all_in) then
            v_next_id := v_candidate;
            exit;
        end if;
    end loop;

    if v_next_id is null then
        v_round := 4;
    end if;
    update public.games
    set betting_round = v_round, current_bet = 0,
        current_player = case when v_round = 4 then null else v_next_id end
    where id = p_game_id;
end;
$$;

revoke all on function public._chip_happens_start_hand(uuid, boolean) from public;
revoke all on function public._chip_happens_advance(uuid, uuid) from public;
