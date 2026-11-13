const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');
const { server, wss } = require('../server.js');
const Engine = require('../public/engine.js');

function waitForMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Timed out waiting for WS message'));
    }, timeoutMs);

    function handler(buf) {
      const msg = JSON.parse(buf.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;

  try {
    // 1. Verify HTTP static & health endpoints
    const homeRes = await httpGet(`${baseUrl}/`);
    assert.strictEqual(homeRes.status, 200);
    assert.ok(homeRes.body.includes('LAS VEGAS'));

    const healthRes = await httpGet(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(JSON.parse(healthRes.body).ok, true);

    // 2. Connect Host & Guest over WebSocket
    const hostWs = new WebSocket(wsUrl);
    const guestWs = new WebSocket(wsUrl);
    await Promise.all([
      new Promise(r => hostWs.once('open', r)),
      new Promise(r => guestWs.once('open', r))
    ]);

    const hostWelcomeP = waitForMessage(hostWs, m => m.type === 'welcome');
    hostWs.send(JSON.stringify({ type: 'create_room', name: 'HostPlayer', color: 'red' }));
    const hostWelcome = await hostWelcomeP;
    const roomCode = hostWelcome.roomCode;
    assert.ok(roomCode && roomCode.length >= 4);

    const guestWelcomeP = waitForMessage(guestWs, m => m.type === 'welcome');
    guestWs.send(JSON.stringify({ type: 'join_room', roomCode, name: 'GuestPlayer', color: 'blue' }));
    const guestWelcome = await guestWelcomeP;
    assert.strictEqual(guestWelcome.room.lobbyPlayers.length, 2);

    // 3. Start game and verify deck hiding anti-cheat
    const hostStateP = waitForMessage(hostWs, m => m.type === 'room_state' && m.room.status === 'PLAYING');
    const guestStateP = waitForMessage(guestWs, m => m.type === 'room_state' && m.room.status === 'PLAYING');
    hostWs.send(JSON.stringify({ type: 'start_game' }));
    let [hostSnap, guestSnap] = await Promise.all([hostStateP, guestStateP]);
    assert.strictEqual(hostSnap.room.game.deck, undefined, 'Deck order must never be exposed to clients');
    assert.strictEqual(typeof hostSnap.room.game.deckCount, 'number');

    // 4. Out-of-turn player trying to roll must receive error
    const errP = waitForMessage(guestWs, m => m.type === 'error');
    guestWs.send(JSON.stringify({ type: 'roll_dice' }));
    const errMsg = await errP;
    assert.ok(errMsg.message.includes('차례'));

    // 5. Play full Round 1 over real WS turns
    let latestRoom = hostSnap.room;
    let roundScoredEvent = null;
    hostWs.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'room_state') latestRoom = m.room;
      if (m.type === 'event' && m.kind === 'round_scored') roundScoredEvent = m;
    });

    let safety = 0;
    while (!roundScoredEvent && safety++ < 60) {
      const g = latestRoom.game;
      const cur = Engine.getCurrentPlayer(g);
      const activeWs = cur.id === hostWelcome.playerId ? hostWs : guestWs;

      const rolledStateP = waitForMessage(activeWs, m => m.type === 'room_state' && m.room.game.phase === 'WAIT_PLACE');
      activeWs.send(JSON.stringify({ type: 'roll_dice' }));
      const rolledSnap = await rolledStateP;

      const faces = Engine.getAvailableFaces(rolledSnap.room.game.currentRoll);
      const placedStateP = waitForMessage(hostWs, m => m.type === 'room_state' && (m.room.game.phase === 'WAIT_ROLL' || m.room.game.phase === 'GAME_OVER'));
      activeWs.send(JSON.stringify({ type: 'place_dice', face: faces[0] }));
      latestRoom = (await placedStateP).room;
    }

    assert.ok(roundScoredEvent, 'Round 1 must finish and emit round_scored event');
    assert.strictEqual(latestRoom.game.round, 2, 'Game should advance to Round 2');

    // 6. Test reconnection with session token
    guestWs.close();
    await new Promise(r => setTimeout(r, 60));
    const reconnWs = new WebSocket(wsUrl);
    await new Promise(r => reconnWs.once('open', r));
    const reconnWelcomeP = waitForMessage(reconnWs, m => m.type === 'welcome');
    reconnWs.send(JSON.stringify({
      type: 'join_room',
      roomCode,
      token: guestWelcome.token,
      name: 'GuestPlayer'
    }));
    const reconnWelcome = await reconnWelcomeP;
    assert.strictEqual(reconnWelcome.playerId, guestWelcome.playerId);
    assert.strictEqual(reconnWelcome.room.status, 'PLAYING');

    hostWs.close();
    reconnWs.close();
    console.log('ALL MULTIPLAYER SERVER TESTS PASSED!');
  } finally {
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.close();
  }
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
