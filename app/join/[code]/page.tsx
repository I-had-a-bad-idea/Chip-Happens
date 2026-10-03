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
      const { data: seats, error: seatsError } = await supabase.rpc("get_join_seats", {
        p_code: code.toUpperCase(),
      });

      if (seatsError || !seats) {
        setError(seatsError?.message ?? "Game not found.");
      } else {
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

    // Join the game
    const { data: playerId, error: playerError } = await supabase.rpc("join_game", {
      p_code: code.toUpperCase(),
      p_name: name.trim(),
      p_seat_position: seatPosition,
    });

    if (playerError || !playerId) {
      if (playerError?.message.includes("seat")) {
        setOccupiedSeats((seats) => seats.includes(seatPosition) ? seats : [...seats, seatPosition]);
      }
      setError(playerError?.message ?? "Could not join game.");
      setLoading(false);
      return;
    }

    localStorage.setItem(`poker-player-${code.toUpperCase()}`, playerId);

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

        <label>Your seat</label>
        <select
          value={seatPosition}
          onChange={(e) => setSeatPosition(Number(e.target.value))}
          disabled={loadingSeats || loading}
        >
          {Array.from({ length: SEAT_COUNT }, (_, index) => index + 1).map((seat) => (
            <option key={seat} value={seat} disabled={occupiedSeats.includes(seat)}>
              Seat {seat}{occupiedSeats.includes(seat) ? " (taken)" : ""}
            </option>
          ))}
        </select>

        {error && <div className="error">{error}</div>}

        <button
        className="primary-button"
        onClick={joinGame}
        disabled={loading || loadingSeats || occupiedSeats.length >= SEAT_COUNT}
        >
        {loading ? "Joining..." : "Join game"}
        </button>
      </div>
    </main>
  );
}