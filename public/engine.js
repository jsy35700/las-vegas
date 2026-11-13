(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LasVegasEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOTAL_ROUNDS = 4;
  const DICE_PER_PLAYER = 8;
  const NEUTRAL_OWNER_ID = '__neutral__';

  const CASINO_META = [
    { id: 1, name: 'GOLDEN NUGGET', kr: '골든 너겟', subtitle: 'Downtown Classic', color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.45)' },
    { id: 2, name: 'VELVET MIRAGE', kr: '벨벳 미라지', subtitle: 'Emerald Lounge', color: '#10b981', glow: 'rgba(16, 185, 129, 0.45)' },
    { id: 3, name: 'NEON FLAMINGO', kr: '네온 플라밍고', subtitle: 'Sunset Strip', color: '#ec4899', glow: 'rgba(236, 72, 153, 0.45)' },
    { id: 4, name: 'ROYAL SAPPHIRE', kr: '로얄 사파이어', subtitle: 'High Limit Suite', color: '#06b6d4', glow: 'rgba(6, 182, 212, 0.45)' },
    { id: 5, name: 'CRIMSON PALACE', kr: '크림슨 팰리스', subtitle: 'Monte Carlo Bar', color: '#ef4444', glow: 'rgba(239, 68, 68, 0.45)' },
    { id: 6, name: 'STARDUST VIP', kr: '스타더스트 VIP', subtitle: 'Penthouse Salon', color: '#a855f7', glow: 'rgba(168, 85, 247, 0.45)' }
  ];

  const PLAYER_COLORS = {
    red: { id: 'red', name: '루비 레드', hex: '#ef4444', dark: '#991b1b', light: '#fca5a5', glow: 'rgba(239, 68, 68, 0.5)' },
    blue: { id: 'blue', name: '사파이어 블루', hex: '#3b82f6', dark: '#1e40af', light: '#93c5fd', glow: 'rgba(59, 130, 246, 0.5)' },
    green: { id: 'green', name: '에메랄드 그린', hex: '#22c55e', dark: '#166534', light: '#86efac', glow: 'rgba(34, 197, 94, 0.5)' },
    amber: { id: 'amber', name: '임페리얼 골드', hex: '#f59e0b', dark: '#92400e', light: '#fcd34d', glow: 'rgba(245, 158, 11, 0.5)' },
    purple: { id: 'purple', name: '로얄 바이올렛', hex: '#a855f7', dark: '#6b21a8', light: '#d8b4fe', glow: 'rgba(168, 85, 247, 0.5)' }
  };

  const NEUTRAL_COLOR = {
    id: 'neutral',
    name: '하우스 (중립)',
    hex: '#e2e8f0',
    dark: '#64748b',
    light: '#ffffff',
    glow: 'rgba(226, 232, 240, 0.45)'
  };

  const COLOR_ORDER = ['red', 'blue', 'green', 'amber', 'purple'];

  // Official 54-banknote distribution ($2,500,000 total)
  const BANKNOTE_COUNTS = {
    10000: 6,
    20000: 8,
    30000: 8,
    40000: 6,
    50000: 6,
    60000: 5,
    70000: 5,
    80000: 5,
    90000: 5
  };

  function defaultRng(maxExclusive) {
    return Math.floor(Math.random() * maxExclusive);
  }

  function shuffleArray(arr, rng = defaultRng) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = rng(i + 1);
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function createShuffledDeck(rng = defaultRng) {
    const deck = [];
    let seq = 1;
    for (const [valStr, count] of Object.entries(BANKNOTE_COUNTS)) {
      const value = Number(valStr);
      for (let i = 0; i < count; i++) {
        deck.push({ id: `bill_${seq++}`, value });
      }
    }
    return shuffleArray(deck, rng);
  }

  function getNeutralDicePerPlayer(playerCount, neutralMode = 'auto') {
    if (playerCount >= 5) return 0;
    if (playerCount === 2) {
      return neutralMode === 'off' ? 0 : 4;
    }
    // 3 or 4 players: optional variant (2 neutral dice each)
    return neutralMode === 'on' ? 2 : 0;
  }

  function createEmptyCasinos() {
    return CASINO_META.map(meta => ({
      id: meta.id,
      bills: [],
      diceByOwner: {}
    }));
  }

  function dealCasinosForRound(state) {
    for (const casino of state.casinos) {
      casino.bills = [];
      casino.diceByOwner = {};
      let total = 0;
      while (total < 50000 && state.deck.length > 0) {
        const card = state.deck.shift();
        casino.bills.push(card);
        total += card.value;
      }
      casino.bills.sort((a, b) => b.value - a.value);
    }
  }

  function replenishPlayerDice(player, options) {
    const regularCount = options.bigDie ? DICE_PER_PLAYER - 1 : DICE_PER_PLAYER;
    const bigCount = options.bigDie ? 1 : 0;
    player.regularLeft = regularCount;
    player.bigLeft = bigCount;
    player.neutralLeft = options.neutralPerPlayer || 0;
  }

  function cloneCasinoSnapshot(casinos) {
    return casinos.map(c => ({
      id: c.id,
      bills: c.bills.map(b => ({ ...b })),
      diceByOwner: JSON.parse(JSON.stringify(c.diceByOwner))
    }));
  }

  function createInitialGameState(playersConfig, rawOptions = {}, rng = defaultRng) {
    if (!Array.isArray(playersConfig) || playersConfig.length < 2 || playersConfig.length > 5) {
      throw new Error('플레이어 수는 2~5명이어야 합니다.');
    }

    const neutralPerPlayer = getNeutralDicePerPlayer(
      playersConfig.length,
      rawOptions.neutralMode || 'auto'
    );

    const options = {
      neutralMode: rawOptions.neutralMode || 'auto',
      neutralPerPlayer,
      bigDie: Boolean(rawOptions.bigDie),
      turnTimerSec: Number(rawOptions.turnTimerSec) || 0
    };

    const usedColors = new Set();
    const players = playersConfig.map((cfg, idx) => {
      let color = cfg.color && PLAYER_COLORS[cfg.color] && !usedColors.has(cfg.color)
        ? cfg.color
        : COLOR_ORDER.find(c => !usedColors.has(c));
      usedColors.add(color);

      const p = {
        id: cfg.id,
        name: cfg.name,
        color,
        isAI: Boolean(cfg.isAI),
        aiStyle: cfg.aiStyle || 'balanced',
        seatIndex: idx,
        regularLeft: 0,
        bigLeft: 0,
        neutralLeft: 0,
        cash: 0,
        bills: [],
        stats: {
          tiesCaused: 0,
          casinosWon: 0,
          biggestBill: 0
        }
      };
      replenishPlayerDice(p, options);
      return p;
    });

    const state = {
      round: 1,
      totalRounds: TOTAL_ROUNDS,
      options,
      deck: createShuffledDeck(rng),
      players,
      startPlayerIndex: 0,
      currentPlayerIndex: 0,
      phase: 'WAIT_ROLL',
      casinos: createEmptyCasinos(),
      currentRoll: null,
      lastRoundReport: null,
      winners: null,
      log: []
    };

    dealCasinosForRound(state);
    state.log.push({
      type: 'round_start',
      round: 1,
      text: `라운드 1 시작! 선 플레이어: ${players[0].name}`
    });

    return state;
  }

  function getTotalDiceLeft(player) {
    return (player.regularLeft || 0) + (player.bigLeft || 0) + (player.neutralLeft || 0);
  }

  function getCurrentPlayer(state) {
    return state.players[state.currentPlayerIndex] || null;
  }

  function rollDiceForCurrentPlayer(state, rng = defaultRng) {
    if (state.phase !== 'WAIT_ROLL') {
      throw new Error('현재 주사위를 굴릴 수 있는 단계가 아닙니다.');
    }
    const player = getCurrentPlayer(state);
    if (!player || getTotalDiceLeft(player) <= 0) {
      throw new Error('남은 주사위가 없습니다.');
    }

    const dice = [];
    let dieSeq = 1;
    for (let i = 0; i < player.regularLeft; i++) {
      dice.push({
        id: `d_${dieSeq++}`,
        face: rng(6) + 1,
        isNeutral: false,
        isBig: false,
        weight: 1
      });
    }
    for (let i = 0; i < player.bigLeft; i++) {
      dice.push({
        id: `d_${dieSeq++}`,
        face: rng(6) + 1,
        isNeutral: false,
        isBig: true,
        weight: 2
      });
    }
    for (let i = 0; i < player.neutralLeft; i++) {
      dice.push({
        id: `d_${dieSeq++}`,
        face: rng(6) + 1,
        isNeutral: true,
        isBig: false,
        weight: 1
      });
    }

    state.currentRoll = {
      playerId: player.id,
      dice
    };
    state.phase = 'WAIT_PLACE';
    return state.currentRoll;
  }

  function getAvailableFaces(currentRoll) {
    if (!currentRoll || !Array.isArray(currentRoll.dice)) return [];
    const set = new Set();
    for (const d of currentRoll.dice) {
      set.add(d.face);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  function addDiceToOwnerSlot(casino, ownerId, regularDelta, bigDelta) {
    if (!casino.diceByOwner[ownerId]) {
      casino.diceByOwner[ownerId] = { regular: 0, big: 0, weight: 0 };
    }
    const slot = casino.diceByOwner[ownerId];
    slot.regular += regularDelta;
    slot.big += bigDelta;
    slot.weight = slot.regular + slot.big * 2;
  }

  /**
   * Evaluates standings & projected payouts for a single casino using official Las Vegas rules:
   * - Equal total dice weights cancel each other out (even Neutral House).
   * - Remaining unique weights rank descending: 1st gets highest bill, 2nd gets 2nd highest, etc.
   */
  function evaluateCasinoStandings(casino, players) {
    const playerMap = new Map(players.map(p => [p.id, p]));
    const entries = [];
    for (const [ownerId, slot] of Object.entries(casino.diceByOwner)) {
      if (!slot || slot.weight <= 0) continue;
      const isNeutral = ownerId === NEUTRAL_OWNER_ID;
      const player = isNeutral ? null : playerMap.get(ownerId);
      entries.push({
        ownerId,
        isNeutral,
        name: isNeutral ? '하우스(중립)' : (player ? player.name : ownerId),
        color: isNeutral ? 'neutral' : (player ? player.color : 'red'),
        regular: slot.regular,
        big: slot.big,
        weight: slot.weight
      });
    }

    const weightFreq = new Map();
    for (const entry of entries) {
      weightFreq.set(entry.weight, (weightFreq.get(entry.weight) || 0) + 1);
    }

    const tiedEntries = entries
      .filter(e => weightFreq.get(e.weight) > 1)
      .sort((a, b) => b.weight - a.weight)
      .map(e => ({ ...e, status: 'TIED', rank: null, bill: null }));

    const eligibleEntries = entries
      .filter(e => weightFreq.get(e.weight) === 1)
      .sort((a, b) => b.weight - a.weight);

    const billsSorted = casino.bills.slice().sort((a, b) => b.value - a.value);
    const winners = [];
    const missedOut = [];

    eligibleEntries.forEach((entry, idx) => {
      if (idx < billsSorted.length) {
        winners.push({
          ...entry,
          status: entry.isNeutral ? 'HOUSE_WIN' : 'WIN',
          rank: idx + 1,
          bill: billsSorted[idx]
        });
      } else {
        missedOut.push({
          ...entry,
          status: 'NO_BILL',
          rank: idx + 1,
          bill: null
        });
      }
    });

    const unclaimedBills = billsSorted.slice(winners.length);

    return {
      casinoId: casino.id,
      totalPool: billsSorted.reduce((s, b) => s + b.value, 0),
      bills: billsSorted,
      entries,
      tiedEntries,
      winners,
      missedOut,
      unclaimedBills
    };
  }

  function scoreRound(state) {
    const preSnapshot = cloneCasinoSnapshot(state.casinos);
    const playerMap = new Map(state.players.map(p => [p.id, p]));
    const casinoReports = [];
    const returnedBills = [];

    for (const casino of state.casinos) {
      const evalResult = evaluateCasinoStandings(casino, state.players);
      casinoReports.push(evalResult);

      // Update tie stats for players involved in ties
      for (const tied of evalResult.tiedEntries) {
        if (!tied.isNeutral) {
          const p = playerMap.get(tied.ownerId);
          if (p) p.stats.tiesCaused += 1;
        }
      }

      // Pay winners or return neutral-won bills to deck bottom
      for (const win of evalResult.winners) {
        if (win.isNeutral) {
          returnedBills.push(win.bill);
        } else {
          const p = playerMap.get(win.ownerId);
          if (p) {
            p.cash += win.bill.value;
            p.bills.push(win.bill);
            p.stats.casinosWon += 1;
            if (win.bill.value > p.stats.biggestBill) {
              p.stats.biggestBill = win.bill.value;
            }
          }
        }
      }

      for (const bill of evalResult.unclaimedBills) {
        returnedBills.push(bill);
      }
    }

    // Place unclaimed & neutral-won bills at the bottom of the banknote deck
    for (const bill of returnedBills) {
      state.deck.push(bill);
    }

    const roundReport = {
      round: state.round,
      preCasinos: preSnapshot,
      casinoReports,
      standingsAfter: state.players
        .map(p => ({ id: p.id, name: p.name, color: p.color, cash: p.cash, billCount: p.bills.length }))
        .sort((a, b) => b.cash - a.cash || b.billCount - a.billCount)
    };
    state.lastRoundReport = roundReport;

    // Check game end vs next round
    if (state.round >= state.totalRounds) {
      state.casinos = createEmptyCasinos();
      state.phase = 'GAME_OVER';
      state.winners = computeFinalWinners(state.players);
      state.log.push({
        type: 'game_over',
        round: state.round,
        text: `게임 종료! 최종 우승: ${state.winners.map(w => w.name).join(', ')}`
      });
    } else {
      state.round += 1;
      state.startPlayerIndex = (state.round - 1) % state.players.length;
      state.currentPlayerIndex = state.startPlayerIndex;
      for (const p of state.players) {
        replenishPlayerDice(p, state.options);
      }
      dealCasinosForRound(state);
      state.phase = 'WAIT_ROLL';
      state.log.push({
        type: 'round_start',
        round: state.round,
        text: `라운드 ${state.round} 시작! 선 플레이어: ${state.players[state.startPlayerIndex].name}`
      });
    }

    return roundReport;
  }

  function computeFinalWinners(players) {
    const sorted = players.slice().sort((a, b) => {
      if (b.cash !== a.cash) return b.cash - a.cash;
      return b.bills.length - a.bills.length;
    });
    if (sorted.length === 0) return [];
    const top = sorted[0];
    return sorted.filter(p => p.cash === top.cash && p.bills.length === top.bills.length);
  }

  function placeDiceChoice(state, playerId, face) {
    if (state.phase !== 'WAIT_PLACE' || !state.currentRoll) {
      throw new Error('현재 주사위를 배치할 수 있는 단계가 아닙니다.');
    }
    const player = getCurrentPlayer(state);
    if (!player || player.id !== playerId || state.currentRoll.playerId !== playerId) {
      throw new Error('현재 차례인 플레이어가 아닙니다.');
    }

    const faceNum = Number(face);
    if (!Number.isInteger(faceNum) || faceNum < 1 || faceNum > 6) {
      throw new Error('유효하지 않은 카지노 번호입니다.');
    }

    const matching = state.currentRoll.dice.filter(d => d.face === faceNum);
    if (matching.length === 0) {
      throw new Error('굴린 주사위 중에 해당 숫자가 없습니다.');
    }

    let ownReg = 0;
    let ownBig = 0;
    let neutralReg = 0;

    for (const d of matching) {
      if (d.isNeutral) {
        neutralReg += 1;
      } else if (d.isBig) {
        ownBig += 1;
      } else {
        ownReg += 1;
      }
    }

    player.regularLeft -= ownReg;
    player.bigLeft -= ownBig;
    player.neutralLeft -= neutralReg;

    const casino = state.casinos[faceNum - 1];
    if (ownReg > 0 || ownBig > 0) {
      addDiceToOwnerSlot(casino, player.id, ownReg, ownBig);
    }
    if (neutralReg > 0) {
      addDiceToOwnerSlot(casino, NEUTRAL_OWNER_ID, neutralReg, 0);
    }

    const placementInfo = {
      playerId: player.id,
      playerName: player.name,
      playerColor: player.color,
      casinoId: faceNum,
      ownRegular: ownReg,
      ownBig: ownBig,
      neutral: neutralReg,
      totalWeightAdded: ownReg + ownBig * 2 + neutralReg
    };

    const parts = [];
    if (ownReg > 0) parts.push(`내 주사위 ${ownReg}개`);
    if (ownBig > 0) parts.push(`왕주사위 ${ownBig}개(x2)`);
    if (neutralReg > 0) parts.push(`중립 주사위 ${neutralReg}개`);

    state.log.push({
      type: 'place',
      round: state.round,
      playerId: player.id,
      casinoId: faceNum,
      text: `${player.name} → ${faceNum}번 카지노에 ${parts.join(' + ')} 배치`
    });
    if (state.log.length > 40) state.log.shift();

    state.currentRoll = null;

    // Find next player clockwise who still has dice left
    let nextIdx = -1;
    for (let offset = 1; offset <= state.players.length; offset++) {
      const idx = (state.currentPlayerIndex + offset) % state.players.length;
      if (getTotalDiceLeft(state.players[idx]) > 0) {
        nextIdx = idx;
        break;
      }
    }

    let roundReport = null;
    if (nextIdx === -1) {
      roundReport = scoreRound(state);
    } else {
      state.currentPlayerIndex = nextIdx;
      state.phase = 'WAIT_ROLL';
    }

    return {
      placement: placementInfo,
      roundEnded: roundReport !== null,
      roundReport
    };
  }

  /**
   * Projects what happens at a specific casino if `playerId` places the matching dice from `currentRoll`.
   * Used by both UI hover hints and the AI strategy engine!
   */
  function projectCasinoOutcome(casino, players, currentRoll, playerId) {
    const clonedCasino = {
      id: casino.id,
      bills: casino.bills.slice(),
      diceByOwner: JSON.parse(JSON.stringify(casino.diceByOwner))
    };

    let ownReg = 0;
    let ownBig = 0;
    let neutralReg = 0;
    for (const d of currentRoll.dice) {
      if (d.face !== casino.id) continue;
      if (d.isNeutral) neutralReg += 1;
      else if (d.isBig) ownBig += 1;
      else ownReg += 1;
    }

    if (ownReg > 0 || ownBig > 0) {
      addDiceToOwnerSlot(clonedCasino, playerId, ownReg, ownBig);
    }
    if (neutralReg > 0) {
      addDiceToOwnerSlot(clonedCasino, NEUTRAL_OWNER_ID, neutralReg, 0);
    }

    return {
      before: evaluateCasinoStandings(casino, players),
      after: evaluateCasinoStandings(clonedCasino, players),
      ownReg,
      ownBig,
      neutralReg
    };
  }

  function getRewardForOwner(standings, ownerId) {
    const win = standings.winners.find(w => w.ownerId === ownerId);
    return win ? win.bill.value : 0;
  }

  function chooseAiFace(state, playerId, rng = defaultRng) {
    const faces = getAvailableFaces(state.currentRoll);
    if (faces.length === 0) {
      throw new Error('AI가 선택할 수 있는 주사위가 없습니다.');
    }
    if (faces.length === 1) return faces[0];

    const me = state.players.find(p => p.id === playerId);
    const totalLeft = getTotalDiceLeft(me);
    const opponents = state.players.filter(p => p.id !== playerId);
    const topOpponentCash = Math.max(0, ...opponents.map(o => o.cash));
    const maxOpponentId = opponents.slice().sort((a, b) => b.cash - a.cash)[0]?.id;

    let bestFace = faces[0];
    let bestScore = -Infinity;

    for (const face of faces) {
      const casino = state.casinos[face - 1];
      const { before, after, ownReg, ownBig, neutralReg } = projectCasinoOutcome(
        casino,
        state.players,
        state.currentRoll,
        playerId
      );

      const myBefore = getRewardForOwner(before, playerId);
      const myAfter = getRewardForOwner(after, playerId);
      const myGain = myAfter - myBefore;

      // Net opponent delta (sabotage value, especially against cash leader)
      let oppDelta = 0;
      for (const opp of opponents) {
        const bVal = getRewardForOwner(before, opp.id);
        const aVal = getRewardForOwner(after, opp.id);
        const weight = opp.id === maxOpponentId && opp.cash >= topOpponentCash ? 1.25 : 0.85;
        oppDelta += (bVal - aVal) * weight;
      }

      // Penalty if Neutral House wins a bill that wasn't hurting the leader
      const houseBefore = getRewardForOwner(before, NEUTRAL_OWNER_ID);
      const houseAfter = getRewardForOwner(after, NEUTRAL_OWNER_ID);
      const housePenalty = Math.max(0, houseAfter - houseBefore) * 0.35;

      // Penalty if placing creates a self-tie (we lose a big chunk of dice into a tie)
      const isSelfTiedAfter = after.tiedEntries.some(t => t.ownerId === playerId);
      const tiePenalty = isSelfTiedAfter && myGain <= 0 ? 11000 : 0;

      // Dice efficiency penalty (prefer not burning 4 dice early on a small pot)
      const ownWeightAdded = ownReg + ownBig * 2;
      const stageFactor = totalLeft > 5 ? 4200 : 2200;
      const efficiencyPenalty = ownWeightAdded * stageFactor;

      // Future contest bonus if we gained significant presence even without winning right now
      const myEntryAfter = after.entries.find(e => e.ownerId === playerId);
      const contestBonus = myEntryAfter && !isSelfTiedAfter ? myEntryAfter.weight * 2600 : 0;

      // Slight personality flavor
      let styleBias = 0;
      if (me.aiStyle === 'aggressive') {
        styleBias = oppDelta * 0.35 + (after.bills[0]?.value >= 70000 ? 6000 : 0);
      } else if (me.aiStyle === 'frugal') {
        styleBias = -ownWeightAdded * 1800;
      }

      const jitter = (rng(6000) - 3000);
      const score = myGain * 1.45 + oppDelta * 0.75 + contestBonus + styleBias - housePenalty - tiePenalty - efficiencyPenalty + jitter;

      if (score > bestScore) {
        bestScore = score;
        bestFace = face;
      }
    }

    return bestFace;
  }

  function formatMoney(amount) {
    return '$' + Number(amount || 0).toLocaleString('en-US');
  }

  return {
    TOTAL_ROUNDS,
    DICE_PER_PLAYER,
    NEUTRAL_OWNER_ID,
    CASINO_META,
    PLAYER_COLORS,
    NEUTRAL_COLOR,
    COLOR_ORDER,
    BANKNOTE_COUNTS,
    createShuffledDeck,
    getNeutralDicePerPlayer,
    createInitialGameState,
    getTotalDiceLeft,
    getCurrentPlayer,
    rollDiceForCurrentPlayer,
    getAvailableFaces,
    evaluateCasinoStandings,
    projectCasinoOutcome,
    placeDiceChoice,
    scoreRound,
    computeFinalWinners,
    chooseAiFace,
    formatMoney
  };
});
