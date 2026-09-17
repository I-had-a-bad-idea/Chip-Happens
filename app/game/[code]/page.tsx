"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Player = {
  id: string;
  game_id: string;
  name: string;

  chips: number;
  current_bet: number;
  has_acted: boolean;
  folded: boolean;

  created_at: string;
};

type Game = {
  id: string;
  code: string;

  pot: number;
  buy_in: number;
  host: string | null; // the player ID of the host

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

  async function progressToNextBettingRound() {
    if (!game) return;

    console.log("Progressing to the next betting round. Current round:", game.betting_round);

    const nextBettingRound = game.betting_round + 1;
    
    if (nextBettingRound > BETTING_ROUND_NAMES.length - 1) {
      // TODO: Aks who won the game round and reset the game for the next round
          
      // Update the game state in the DB
      const { error } = await supabase
        .from("games")
        .update({ betting_round: nextBettingRound, current_bet: 0, current_player: null })
        .eq("id", game.id);
      if (error) {
        setError(error.message);
      }
      // Update local copy of the game state
      setGame((prevGame) => prevGame ? { ...prevGame, betting_round: nextBettingRound, current_bet: 0, current_player: null } : null);
    }
    
    // Update the game state in the DB
    const { error } = await supabase
      .from("games")
      .update({ betting_round: nextBettingRound, current_bet: 0 })
      .eq("id", game.id);

    // Update local copy of the game state
    setGame((prevGame) => prevGame ? { ...prevGame, betting_round: nextBettingRound, current_bet: 0 } : null);

    if (error) {
      setError(error.message);
    }

    // Reset current bet for each player
    for (const player of players) {
      const { error: playerError } = await supabase
        .from("players")
        .update({ current_bet: 0 })
        .eq("id", player.id);
      
      // Mark the player as not having acted
      setPlayerHasActed(player.id, false);

      if (playerError) {
        setError(playerError.message);
      }
    }
  }

  async function progressToNextPlayer(currentPlayerId: string, currentBet: number, updatedPlayers: Player[] = players) {
    if (!game || !game.current_player) return;

    console.log("Progressing to the next player. Current player:", game.current_player);

    const activePlayers = updatedPlayers.filter((p) => !p.folded);
    if (activePlayers.length <= 1) {
      progressToNextBettingRound();
      return;
    }
    const currentIndex = activePlayers.findIndex((p) => p.id === currentPlayerId);

    if (currentIndex === -1 ) return;


    // Look for the next active player who has not matched the current bet or still needs to act
    for (let i = 1; i <= activePlayers.length; i++) {
      const nextPlayer = activePlayers[(currentIndex + i) % activePlayers.length];

      if (nextPlayer.current_bet < currentBet || !nextPlayer.has_acted) {
        console.log("Next player to act:", nextPlayer.name);
        console.log("Next player current bet:", nextPlayer.current_bet, "Current bet:", currentBet);
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
    progressToNextBettingRound();
  }

  async function setPlayerHasActed(playerId: string, has_acted: boolean) {
    const { error } = await supabase
      .from("players")
      .update({ has_acted })
      .eq("id", playerId);

    if (error) {
      setError(error.message);
    }
    // Update local copy of the players state
    setPlayers((prevPlayers) => prevPlayers.map((p) => (p.id === playerId ? { ...p, has_acted } : p)));
  }

  async function call() {
    if (!game || !currentPlayerId) return;

    const currentChipCount = players.find((p) => p.id === currentPlayerId)?.chips ?? 0;
    const currentBet = players.find((p) => p.id === currentPlayerId)?.current_bet ?? 0;
    const chipsToCall = game.current_bet - currentBet;
    if (chipsToCall <= 0) return; // No need to call if already matched
    const newChipCount = currentChipCount - chipsToCall;
    
    // Update the player's chips in the DB
    const { error: player_error } = await supabase
      .from("players")
      .update({ chips: newChipCount, current_bet: game.current_bet })
      .eq("id", currentPlayerId);

    if (player_error) {
      setError(player_error.message);
    }

    // Update the pot in the game
    const newPot = game.pot + chipsToCall;
    const { error: pot_error } = await supabase
      .from("games")
      .update({ pot: newPot })
      .eq("id", game.id);

    if (pot_error) {
      setError(pot_error.message);
    }

    // Update our local copy so progressToNextPlayer has the new bet.
    const updatedPlayers = players.map((p) => p.id === currentPlayerId ? { ...p, chips: newChipCount, current_bet: game.current_bet} : p);
    // Mark the player as having acted
    setPlayerHasActed(currentPlayerId, true);
    progressToNextPlayer(currentPlayerId, game.current_bet, updatedPlayers);
  }

  async function fold() {
    if (!game || !currentPlayerId) return;
    
    // Update the player's folded status in the DB
    const { error: player_error } = await supabase
      .from("players")
      .update({ folded: true })
      .eq("id", currentPlayerId);

    if (player_error) {
      setError(player_error.message);
    }

    // Update our local copy so progressToNextPlayer has the new bet.
    const updatedPlayers = players.map((p) => p.id === currentPlayerId ? { ...p, folded: true} : p);
    // Mark the player as having acted
    setPlayerHasActed(currentPlayerId, true);
    progressToNextPlayer(currentPlayerId, game.current_bet, updatedPlayers);
  }

  async function check() {
    if (!game || !currentPlayerId) return;

    // No DB update needed for checking, just move to the next player
    
    // Mark the player as having acted
    setPlayerHasActed(currentPlayerId, true);
    progressToNextPlayer(currentPlayerId, game.current_bet, players);
  }

  async function raise(raise_amount: number) {
    if (!game || !currentPlayerId) return;

    const currentChipCount = players.find((p) => p.id === currentPlayerId)?.chips ?? 0;
    const newChipCount = currentChipCount - raise_amount;
    const newCurrentBet = game.current_bet + raise_amount;

    // Update the player's chips in the DB
    const { error: player_error } = await supabase
      .from("players")
      .update({ chips: newChipCount, current_bet: newCurrentBet })
      .eq("id", currentPlayerId);

    if (player_error) {
      setError(player_error.message);
    }

    // Update the pot and current bet in the game
    const newPot = game.pot + raise_amount ;
    const { error: pot_error } = await supabase
      .from("games")
      .update({ pot: newPot, current_bet: game.current_bet + raise_amount })
      .eq("id", game.id);

    if (pot_error) {
      setError(pot_error.message);
    }

    // Update our local copy so progressToNextPlayer has the new bet.
    const updatedPlayers = players.map((p) => p.id === currentPlayerId ? { ...p, chips: newChipCount, current_bet: newCurrentBet} : p);
    // Mark the player as having acted
    setPlayerHasActed(currentPlayerId, true);
    progressToNextPlayer(currentPlayerId, newCurrentBet, updatedPlayers);
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

    // Update local copy of the game state
    setGame((prevGame) => prevGame ? { ...prevGame, pot: 0, betting_round: 0, current_bet: 0, current_player: prevGame.current_dealer } : null);
    
    // Update local copy of the players state
    setPlayers((prevPlayers) => prevPlayers.map((p) => ({ ...p, current_bet: 0, folded: false, has_acted: false })));
  }

  async function chooseWinner(winnerId: string) {
    if (!game) return;

    // Only host can choose the winner
    if (currentPlayerId !== game.host) {
      setError("Only the host can choose the winner.");
      return;
    }

    // Get the winner
    const winner = players.find((p) => p.id === winnerId);
    if (!winner) {
      setError("Winner not found.");
      return;
    }

    if (winner.folded) {
      setError("Cannot choose a folded player as the winner.");
      return;
    }

    // Update the winner's chips in the DB
    const newChipCount = winner.chips + game.pot;
    const { error: player_error } = await supabase
      .from("players")
      .update({ chips: newChipCount })
      .eq("id", winnerId);

    if (player_error) {
      setError(player_error.message);
      return;
    }
    // Reset the game for the next round

    resetGame();
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
  const pot = game?.pot ?? 0;

  const currentPlayer = players.find((p) => p.id === currentPlayerId);
  const isMyTurn = currentPlayer?.id === game?.current_player && !currentPlayer?.folded;
  const isHost = currentPlayerId === game?.host;
  const isShowdown = game?.betting_round === BETTING_ROUND_NAMES.length - 1;
  const activePlayers = players.filter((p) => !p.folded);

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

          <button className="game-code" onClick={copyCode}>
            {game.code}
          </button>

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

      <div className="winner-selection">
        {isShowdown && isHost && (
          <div className="winner-picker">
            <h2>Choose the winner</h2>
            {activePlayers.map((player) => (
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
                    {(isMe && isMyTurn) && (
                      <span className="player-badge">YOUR TURN</span>
                    )}
                    {(!isMe && isCurrentPlayer) && (
                      <span className="player-badge">Thinking about going all-in...</span>
                    )}
                  </div>

                  <div className="chip-count">
                    {player.chips.toLocaleString()}
                  </div>
                </div>

              </div>
            {(isMe && isMyTurn) &&  (
            <div className="poker-actions">
              <button
                className="fold-button"
                onClick={fold}
              >
                Fold
              </button>

              {game.current_bet === 0 ? (
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
                  Call {game.current_bet}
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
                Raise {chipAmount}
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