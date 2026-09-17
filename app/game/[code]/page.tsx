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
  folded: boolean;

  created_at: string;
};

type Game = {
  id: string;
  code: string;

  pot: number;
  buy_in: number;

  current_dealer: string | null;
  round: number; // Preflop, Flop, Turn, River
  current_bet: number;
  current_player: string | null;

  created_at: string
};


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
  }, [game?.id]);

  async function call() {
    if (!game || !currentPlayerId) return;

    const currentChipCount = players.find((p) => p.id === currentPlayerId)?.chips ?? 0;
    const newChipCount = currentChipCount - game.current_bet;
    
    // Update the player's chips in the DB
    const { error: player_error } = await supabase
      .from("players")
      .update({ chips: newChipCount, current_bet: game.current_bet })
      .eq("id", currentPlayerId);

    if (player_error) {
      setError(player_error.message);
    }

    // Update the pot in the game
    const newPot = game.pot + game.current_bet;
    const { error: pot_error } = await supabase
      .from("games")
      .update({ pot: newPot })
      .eq("id", game.id);

    if (pot_error) {
      setError(pot_error.message);
    }
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
  }

  async function check() {
    if (!game || !currentPlayerId) return;

    // No DB update needed for checking, just move to the next player
    // TODO: make logic for moving to the next player
  }

  async function raise(raise_amount: number) {
    if (!game || !currentPlayerId) return;

    const currentChipCount = players.find((p) => p.id === currentPlayerId)?.chips ?? 0;
    const newChipCount = currentChipCount - raise_amount;

    // Update the player's chips in the DB
    const { error: player_error } = await supabase
      .from("players")
      .update({ chips: newChipCount, current_bet: game.current_bet + raise_amount })
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
  const totalChips = players.reduce((total, player) => total + player.chips,0);

  const currentPlayer = players.find((p) => p.id === currentPlayerId);
  const isMyTurn = currentPlayer?.id === game?.current_player && !currentPlayer?.folded;

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
          <span>Total chips</span>
          <strong>{totalChips.toLocaleString()}</strong>
        </div>

        <div>
          <span>Players</span>
          <strong>{players.length}</strong>
        </div>
      </section>

      <section className="players">
        {players.map((player) => {
          const isMe = player.id === currentPlayerId;

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
                    {isMyTurn && (
                      <span className="player-badge">YOUR TURN</span>
                    )}
                  </div>

                  <div className="chip-count">
                    {player.chips.toLocaleString()}
                  </div>
                </div>

              </div>
            {isMe && (
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

              <button
                className="remove-button"
                onClick={() => removePlayer(player.id)}
              >
                Remove player
              </button>
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