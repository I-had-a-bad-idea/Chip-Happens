"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

const SEAT_COUNT = 10;

function generateGameCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

export default function Home() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [buyIn, setBuyIn] = useState(1000);
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [seatPosition, setSeatPosition] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function createGame() {
    // Check name
    if (!name.trim()) {
      setError("Enter your name first.");
      return;
    }

    setLoading(true);
    setError("");
    // This gamecode can then be used to join the game
    const gameCode = generateGameCode();

    // Create the game with the selected buy-in and blinds
    const { data: game, error: gameError } = await supabase
      .from("games")
      .insert({
        code: gameCode,
        buy_in: buyIn,
        small_blind: smallBlind,
        big_blind: bigBlind
      })
      .select()
      .single();

    // Error handling
    if (gameError || !game) {
      setError(gameError?.message ?? "Could not create game.");
      setLoading(false);
      return;
    }

    // Give the host the selected buy-in
    const { data: player, error: playerError } = await supabase
      .from("players")
      .insert({
        game_id: game.id,
        name: name.trim(),
        seat_position: seatPosition,
        chips: buyIn,
      })
      .select()
      .single();

    // Error handling
    if (playerError || !player) {
      setError(playerError?.message ?? "Could not create player.");
      setLoading(false);
      return;
    }

    // Set the current dealer for the game to the host player and set the current player as the host of the game
    const { error: dealerError } = await supabase
      .from("games")
      .update({ host: player.id, current_dealer: player.id, current_player: player.id }) // TODO: Don't just set the current player to the host
      .eq("id", game.id);

    if (dealerError) {
      setError(dealerError.message ?? "Could not set dealer.");
      setLoading(false);
      return;
    }

    localStorage.setItem(`poker-player-${gameCode}`, player.id);

    // Change to the game tab
    router.push(`/game/${gameCode}`);
  }

  function joinGame() {
    if (!code.trim()) {
      setError("Enter a game code.");
      return;
    }

    router.push(`/join/${code.trim().toUpperCase()}`);
  }

  return (
    <main className="home">
      <div className="home-card">

        <h1>Chip Happens</h1>
        <p className="subtitle">Keep track of everyone&apos;s chips even if you don&apos;t have any physical chips.</p>

        <label>Your name</label>

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex"
          maxLength={20}
        />

        <h2>Create a game</h2>

        <label>Buy-in</label>
        <input
          type="number"
          value={buyIn}
          onChange={(e) => setBuyIn(Number(e.target.value))}
          placeholder="e.g. 1000"
          min="1"
        />
        <label>Small blind</label>
        <input
          type="number"
          value={smallBlind}
          onChange={(e) => setSmallBlind(Number(e.target.value))}
          placeholder="e.g. 10"
          min="1"
        />
        <label>Big blind</label>
        <input
          type="number"
          value={bigBlind}
          onChange={(e) => setBigBlind(Number(e.target.value))}
          placeholder="e.g. 20"
          min="1"
        />

        <label>Your seat</label>
        <select value={seatPosition} onChange={(e) => setSeatPosition(Number(e.target.value))}>
          {Array.from({ length: SEAT_COUNT }, (_, index) => index + 1).map((seat) => (
            <option key={seat} value={seat}>Seat {seat}</option>
          ))}
        </select>

        {error && <div className="error">{error}</div>}

        <button
          className="primary-button"
          onClick={createGame}
          disabled={loading}
        >
          {loading ? "Creating..." : "Create game"}
        </button>

        <div className="divider">
          <span>or join a game</span>
        </div>

        <div className="join-row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="GAME CODE"
            maxLength={4}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                joinGame();
              }
            }}
          />

          <button
            className="secondary-button"
            onClick={joinGame}
            disabled={loading}
          >
            Join
          </button>
        </div>

      </div>
    </main>
  );
}
