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
      const { data: gameData, error: gameError } = await supabase
        .from("games")
        .select("*")
        .eq("code", gameCode)
        .single();

      if (gameError || !gameData) {
        if (gameError?.code === "PGRST116" || !gameError) {
          setError("Game not found.");
        } else {
          setSyncWarning("Connection issue. Retrying sync...");
        }
        setLoading(false);
        return;
      }

      const { data: playerData, error: playerError } = await supabase
        .from("players")
        .select("*")
        .eq("game_id", gameData.id)
        .order("seat_position", { ascending: true });

      setGame(gameData);
      if (playerError) {
        setSyncWarning("Connection issue. Retrying sync...");
      } else {
        setPlayers(playerData ?? []);
        setSyncWarning("");
      }

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
      .update({chips: smallBlindPlayer.chips - smallBlindAmount, current_bet: smallBlindAmount, total_contribution: smallBlindPlayer.total_contribution + smallBlindAmount})
      .eq("id", smallBlindPlayer.id);

    if (smallBlindError) {
      setError(smallBlindError.message);
      return;
    }

    const { error: bigBlindError } = await supabase
      .from("players")
      .update({chips: bigBlindPlayer.chips - bigBlindAmount, current_bet: bigBlindAmount, total_contribution: bigBlindPlayer.total_contribution + bigBlindAmount})
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

  async function progressToNextBettingRound(playersForRound: Player[] = players) {
    if (!game) return;

    const activePlayers = playersForRound.filter((p) => p.active);

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
      for (let i = 1; i <= activePlayers.length; i++) {
        const player = activePlayers[(dealerIndex + i) % activePlayers.length];

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

  async function skipToShowdown() {
    if (!game) return;
    setPotWinnerSelections({});

    const {error} = await supabase
      .from("games")
      .update({betting_round: BETTING_ROUND_NAMES.length - 1, current_player: null})
      .eq("id", game.id);

    if (error) {
      setError(error.message);
      return;
    }
    setGame((prevGame) => prevGame ? {...prevGame, betting_round: BETTING_ROUND_NAMES.length - 1, current_player: null,} : null);
  }

  async function progressToNextPlayer(currentPlayerId: string, currentBet: number, updatedPlayers: Player[] = players) {
    if (!game) return;

    const activePlayers = updatedPlayers.filter((p) => p.active);
    const playersInHand = activePlayers.filter((p) => !p.folded);
    if (playersInHand.length === 1) {
      // Switch to showdown so host can select the last player as the winner
      await skipToShowdown();
      return;
    }
    // Use active players, since the current player might have folded
    const currentIndex = activePlayers.findIndex((p) => p.id === currentPlayerId);

    if (currentIndex === -1 ) {
      setError("Could not find the current player")
      return;
    }

    const playersWhoCanAct = playersInHand.filter((p) => (!p.all_in && p.active && !p.folded));
    if (playersWhoCanAct.length === 0) {
      await skipToShowdown();
      return;
    }

    // Look for the next player who can act (and has not matched the current bet or still needs to act)
    for (let i = 1; i <= activePlayers.length; i++) {
      const nextPlayer = activePlayers[(currentIndex + i) % activePlayers.length];

      // if player is all-in, folded or inactive he is just skipped
      if (nextPlayer.all_in || !nextPlayer.active || nextPlayer.folded) {
        continue;
      }
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
    await progressToNextBettingRound(updatedPlayers);
  }

  async function call() {
    if (!game || !currentPlayerId || !isMyTurn || actionInFlight.current) return;
    actionInFlight.current = true;

    try {
      const currentChipCount = players.find((p) => p.id === currentPlayerId)?.chips ?? 0;
      const currentBet = players.find((p) => p.id === currentPlayerId)?.current_bet ?? 0;
      let chipsToCall = game.current_bet - currentBet;
      if (chipsToCall <= 0) return;
      
      let allIn = false
      if (chipsToCall >= currentChipCount) {
        chipsToCall = currentChipCount; // dont allow calling to go beyond what the player has  
        allIn = true;
      }
      const newChipCount = currentChipCount - chipsToCall;

    
      // Update the player's chips in the DB
      const { error: player_error } = await supabase
        .from("players")
        .update({ chips: newChipCount, current_bet: currentBet + chipsToCall,
          has_acted: true,
          all_in: allIn,
          total_contribution: currentPlayer.total_contribution + chipsToCall})
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

  async function togglePlayerActive(playerId: string) {
    if (!isHost) return;

    const player = players.find((p) => p.id === playerId);
    if (!player) return;

    // Dont allow changing participation during an active hand.
    if (game?.status === "playing" && !isShowdown) {
      setError("Players can only be made inactive between hands.");
      return;
    }

    const { error } = await supabase
      .from("players")
      .update({active: !player.active,})
      .eq("id", playerId);

    if (error) {
      setError(error.message);
      return;
    }
    // update local players
    setPlayers((prevPlayers) => prevPlayers.map((p) => p.id === playerId ? { ...p, active: !p.active } : p));
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
      const currentBet = players.find((p) => p.id === currentPlayerId)?.current_bet ?? 0;
      const chipsToMatch = game.current_bet - currentBet;

      const newChipCount = currentChipCount - chipsToMatch - raise_amount;
      const newCurrentBet = game.current_bet + raise_amount;
      const newTotalContribution = currentBet + chipsToMatch + raise_amount;

      const allIn = newChipCount === 0;

      const { error: player_error } = await supabase
        .from("players")
        .update({ chips: newChipCount, current_bet: newCurrentBet, has_acted: true, total_contribution: newTotalContribution, all_in: allIn })
        .eq("id", currentPlayerId);

      if (player_error) {
        setError(player_error.message);
        return;
      }

      const newPot = game.pot + chipsToMatch + raise_amount;
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

    // Reset each player's current bet, folded status, all-in status, total_contribution and has_acted status
    for (const player of players) {
      const { error: playerError } = await supabase
        .from("players")
        .update({ current_bet: 0, folded: false, has_acted: false, total_contribution: 0, all_in: false})
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
      .order("seat_position", { ascending: true });

    if (freshPlayersError || !freshPlayers) {
      setError(freshPlayersError?.message ?? "Could not reload players.");
      return;
    }

    // Keep local state synchronized.
    setPlayers(freshPlayers);

    // Update local copy of the game state
    setGame((prevGame) => prevGame ? { ...prevGame, pot: 0, betting_round: 0, current_bet: 0, current_player: prevGame.current_dealer } : null);
    
    // Update local copy of the players state
    setPlayers((prevPlayers) => prevPlayers.map((p) => ({ ...p, current_bet: 0, folded: false, has_acted: false, all_in: false })));

    if (game.status == "playing") { 
      await startNewHand(false, freshPlayers);
    } 
  }

  function buildPots(players: Player[]): Pot[] {
    const contributions = players
      .map((p) => ({id: p.id, contributed: p.total_contribution, folded: p.folded}))
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
      const eligiblePlayers = contributors.filter((p) => !p.folded).map((p) => p.id);
      
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

     // Do not trust Reacts data, instead fetch the latests values from the DB
    const { data: freshPlayers, error: freshPlayersError } = await supabase
      .from("players")
      .select("*")
      .eq("game_id", game.id)
      .order("seat_position", { ascending: true });

    if (freshPlayersError || !freshPlayers) {
      setError(freshPlayersError?.message ?? "Could not load players for the pot payout.");
      return;
    }

    const pots = buildPots(freshPlayers);

    if (pots.length === 0) {
      await resetGame();
      return;
    }

    for (let potIndex = 0; potIndex < pots.length; potIndex++) {
      const pot = pots[potIndex];
      const winnerIds = potWinnerSelections[potIndex] ?? [];

      if (winnerIds.length === 0 || winnerIds.some((winnerId) => !pot.eligiblePlayerIds.includes(winnerId))) {
        setError(`Select at least one winner for pot ${potIndex + 1}.`);
        return;
      }

      const winners = winnerIds
        .map((winnerId) => freshPlayers.find((player) => player.id === winnerId))
        .filter((winner): winner is Player => Boolean(winner));

      if (winners.length !== winnerIds.length || winners.some((winner) => winner.folded || !winner.active)) {
        setError("Cannot award a pot to a folded or inactive player.");
        return;
      }

      const chipsPerWinner = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount % winners.length;

      winners.sort((a, b) => a.seat_position - b.seat_position);
      for (const [winnerIndex, winner] of winners.entries()) {
        const playerIndex = freshPlayers.findIndex((player) => player.id === winner.id);
        const updatedChipCount = winner.chips + chipsPerWinner + (winnerIndex < remainder ? 1 : 0);

        const { error: playerError } = await supabase
          .from("players")
          .update({ chips: updatedChipCount })
          .eq("id", winner.id);

        if (playerError) {
          setError(playerError.message);
          return;
        }

        freshPlayers[playerIndex] = { ...freshPlayers[playerIndex], chips: updatedChipCount };
      }
    }
    // Reset the game for the next round
    await resetGame();
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