"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

function generateGameCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

export default function Home() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
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

    // Add the new game to the DB
    const { data: game, error: gameError } = await supabase
      .from("games")
      .insert({
        code: gameCode,
      })
      .select()
      .single();

    // Error handling
    if (gameError || !game) {
      setError(gameError?.message ?? "Could not create game.");
      setLoading(false);
      return;
    }

    // Add this person as a player 
    const { data: player, error: playerError } = await supabase
      .from("players")
      .insert({
        game_id: game.id,
        name: name.trim(),
        chips: 1000,
      })
      .select()
      .single();

    // Error handling
    if (playerError || !player) {
      setError(playerError?.message ?? "Could not create player.");
      setLoading(false);
      return;
    }

    localStorage.setItem(`poker-player-${gameCode}`, player.id);

    // Change to the game tab
    router.push(`/game/${gameCode}`);
  }
  
  async function joinGame() {
    // Ensure all data exists

    if (!name.trim()) {
      setError("Enter your name first.");
      return;
    }

    if (!code.trim()) {
      setError("Enter a game code.");
      return;
    }

    setLoading(true);
    setError("");

    const gameCode = code.trim().toUpperCase();

    // Query the game
    const { data: game, error: gameError } = await supabase
      .from("games")
      .select("id")
      .eq("code", gameCode)
      .single();

    if (gameError || !game) {
      setError("Game not found.");
      setLoading(false);
      return;
    }

    // Add player to the game
    const { data: player, error: playerError } = await supabase
      .from("players")
      .insert({
        game_id: game.id,
        name: name.trim(),
        chips: 1000,
      })
      .select()
      .single();

    if (playerError || !player) {
      setError(playerError?.message ?? "Could not join game.");
      setLoading(false);
      return;
    }

    localStorage.setItem(`poker-player-${gameCode}`, player.id);

    // Switch to game
    router.push(`/game/${gameCode}`);
  }

  return (
    <main className="home">
      <div className="home-card">
        <div className="logo">♠</div>

        <h1>Stay loose play 72</h1>
        <p className="subtitle">Keep track of everyone's chips even if you don't have any physical chips.</p>

        <label>Your name</label>
        <input value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex" maxLength={20}/>

        {error && <div className="error">{error}</div>}

        <button className="primary-button" onClick={createGame} disabled={loading}>
          {loading ? "Creating..." : "Create game"}
        </button>

        <div className="divider">
          <span>or join a game</span>
        </div>

        <div className="join-row">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="GAME CODE" maxLength={4}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                joinGame();
              }
            }}
          />

          <button className="secondary-button" onClick={joinGame} disabled={loading}>Join</button>
        </div>
      </div>
    </main>
  );
}