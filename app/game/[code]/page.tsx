"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Player = {
  id: string;
  game_id: string;
  name: string;

  active: boolean;
  chips: number;
  current_bet: number;
  has_acted: boolean;
  folded: boolean;

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

const BETTING_ROUND_NAMES = ["Preflop", "Flop", "Turn", "River", "Showdown"];

export default function GamePage({params,}: {params: Promise<{ code: string }>;}) {
  const { code } = use(params);
  const router = useRouter();

  const [game, setGame] = useState<Game | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chipAmount, setChipAmount] = useState(100);
  const actionInFlight = useRef(false);

  async function loadGame() {
    const gameCode = code.toUpperCase();

    // Get the game data
    const { data: gameData, error: gameError } = await supabase
      .from("games")
      .select("*")
      .eq("code", gameCode)
      .single();

    if (gameError || !gameData) {
      setError("Game not found.");
      setLoading(false);
      return;
    }

    setGame(gameData);

    // Get all players inside the game (sorted by creation date)
    const { data: playerData, error: playerError } = await supabase
      .from("players")
      .select("*")
      .eq("game_id", gameData.id)
      .order("created_at", { ascending: true });

    if (playerError) {
      setError(playerError.message);
    } else {
      setPlayers(playerData ?? []);
    }

    const storedPlayerId = localStorage.getItem(`poker-player-${gameCode}`);

    setCurrentPlayerId(storedPlayerId);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => {loadGame();}, [code]);

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
      .subscribe();

    return () => {supabase.removeChannel(channel);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id]);

  async function startNewHand(first_hand: boolean, playersForHand: Player[] = players) {
    if (!game || playersForHand.length < 2) return;

    const activePlayers = playersForHand.filter((p) => p.active);
    const playersInHand = activePlayers.filter((p) => !p.folded);
    
    if (playersInHand.length < 2) return;

    const dealerIndex = playersInHand.findIndex((p) => p.id === game.current_dealer);
    
    let newDealerIndex = dealerIndex;
    if (!first_hand) {
      // Dealer moves one seat
      newDealerIndex = dealerIndex === -1 ? 0 : (dealerIndex + 1) % playersInHand.length;
    }

    const dealer = playersInHand[newDealerIndex];
    // Small blind is player after dealer
    const smallBlindPlayer = playersInHand[(newDealerIndex + 1) % playersInHand.length];
    // Big blind is after small blind
    const bigBlindPlayer = playersInHand[(newDealerIndex + 2) % playersInHand.length];
    // First player to act is after the big blind
    const underTheGunPlayer = playersInHand[(newDealerIndex + 3) % playersInHand.length];

    // Don't allow the blinds to go into debt
    const smallBlindAmount = Math.min(game.small_blind, smallBlindPlayer.chips);
    const bigBlindAmount = Math.min(game.big_blind, bigBlindPlayer.chips);

      // Update players
    const { error: smallBlindError } = await supabase
      .from("players")
      .update({chips: smallBlindPlayer.chips - smallBlindAmount, current_bet: smallBlindAmount,})
      .eq("id", smallBlindPlayer.id);

    if (smallBlindError) {
      setError(smallBlindError.message);
      return;
    }

    const { error: bigBlindError } = await supabase
      .from("players")
      .update({chips: bigBlindPlayer.chips - bigBlindAmount, current_bet: bigBlindAmount,})
      .eq("id", bigBlindPlayer.id);

    if (bigBlindError) {
      setError(bigBlindError.message);
      return;
    }

    // Add blinds to pot
    const blindPot = smallBlindAmount + bigBlindAmount;
    const { error: gameError } = await supabase
      .from("games")
      .update({pot: blindPot, current_bet: bigBlindAmount, status: "playing", current_dealer: dealer.id, current_player: underTheGunPlayer.id,})
      .eq("id", game.id);

    if (gameError) {
      setError(gameError.message);
      return;
    }

    await loadGame();
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

    await startNewHand(true);
  }

  async function progressToNextBettingRound() {
    if (!game) return;

    const activePlayers = players.filter((p) => p.active);
    const playersInHand = activePlayers.filter((p) => !p.folded);

    const nextBettingRound = game.betting_round + 1;
    let nextPlayer: string | null = null;

    if (nextBettingRound < BETTING_ROUND_NAMES.length - 1) {
      // Find the dealers position in the current hand
      // Use active players, since the current player might have folded
      const dealerIndex = activePlayers.findIndex((p) => p.id === game.current_dealer);
    
      if (dealerIndex === -1) {
        setError("Could not determine dealer position.");
        return;
      }

      // Post-Flop the small blind is the first player to act
      // Starting with the small blind, search for an eligible player
      for (let i = 1; i <= playersInHand.length; i++) {
        const player = playersInHand[(dealerIndex + i) % playersInHand.length];

        // The first eligible player acts first
        if (player.active && !player.folded) {
          nextPlayer = player.id;
          break;
        }
      }
    }

    const { error } = await supabase
      .from("games")
      .update({
        betting_round: nextBettingRound,
        current_bet: 0,
        current_player: nextPlayer,
      })
      .eq("id", game.id);

    if (error) {
      setError(error.message);
      return;
    }

    const { error: playersError } = await supabase
      .from("players")
      .update({ current_bet: 0, has_acted: false })
      .eq("game_id", game.id);

    if (playersError) {
      setError(playersError.message);
      return;
    }

    setGame((prevGame) => prevGame ? {
      ...prevGame,
      betting_round: nextBettingRound,
      current_bet: 0,
      current_player: nextPlayer,
    } : null);
    setPlayers((prevPlayers) => prevPlayers.map((player) => ({
      ...player,
      current_bet: 0,
      has_acted: false,
    })));
  }

  async function progressToNextPlayer(currentPlayerId: string, currentBet: number, updatedPlayers: Player[] = players) {
    if (!game) return;

    const activePlayers = updatedPlayers.filter((p) => p.active);
    const playersInHand = activePlayers.filter((p) => !p.folded);
    if (playersInHand.length === 1) {
      // const winner = playersInHand[0]; // last remaining player wins

      // Switch to showdown so host can select the last player as the winner
      const {error} = await supabase
        .from("games")
        .update({betting_round: BETTING_ROUND_NAMES.length - 1, current_player: null})
        .eq("id", game.id);

      if (error) {
        setError(error.message);
        return;
      }
      setGame((prevGame) => prevGame ? {...prevGame, betting_round: BETTING_ROUND_NAMES.length - 1, current_player: null,} : null);
      return;
    }
    // Use active players, since the current player might have folded
    const currentIndex = activePlayers.findIndex((p) => p.id === currentPlayerId);

    if (currentIndex === -1 ) {
      setError("Could not find the current player")
      return;
    }

    // Look for the next active player who has not matched the current bet or still needs to act
    for (let i = 1; i <= playersInHand.length; i++) {
      const nextPlayer = playersInHand[(currentIndex + i) % playersInHand.length];

      if (nextPlayer.current_bet < currentBet || !nextPlayer.has_acted) {
        const { error } = await supabase
          .from("games")
          .update({ current_player: nextPlayer.id })
          .eq("id", game.id);

        if (error) {
          setError(error.message);
        }
        return;
      }
    }

    // Everyone has matched the current bet, progress to next betting round
    await progressToNextBettingRound();
  }

  async function call() {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      const currentChipCount = players.find((p) => p.id === currentPlayerId)?.chips ?? 0;
      const currentBet = players.find((p) => p.id === currentPlayerId)?.current_bet ?? 0;
      const chipsToCall = game.current_bet - currentBet;
      if (chipsToCall <= 0) return;
      const newChipCount = currentChipCount - chipsToCall;
    
      // Update the player's chips in the DB
      const { error: player_error } = await supabase
        .from("players")
        .update({ chips: newChipCount, current_bet: game.current_bet, has_acted: true })
        .eq("id", currentPlayerId);

    if (player_error) {
      setError(player_error.message);
      return;
    }

      const newPot = game.pot + chipsToCall;
      const { error: pot_error } = await supabase
        .from("games")
        .update({ pot: newPot })
        .eq("id", game.id);

    if (pot_error) {
      setError(pot_error.message);
      return;
    }

      const updatedPlayers = players.map((p) => p.id === currentPlayerId
        ? { ...p, chips: newChipCount, current_bet: game.current_bet, has_acted: true }
        : p);
      await progressToNextPlayer(currentPlayerId, game.current_bet, updatedPlayers);
    } finally {
      actionInFlight.current = false;
    }
  }

  async function fold() {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      const { error } = await supabase
        .from("players")
        .update({ folded: true, has_acted: true })
        .eq("id", currentPlayerId);

      if (error) {
        setError(error.message);
        return;
      }

      const updatedPlayers = players.map((player) => player.id === currentPlayerId
        ? { ...player, folded: true, has_acted: true }
        : player);
      await progressToNextPlayer(currentPlayerId, game.current_bet, updatedPlayers);
    } finally {
      actionInFlight.current = false;
    }
  }

  async function check() {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      const { error } = await supabase
        .from("players")
        .update({ has_acted: true })
        .eq("id", currentPlayerId);

      if (error) {
        setError(error.message);
        return;
      }

      const updatedPlayers = players.map((player) => player.id === currentPlayerId
        ? { ...player, has_acted: true }
        : player);
      await progressToNextPlayer(currentPlayerId, game.current_bet, updatedPlayers);
    } finally {
      actionInFlight.current = false;
    }
  }

  async function raise(raise_amount: number) {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      const currentChipCount = players.find((p) => p.id === currentPlayerId)?.chips ?? 0;
      const newChipCount = currentChipCount - raise_amount;
      const newCurrentBet = game.current_bet + raise_amount;

      const { error: player_error } = await supabase
        .from("players")
        .update({ chips: newChipCount, current_bet: newCurrentBet, has_acted: true })
        .eq("id", currentPlayerId);

      if (player_error) {
        setError(player_error.message);
        return;
      }

      const newPot = game.pot + raise_amount;
      const { error: pot_error } = await supabase
        .from("games")
        .update({ pot: newPot, current_bet: newCurrentBet })
        .eq("id", game.id);

      if (pot_error) {
        setError(pot_error.message);
      }

      const updatedPlayers = players.map((player) => player.id === currentPlayerId
        ? { ...player, chips: newChipCount, current_bet: newCurrentBet, has_acted: true }
        : player);
      await progressToNextPlayer(currentPlayerId, newCurrentBet, updatedPlayers);
    } finally {
      actionInFlight.current = false;
    }
  }

  async function resetGame() {
    if (!game) return;
    
    const { error : gameError } = await supabase
      .from("games")
      .update({ pot: 0, betting_round: 0, current_bet: 0, current_player: game.current_dealer })
      .eq("id", game.id);
    
    if (gameError) {
      setError(gameError.message);
      return;
    }

    // Reset each player's current bet, folded status, and has_acted status
    for (const player of players) {
      const { error: playerError } = await supabase
        .from("players")
        .update({ current_bet: 0, folded: false, has_acted: false })
        .eq("id", player.id);

      if (playerError) {
        setError(playerError.message);
        return;
      }
    }

    // Fetch the actual DB values after awarding the pot.
    const { data: freshPlayers, error: freshPlayersError } = await supabase
      .from("players")
      .select("*")
      .eq("game_id", game.id)
      .order("created_at", { ascending: true });

    if (freshPlayersError || !freshPlayers) {
      setError(freshPlayersError?.message ?? "Could not reload players.");
      return;
    }

    // Keep local state synchronized.
    setPlayers(freshPlayers);

    // Update local copy of the game state
    setGame((prevGame) => prevGame ? { ...prevGame, pot: 0, betting_round: 0, current_bet: 0, current_player: prevGame.current_dealer } : null);
    
    // Update local copy of the players state
    setPlayers((prevPlayers) => prevPlayers.map((p) => ({ ...p, current_bet: 0, folded: false, has_acted: false })));

    if (game.status == "playing") { 
      await startNewHand(false, freshPlayers);
    } 
  }

  async function chooseWinner(winnerId: string) {
    if (!game) return;

    // Only host can choose the winner
    if (currentPlayerId !== game.host) {
      setError("Only the host can choose the winner.");
      return;
    }

    // Do not trust Reacts data, instead fetch the latests values from the DB
    const {data: freshGame, error: freshGameError} = await supabase
      .from("games")
      .select("*")
      .eq("id", game.id)
      .single();

    if (freshGameError || !freshGame) {
      setError(freshGameError?.message ?? "Could not get current game.");
      return;
    }

    const {data: freshWinner, error: freshWinnerError} = await supabase
      .from("players")
      .select("*")
      .eq("id", winnerId)
      .single();

    if (freshWinnerError || !freshWinner) {
      setError(freshWinnerError?.message ?? "Winner not found.");
      return;
    }

    if (freshWinner.folded || !freshWinner.active) {
      setError("Cannot choose a folded or inactive player as the winner.");
      return;
    }

    // Update the winner's chips in the DB
    const newChipCount = freshWinner.chips + freshGame.pot;
    const { error: player_error } = await supabase
      .from("players")
      .update({ chips: newChipCount })
      .eq("id", winnerId);

    if (player_error) {
      setError(player_error.message);
      return;
    }
    // Reset the game for the next round
    await resetGame();
  }
    

  async function removePlayer(playerId: string) {
    if (!window.confirm("Remove this player?")) return;

    const { error } = await supabase
      .from("players")
      .delete()
      .eq("id", playerId);

    if (error) {
      setError(error.message);
    }
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
          <h1>Game not found</h1>
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
        {game.status === "playing"  && isShowdown && isHost && (
          <div className="winner-picker">
            <h2>Choose the winner</h2>
            {playersInHand.map((player) => (
              <button
                key={player.id}
                className="winner-button"
                onClick={() => chooseWinner(player.id)}
              >
                {player.name} ({player.chips.toLocaleString()} chips)
              </button>
            ))}
          </div>
        )}
      </div>

      <section className="players">
        {players.map((player) => {
          const isMe = player.id === currentPlayerId;
          const isCurrentPlayer = player.id === game.current_player;

          return (
            <article
              className={`player ${isMe ? "player-me" : ""}`}
              key={player.id}
            >
              <div className="player-top">
                <div>
                  <div className="player-name">
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
                  disabled={player.chips < game.current_bet}
                >
                  Call {game.current_bet - player.current_bet}
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
                disabled={player.chips < chipAmount}
              >
                Raise by {chipAmount}
              </button>
            </div>
          )}
          {isHost && (
            <button
              className="remove-button"
              onClick={() => removePlayer(player.id)}
            >
            Remove player
            </button>
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