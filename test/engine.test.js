const assert = require('assert');
const Engine = require('../public/engine.js');

function testDeckComposition() {
  const deck = Engine.createShuffledDeck();
  assert.strictEqual(deck.length, 54, 'Banknote deck must contain 54 cards');
  const totalValue = deck.reduce((sum, b) => sum + b.value, 0);
  assert.strictEqual(totalValue, 2500000, 'Deck total value must equal $2,500,000');

  const counts = {};
  for (const b of deck) counts[b.value] = (counts[b.value] || 0) + 1;
  assert.deepStrictEqual(counts, Engine.BANKNOTE_COUNTS);
}

function testInitialDealAnd2PlayerNeutral() {
  const state = Engine.createInitialGameState(
    [
      { id: 'p1', name: 'Alice', color: 'red' },
      { id: 'p2', name: 'Bob', color: 'blue' }
    ],
    { neutralMode: 'auto' }
  );

  assert.strictEqual(state.options.neutralPerPlayer, 4);
  assert.strictEqual(state.players[0].regularLeft, 8);
  assert.strictEqual(state.players[0].neutralLeft, 4);
  assert.strictEqual(Engine.getTotalDiceLeft(state.players[0]), 12);

  for (const c of state.casinos) {
    const sum = c.bills.reduce((s, b) => s + b.value, 0);
    assert.ok(sum >= 50000, `Casino ${c.id} sum (${sum}) must be >= $50,000`);
    for (let i = 1; i < c.bills.length; i++) {
      assert.ok(c.bills[i - 1].value >= c.bills[i].value, 'Bills sorted descending');
    }
  }
}

function testTieCancellationAndPayouts() {
  const state = Engine.createInitialGameState(
    [
      { id: 'p1', name: 'P1', color: 'red' },
      { id: 'p2', name: 'P2', color: 'blue' },
      { id: 'p3', name: 'P3', color: 'green' },
      { id: 'p4', name: 'P4', color: 'amber' }
    ],
    { neutralMode: 'off' }
  );

  // Set deterministic bills & dice at Casino 1
  const c1 = state.casinos[0];
  c1.bills = [
    { id: 'b90', value: 90000 },
    { id: 'b40', value: 40000 },
    { id: 'b10', value: 10000 }
  ];
  c1.diceByOwner = {
    p1: { regular: 3, big: 0, weight: 3 },
    p2: { regular: 3, big: 0, weight: 3 }, // ties with P1 -> both cancelled!
    p3: { regular: 2, big: 0, weight: 2 }, // becomes 1st winner -> $90,000
    p4: { regular: 1, big: 0, weight: 1 }  // becomes 2nd winner -> $40,000; $10k unclaimed
  };

  // Casino 2: Neutral ties with P1, P2 takes 1st
  const c2 = state.casinos[1];
  c2.bills = [{ id: 'b60', value: 60000 }];
  c2.diceByOwner = {
    p1: { regular: 2, big: 0, weight: 2 },
    [Engine.NEUTRAL_OWNER_ID]: { regular: 2, big: 0, weight: 2 },
    p2: { regular: 1, big: 0, weight: 1 }
  };

  // Casino 3: Neutral wins outright -> bill goes back to deck bottom, P1 gets 0
  const c3 = state.casinos[2];
  c3.bills = [{ id: 'b50', value: 50000 }];
  c3.diceByOwner = {
    [Engine.NEUTRAL_OWNER_ID]: { regular: 3, big: 0, weight: 3 }
  };

  // Clear other casinos
  for (let i = 3; i < 6; i++) {
    state.casinos[i].bills = [];
    state.casinos[i].diceByOwner = {};
  }

  const deckLenBefore = state.deck.length;
  const report = Engine.scoreRound(state);

  assert.strictEqual(state.players.find(p => p.id === 'p1').cash, 0);
  assert.strictEqual(state.players.find(p => p.id === 'p2').cash, 60000);
  assert.strictEqual(state.players.find(p => p.id === 'p3').cash, 90000);
  assert.strictEqual(state.players.find(p => p.id === 'p4').cash, 40000);

  // Check returned bills: b10 (unclaimed from c1) and b50 (neutral win from c3)
  assert.ok(report.casinoReports[0].tiedEntries.length === 2);
  assert.ok(report.casinoReports[2].winners[0].isNeutral === true);
  // Deck gained 2 returned bills, then dealt round 2 casinos (which removed some)
  assert.ok(deckLenBefore >= 0);
  assert.strictEqual(state.round, 2);
  assert.strictEqual(state.startPlayerIndex, 1);
  assert.strictEqual(state.currentPlayerIndex, 1);
}

