"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Player = {
  id: string;
  game_id: string;
  name: string;
  seat_position: number;

  active: boolean;
  chips: number;
  current_bet: number;
  total_contribution: number;
  has_acted: boolean;
  folded: boolean;
  all_in: boolean;

  created_at: string;
};

type Game = {
  id: string;
  code: string;

  buy_in: number;
  small_blind: number;
  big_blind: number;
  
  host: string | null; // the player ID of the host

  status: "waiting" | "playing";
  pot: number;
  current_dealer: string | null;
  betting_round: number; // Preflop, Flop, Turn, River
  current_bet: number;
  current_player: string | null;

  created_at: string
};

type Pot = {
  amount: number;
  eligiblePlayerIds: string[];
};

type GameSnapshot = { game: Game; players: Player[] };

const BETTING_ROUND_NAMES = ["Preflop", "Flop", "Turn", "River", "Showdown"];

export default function GamePage({params,}: {params: Promise<{ code: string }>;}) {
  const { code } = use(params);
  const router = useRouter();

  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [chipAmount, setChipAmount] = useState(100);
  const [potWinnerSelections, setPotWinnerSelections] = useState<Record<number, string[]>>({});
  const actionInFlight = useRef(false);
  const loadInFlight = useRef(false);

  async function loadGame() {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    const gameCode = code.toUpperCase();

    try {
      const { data: snapshot, error: gameError } = await supabase.rpc("get_game", {
        p_code: gameCode,
      });

      if (gameError || !snapshot) {
        if (gameError?.code === "PGRST116" || gameError?.message.includes("Game not found")) {
          setError("Game not found.");
        } else {
          setSyncWarning("Connection issue. Retrying sync...");
        }
        setLoading(false);
        return;
      }

      const gameSnapshot = snapshot as GameSnapshot;
      setGame(gameSnapshot.game);
      setPlayers(gameSnapshot.players);
      setSyncWarning("");

      const storedPlayerId = localStorage.getItem(`poker-player-${gameCode}`);
      setCurrentPlayerId(storedPlayerId);
      setLoading(false);
    } catch {
      setSyncWarning("Connection issue. Retrying sync...");
      setLoading(false);
    } finally {
      loadInFlight.current = false;
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => {loadGame();}, [code]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") loadGame();
    };
    const refreshWhenOnline = () => loadGame();
    const refreshInterval = window.setInterval(loadGame, 5000);
    window.addEventListener("online", refreshWhenOnline);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener("online", refreshWhenOnline);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    if (!game) return;

    // Subscribe to the game, regarding changes in the player table
    const channel = supabase
      .channel(`game-${game.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter: `game_id=eq.${game.id}`,
        },
        () => {
          loadGame();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "games",
          filter: `id=eq.${game.id}`,
        },
        () => {
          loadGame();
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setSyncWarning("");
          loadGame();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setSyncWarning("Connection issue. Retrying sync...");
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id]);

  async function performGameAction(
    action: string,
    options: { amount?: number; targetPlayerId?: string; winners?: string[][] } = {},
  ) {
    if (!game) return false;

    const { data, error: actionError } = await supabase.rpc("game_action", {
      p_code: game.code,
      p_actor_id: currentPlayerId,
      p_action: action,
      p_amount: options.amount ?? null,
      p_target_player_id: options.targetPlayerId ?? null,
      p_winners: options.winners ?? null,
    });

    if (actionError || !data) {
      setError(actionError?.message ?? "Could not complete game action.");
      return false;
    }

    const snapshot = data as GameSnapshot;
    setGame(snapshot.game);
    setPlayers(snapshot.players);
    setError("");
    return true;
  }

  async function startGame() {
    if (!game || !isHost) return;
    if (game.status != "waiting") return;

    const activePlayers = players.filter((p) => p.active);
    
    if (activePlayers.length < 2) {
      setError("You need at least 2 active players to start.");
      return;
    }

    setError("");
    await performGameAction("start");
  }

  async function call() {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      await performGameAction("call");
    } finally {
      actionInFlight.current = false;
    }
  }

  async function fold() {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      await performGameAction("fold");
    } finally {
      actionInFlight.current = false;
    }
  }

  async function togglePlayerActive(playerId: string) {
    if (!isHost) return;

    const player = players.find((p) => p.id === playerId);
    if (!player) return;

    // Dont allow changing participation during an active hand.
    if (game?.status === "playing" && !isShowdown) {
      setError("Players can only be made inactive between hands.");
      return;
    }

    await performGameAction("toggle_active", { targetPlayerId: playerId });
  }

  async function check() {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      await performGameAction("check");
    } finally {
      actionInFlight.current = false;
    }
  }

  async function raise(raise_amount: number) {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      await performGameAction("raise", { amount: raise_amount });
    } finally {
      actionInFlight.current = false;
    }
  }

  function buildPots(players: Player[]): Pot[] {
    const contributions = players
      .map((p) => ({id: p.id, contributed: p.total_contribution, folded: p.folded, active: p.active}))
      .filter((p) => p.contributed > 0);

    if (contributions.length === 0) {
      return [];
    }

    const levels : number[] = [...new Set(contributions.map((p) => p.contributed))].sort((a, b) => a - b);
    const pots: Pot[] = [];
    let previousLevel = 0;
    
    for (const level of levels) {
      const amountAtLevel = level - previousLevel;

      const contributors = contributions.filter((p) => p.contributed >= level);
      const amount = amountAtLevel * contributors.length;
      const eligiblePlayers = contributors.filter((p) => !p.folded && p.active).map((p) => p.id);
      
      if (amount > 0) {
        const lastPot = pots[pots.length - 1];

        // Check if the last pot had the same eligible players
        const sameEligiblePlayers = lastPot && lastPot.eligiblePlayerIds.length === eligiblePlayers.length &&
          lastPot.eligiblePlayerIds.every((id) => eligiblePlayers.includes(id));
        
        if (sameEligiblePlayers) {
          lastPot.amount += amount; // if yes, just expand the last pot
        } else {
          pots.push({amount, eligiblePlayerIds: eligiblePlayers});
        }
      }

      previousLevel = level;
    }

    return pots;
  }

  async function awardPots() {
    if (!game) return;

    // Only host can choose the winners
    if (currentPlayerId !== game.host) {
      setError("Only the host can award the pots.");
      return;
    }

    const pots = buildPots(players);

    const winnersByPot: string[][] = [];
    for (let potIndex = 0; potIndex < pots.length; potIndex++) {
      const pot = pots[potIndex];
      const winnerIds = potWinnerSelections[potIndex] ?? [];

      if (winnerIds.length === 0 || winnerIds.some((winnerId) => !pot.eligiblePlayerIds.includes(winnerId))) {
        setError(`Select at least one winner for pot ${potIndex + 1}.`);
        return;
      }

      winnersByPot.push(winnerIds);
    }
    if (await performGameAction("award", { winners: winnersByPot })) {
      setPotWinnerSelections({});
    }
  }

  function selectPotWinner(potIndex: number, winnerId: string) {
    setPotWinnerSelections((prev) => {
      const selectedWinners = prev[potIndex] ?? [];
      const nextWinners = selectedWinners.includes(winnerId)
        ? selectedWinners.filter((id) => id !== winnerId)
        : [...selectedWinners, winnerId];

      return { ...prev, [potIndex]: nextWinners };
    });
    setError("");
  }
    

  async function removePlayer(playerId: string) {
    if (!window.confirm("Remove this player?")) return;

    await performGameAction("remove_player", { targetPlayerId: playerId });
  }

  function copyCode() {navigator.clipboard.writeText(code.toUpperCase());}

  async function invitePlayers() {
    const inviteURL = `${window.location.origin}/join/${game?.code.toUpperCase()}`;

    if (navigator.share) {
      await navigator.share({
        title: "Join my Chip Happens room",
        text: `Join my Chip Happens room with code ${game?.code.toUpperCase()}`,
        url: inviteURL
      });
    } else {
      await navigator.clipboard.writeText(inviteURL);
      alert("Invite link copied");
    }
  }

  const pot = game?.pot ?? 0;
  const showdownPots = buildPots(players);

  const currentPlayer = players.find((p) => p.id === currentPlayerId);
  const isMyTurn = currentPlayer?.id === game?.current_player && !currentPlayer?.folded && currentPlayer?.active;
  const isHost = currentPlayerId === game?.host;
  const isShowdown = game?.betting_round === BETTING_ROUND_NAMES.length - 1;
  
  const activePlayers = players.filter((p) => p.active);
  const playersInHand = activePlayers.filter((p) => !p.folded);

  if (loading) {
    return (
      <main className="game-page">
        <div className="loading">Loading game...</div>
      </main>
    );
  }

  if (!game) {
    return (
      <main className="game-page">
        <div className="game-card">
          <h1>{syncWarning ? "Reconnecting to game..." : "Game not found"}</h1>
          {syncWarning && <p role="status">{syncWarning}</p>}
          <button
            className="secondary-button"
            onClick={() => router.push("/")}
          >
            Back
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="game-page">
      <header className="game-header">
        <div>
          <div className="small-label">GAME</div>

          <div className="game-code-row">
            <button className="game-code" onClick={copyCode}>
              {game.code}
            </button>

            <button className="invite-button" onClick={invitePlayers}>
              Invite
            </button>

          </div>
          <div className="copy-hint">Tap to copy</div>
        </div>

        <button
          className="leave-button"
          onClick={() => router.push("/")}
        >
          Leave
        </button>
      </header>

      {error && <div className="error game-error">{error}</div>}
      {syncWarning && <div className="error game-error" role="status">{syncWarning}</div>}

      <section className="summary">
        <div>
          <span>Pot</span>
          <strong>{pot.toLocaleString()}</strong>
        </div>

        <div>
          <span>Betting Round</span>
          <strong>{BETTING_ROUND_NAMES[game.betting_round]}</strong>
        </div>

        <div>
          <span>Players</span>
          <strong>{players.length}</strong>
        </div>
      </section>

      {game.status === "waiting" && (
        <section className="waiting-section">
          <h2>Waiting for host to start game</h2>

          <p>
            {players.filter((p) => p.active).length} active players
          </p>

          {isHost && (
            <div>
              <p>Start the game, when everyone has joined</p>

              <button
                className="start-game-button"
                onClick={startGame}
                disabled={players.filter((p) => p.active).length < 2}
              >
                Start Game
              </button>
            </div>
          )}
        </section>
      )}

      <div className="winner-selection">
        {game.status === "playing" && isShowdown && isHost && showdownPots.length > 0 && (
          <div className="winner-picker">
            <h2>Select pot winner(s)</h2>
            {showdownPots.map((potItem, index) => (
              <div key={`${potItem.amount}-${index}`} className="pot-award">
                <h3>Pot {index + 1}: {potItem.amount.toLocaleString()} chips</h3>
                {playersInHand
                  .filter((player) => potItem.eligiblePlayerIds.includes(player.id))
                  .map((player) => (
                    <button
                      key={player.id}
                      className={`winner-button ${potWinnerSelections[index]?.includes(player.id) ? "winner-selected" : ""}`}
                      onClick={() => selectPotWinner(index, player.id)}
                      aria-pressed={potWinnerSelections[index]?.includes(player.id)}
                    >
                      {player.name} ({player.chips.toLocaleString()} chips)
                    </button>
                  ))}
              </div>
            ))}
            <button className="start-game-button" onClick={awardPots}>
              Award pots
            </button>
          </div>
        )}
      </div>

      <section className="players">
        {players.map((player) => {
          const isMe = player.id === currentPlayerId;
          const isCurrentPlayer = player.id === game.current_player;
          const chipsToMatch = game.current_bet - player.current_bet;

          return (
            <article
              className={`player ${isMe ? "player-me" : ""}
                ${!player.active ? "player-inactive": ""} ${player.folded ? "player-folded" : ""} ${player.all_in ? "player-all_in": ""}`}
              key={player.id}
            >
              <div className="player-top">
                <div>
                  <div className="player-name">
                    <span className="player-seat">SEAT {player.seat_position}</span>
                    {player.name}

                    {isMe && (
                      <span className="player-badge">YOU</span>
                    )}
                    {(game.status === "playing" && isMe && isMyTurn) && (
                      <span className="player-badge">YOUR TURN</span>
                    )}
                    {(game.status === "playing" && !isMe && isCurrentPlayer) && (
                      <span className="player-badge">Thinking about going all-in...</span>
                    )}
                    {(game.status === "playing" && player.folded) && (
                      <span className="player-badge">FOLDED</span>
                    )}
                    {(game.status === "playing" && player.all_in) && (
                      <span className="player-badge">ALL-IN</span>
                    )}
                  </div>

                  <div className="chip-count">
                    {player.chips.toLocaleString()}
                  </div>
                  <div className="current-bet">
                    Current bet:  {player.current_bet.toLocaleString()}
                  </div>
                </div>

              </div>
            {game.status === "playing" && isMe && isMyTurn &&  (
            <div className="poker-actions">
              <button
                className="fold-button"
                onClick={fold}
              >
                Fold
              </button>

              {game.current_bet === 0 || player.current_bet === game.current_bet ? (
                <button
                  className="check-button"
                  onClick={check}
                >
                  Check
                </button>
              ) : (
                <button
                  className="call-button"
                  onClick={call}
                  // Dont disable to allow all-ins (which the call function can handle)
                  // disabled={player.chips < (game.current_bet - player.current_bet)}
                >
                  {player.chips > (game.current_bet - player.current_bet)
                      ? `Call ${game.current_bet - player.current_bet}`
                      : `All in ${player.chips}`}
                </button>
              )}

              <input
                type="number"
                min="1"
                step="1"
                value={chipAmount}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setChipAmount(value > 0 ? value : 1);
                }}
                />
              <button
                className="raise-button"
                onClick={() => raise(chipAmount)}
                disabled={player.chips < (chipsToMatch + chipAmount)}
              >
                Raise by {chipAmount}
              </button>
            </div>
          )}
          {isHost && (
            <div className="host-player-actions">
              <button
                className="remove-button"
                onClick={() => removePlayer(player.id)}
              >
              Remove player
              </button>
              
              <button
                className="active-button"
                onClick={() => togglePlayerActive(player.id)}
                disabled={game.status === "playing" && !isShowdown}
              >
              {player.active ? "Make inactive": "Make active"}
              </button>
            </div>
          )}
            </article>
          );
        })}

        {players.length === 0 && (
          <div className="empty">
            Nobody is in the game yet.
          </div>
        )}
      </section>
    </main>
  );
}