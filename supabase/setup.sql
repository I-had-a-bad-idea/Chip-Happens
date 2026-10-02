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

create or replace function public.game_action(
    p_code text,
    p_actor_id uuid,
    p_action text,
    p_amount integer default null,
    p_target_player_id uuid default null,
    p_winners jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
    v_game public.games%rowtype;
    v_player public.players%rowtype;
    v_eligible uuid[];
    v_selected uuid[];
    v_previous_eligible jsonb;
    v_pot_amounts integer[] := '{}'::integer[];
    v_pot_eligible jsonb[];
    v_pot_index integer := 0;
    v_level integer;
    v_previous_level integer := 0;
    v_contributors integer;
    v_amount integer;
    v_share integer;
    v_remainder integer;
    v_winner_index integer;
    v_winner record;
begin
    select * into v_game from public.games where code = upper(p_code) for update;
    if not found then
        raise exception 'Game not found.';
    end if;

    if p_action in ('start', 'award', 'toggle_active', 'remove_player') then
        if p_actor_id is distinct from v_game.host then
            raise exception 'Only the host can perform this action.';
        end if;
    else
        if p_actor_id is distinct from v_game.current_player then
            raise exception 'It is not your turn.';
        end if;
    end if;

    if p_action = 'start' then
        if v_game.status <> 'waiting' then raise exception 'Game has already started.'; end if;
        perform public._chip_happens_start_hand(v_game.id, true);
    elsif p_action in ('call', 'check', 'fold', 'raise') then
        select * into v_player from public.players where id = p_actor_id and game_id = v_game.id for update;
        if not found or not v_player.active or v_player.folded or v_game.status <> 'playing' or v_game.betting_round >= 4 then
            raise exception 'Player cannot act in this game state.';
        end if;

        if p_action = 'fold' then
            update public.players set folded = true, has_acted = true where id = p_actor_id;
        elsif p_action = 'check' then
            if v_player.current_bet < v_game.current_bet then raise exception 'You must call or fold.'; end if;
            update public.players set has_acted = true where id = p_actor_id;
        elsif p_action = 'call' then
            v_amount := least(greatest(v_game.current_bet - v_player.current_bet, 0), v_player.chips);
            if v_amount = 0 then raise exception 'There is no bet to call.'; end if;
            update public.players
            set chips = chips - v_amount,
                current_bet = current_bet + v_amount,
                total_contribution = total_contribution + v_amount,
                has_acted = true,
                all_in = chips - v_amount = 0
            where id = p_actor_id;
            update public.games set pot = pot + v_amount where id = v_game.id;
        else
            if p_amount is null or p_amount <= 0 then raise exception 'Raise must be greater than zero.'; end if;
            v_amount := v_game.current_bet - v_player.current_bet + p_amount;
            if v_amount > v_player.chips then raise exception 'Raise exceeds your chip stack.'; end if;
            update public.players
            set chips = chips - v_amount,
                current_bet = current_bet + v_amount,
                total_contribution = total_contribution + v_amount,
                has_acted = true,
                all_in = chips - v_amount = 0
            where id = p_actor_id;
            update public.players set has_acted = false
            where game_id = v_game.id and id <> p_actor_id and active and not folded and not all_in;
            update public.games set pot = pot + v_amount, current_bet = v_game.current_bet + p_amount where id = v_game.id;
        end if;
        perform public._chip_happens_advance(v_game.id, p_actor_id);
    elsif p_action = 'toggle_active' then
        if v_game.status = 'playing' and v_game.betting_round < 4 then
            raise exception 'Players can only be made inactive between hands.';
        end if;
        update public.players set active = not active
        where id = p_target_player_id and game_id = v_game.id;
        if not found then raise exception 'Player not found.'; end if;
    elsif p_action = 'remove_player' then
        delete from public.players where id = p_target_player_id and game_id = v_game.id;
        if not found then raise exception 'Player not found.'; end if;
    elsif p_action = 'award' then
        if v_game.status <> 'playing' or v_game.betting_round <> 4 then raise exception 'The game is not at showdown.'; end if;

        for v_level in
            select distinct total_contribution from public.players
            where game_id = v_game.id and total_contribution > 0 order by total_contribution
        loop
            select count(*) into v_contributors from public.players
            where game_id = v_game.id and total_contribution >= v_level;
            v_amount := (v_level - v_previous_level) * v_contributors;
            select coalesce(array_agg(id order by seat_position), '{}'::uuid[])
            into v_eligible from public.players
            where game_id = v_game.id and total_contribution >= v_level and active and not folded;

            if v_pot_index > 0 and to_jsonb(v_eligible) = v_previous_eligible then
                v_pot_amounts[v_pot_index] := v_pot_amounts[v_pot_index] + v_amount;
            else
                v_pot_index := v_pot_index + 1;
                v_pot_amounts := array_append(v_pot_amounts, v_amount);
                v_pot_eligible := array_append(v_pot_eligible, to_jsonb(v_eligible));
            end if;
            v_previous_eligible := to_jsonb(v_eligible);
            v_previous_level := v_level;
        end loop;

        if coalesce(jsonb_array_length(p_winners), 0) <> v_pot_index then
            if v_pot_index > 0 then raise exception 'Select winners for every pot.'; end if;
        end if;

        for v_pot_index in 1..coalesce(array_length(v_pot_amounts, 1), 0) loop
            select array_agg(value::uuid) into v_selected
            from jsonb_array_elements_text(p_winners -> (v_pot_index - 1)) as winner(value);
            if coalesce(array_length(v_selected, 1), 0) = 0
                    or cardinality(v_selected) <> (select count(distinct winner_id) from unnest(v_selected) as selected(winner_id))
               or exists (
                   select 1 from unnest(v_selected) as selected(winner_id)
                   where not exists (
                       select 1 from jsonb_array_elements_text(v_pot_eligible[v_pot_index]) eligible(player_id)
                       where eligible.player_id::uuid = selected.winner_id
                   )
               ) then
                raise exception 'Invalid winner selection for pot %.', v_pot_index;
            end if;

            v_share := v_pot_amounts[v_pot_index] / array_length(v_selected, 1);
            v_remainder := v_pot_amounts[v_pot_index] % array_length(v_selected, 1);
            v_winner_index := 0;
            for v_winner in
                select id from public.players
                where id = any(v_selected) and game_id = v_game.id order by seat_position
            loop
                v_winner_index := v_winner_index + 1;
                update public.players set chips = chips + v_share + case when v_winner_index <= v_remainder then 1 else 0 end
                where id = v_winner.id;
            end loop;
        end loop;

        update public.players
        set current_bet = 0, folded = false, has_acted = false,
            total_contribution = 0, all_in = false
        where game_id = v_game.id;
        update public.games
        set pot = 0, betting_round = 0, current_bet = 0,
            current_player = current_dealer
        where id = v_game.id;

        if v_game.status = 'playing' and (select count(*) from public.players where game_id = v_game.id and active) >= 2 then
            perform public._chip_happens_start_hand(v_game.id, false);
        end if;
    else
        raise exception 'Unknown game action.';
    end if;

    return public.get_game(upper(p_code));
end;
$$;
