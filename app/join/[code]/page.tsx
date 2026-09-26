"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

const SEAT_COUNT = 10;

export default function JoinPage({params,}: {params: Promise<{ code: string }>;}) {
  const router = useRouter();

  const { code } = use(params);

  const [name, setName] = useState("");
  const [seatPosition, setSeatPosition] = useState(1);
  const [occupiedSeats, setOccupiedSeats] = useState<number[]>([]);
  const [loadingSeats, setLoadingSeats] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadOccupiedSeats() {
      const { data: game, error: gameError } = await supabase
        .from("games")
        .select("id")
        .eq("code", code.toUpperCase())
        .single();

      if (gameError || !game) {
        setError("Game not found.");
        setLoadingSeats(false);
        return;
      }

      const { data: players, error: playersError } = await supabase
        .from("players")
        .select("seat_position")
        .eq("game_id", game.id);

      if (playersError) {
        setError(playersError.message);
      } else {
        const seats = (players ?? []).map((player) => player.seat_position);
        setOccupiedSeats(seats);
        const firstOpenSeat = Array.from({ length: SEAT_COUNT }, (_, index) => index + 1)
          .find((seat) => !seats.includes(seat));
        if (firstOpenSeat) setSeatPosition(firstOpenSeat);
      }
      setLoadingSeats(false);
    }

    loadOccupiedSeats();
  }, [code]);

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

    // Get the game
    const { data: game, error: gameError } = await supabase
      .from("games")
      .select("id, buy_in")
      .eq("code", code)
      .single();

    if (gameError || !game) {
      setError("Game not found.");
      setLoading(false);
      return;
    }

    // Give the joining player the game's buy-in
    const { data: player, error: playerError } = await supabase
      .from("players")
      .insert({
        game_id: game.id,
        name: name.trim(),
        chips: game.buy_in,
      })
      .select()
      .single();

    if (playerError || !player) {
      setError(playerError?.message ?? "Could not join game.");
      setLoading(false);
      return;
    }

    localStorage.setItem(`poker-player-${code}`, player.id);

    // Switch to game
    router.push(`/game/${code}`);
  }

  return (
    <main className="home">
      <div className="home-card">

        <h1>Chip Happens</h1>
        <p className="subtitle">Enter your name to join game <strong>{code}</strong>.</p>

        <label>Your name</label>

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex"
          maxLength={20}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") joinGame();
        }}
        />

        <button
        className="primary-button"
        onClick={joinGame}
        disabled={loading}
        >
        {loading ? "Joining..." : "Join game"}
        </button>
      </div>
    </main>
  );
}