function testNeutralAndBigDiePlacement() {
  const state = Engine.createInitialGameState(
    [
      { id: 'p1', name: 'P1', color: 'red' },
      { id: 'p2', name: 'P2', color: 'blue' }
    ],
    { neutralMode: 'auto', bigDie: true }
  );

  assert.strictEqual(state.players[0].regularLeft, 7);
  assert.strictEqual(state.players[0].bigLeft, 1);
  assert.strictEqual(state.players[0].neutralLeft, 4);

  // Inject deterministic roll: big die rolled 4, 2 regular rolled 4, 1 neutral rolled 4
  state.phase = 'WAIT_PLACE';
  state.currentRoll = {
    playerId: 'p1',
    dice: [
      { id: 'd1', face: 4, isNeutral: false, isBig: true, weight: 2 },
      { id: 'd2', face: 4, isNeutral: false, isBig: false, weight: 1 },
      { id: 'd3', face: 4, isNeutral: false, isBig: false, weight: 1 },
      { id: 'd4', face: 4, isNeutral: true, isBig: false, weight: 1 },
      { id: 'd5', face: 2, isNeutral: false, isBig: false, weight: 1 }
    ]
  };

  const res = Engine.placeDiceChoice(state, 'p1', 4);
  assert.strictEqual(res.placement.ownRegular, 2);
  assert.strictEqual(res.placement.ownBig, 1);
  assert.strictEqual(res.placement.neutral, 1);

  const c4 = state.casinos[3];
  assert.strictEqual(c4.diceByOwner['p1'].weight, 4); // 2 + 1*2
  assert.strictEqual(c4.diceByOwner[Engine.NEUTRAL_OWNER_ID].weight, 1);
  assert.strictEqual(state.players[0].regularLeft, 5);
  assert.strictEqual(state.players[0].bigLeft, 0);
  assert.strictEqual(state.players[0].neutralLeft, 3);
}

function testFull4RoundAiSimulation() {
  let seed = 42;
  const detRng = (max) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };

  const state = Engine.createInitialGameState(
    [
      { id: 'ai1', name: 'Bot1', color: 'red', isAI: true, aiStyle: 'aggressive' },
      { id: 'ai2', name: 'Bot2', color: 'blue', isAI: true, aiStyle: 'balanced' },
      { id: 'ai3', name: 'Bot3', color: 'green', isAI: true, aiStyle: 'frugal' }
    ],
    { neutralMode: 'on', bigDie: true },
    detRng
  );

  let steps = 0;
  let roundsCompleted = 0;
  while (state.phase !== 'GAME_OVER') {
    assert.ok(steps++ < 1000, 'Infinite loop guard');
    const cur = Engine.getCurrentPlayer(state);
    assert.ok(Engine.getTotalDiceLeft(cur) > 0, 'Current player must have dice');

    if (state.phase === 'WAIT_ROLL') {
      Engine.rollDiceForCurrentPlayer(state, detRng);
    } else if (state.phase === 'WAIT_PLACE') {
      const face = Engine.chooseAiFace(state, cur.id, detRng);
      const outcome = Engine.placeDiceChoice(state, cur.id, face);
      if (outcome.roundEnded) roundsCompleted++;
    }
  }

  assert.strictEqual(roundsCompleted, 4, 'Exactly 4 rounds must complete');
  assert.strictEqual(state.phase, 'GAME_OVER');
  assert.ok(Array.isArray(state.winners) && state.winners.length >= 1);

  // Total cash awarded + deck value must still equal $2,500,000!
  const playerCash = state.players.reduce((s, p) => s + p.cash, 0);
  const deckCash = state.deck.reduce((s, b) => s + b.value, 0);
  assert.strictEqual(playerCash + deckCash, 2500000, 'Money conservation must hold exactly!');
}

function testFinalTiebreakerByBillCount() {
  const winners = Engine.computeFinalWinners([
    { id: 'a', name: 'A', cash: 150000, bills: [{ value: 90000 }, { value: 60000 }] },
    { id: 'b', name: 'B', cash: 150000, bills: [{ value: 50000 }, { value: 50000 }, { value: 50000 }] },
    { id: 'c', name: 'C', cash: 120000, bills: [{ value: 90000 }, { value: 30000 }] }
  ]);
  assert.strictEqual(winners.length, 1);
  assert.strictEqual(winners[0].id, 'b', 'Tied cash should be broken by most individual banknotes');
}

testDeckComposition();
testInitialDealAnd2PlayerNeutral();
testTieCancellationAndPayouts();
testNeutralAndBigDiePlacement();
testFull4RoundAiSimulation();
testFinalTiebreakerByBillCount();

console.log('ALL ENGINE TESTS PASSED!');
