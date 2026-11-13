const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const Engine = require('./public/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const AI_ROSTER = [
  { name: '아리아 (AI)', style: 'aggressive' },
  { name: '마르코 (AI)', style: 'balanced' },
  { name: '루나 (AI)', style: 'frugal' },
  { name: '비니 (AI)', style: 'aggressive' }
];

const app = express();
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    uptimeSec: Math.round(process.uptime())
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** @type {Map<string, object>} */
const rooms = new Map();

function secureRng(maxExclusive) {
  return crypto.randomInt(0, maxExclusive);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function makeId(prefix = 'p') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function sanitizeName(raw, fallback = '플레이어') {
  const str = String(raw || '').trim().slice(0, 16);
  return str || fallback;
}

function pickAvailableColor(room, preferred) {
  const used = new Set(room.lobbyPlayers.map(p => p.color));
  if (preferred && Engine.PLAYER_COLORS[preferred] && !used.has(preferred)) {
    return preferred;
  }
  return Engine.COLOR_ORDER.find(c => !used.has(c)) || Engine.COLOR_ORDER[0];
}

function sanitizeGameState(state) {
  if (!state) return null;
  return {
    round: state.round,
    totalRounds: state.totalRounds,
    options: state.options,
    deckCount: state.deck.length,
    players: state.players,
    startPlayerIndex: state.startPlayerIndex,
    currentPlayerIndex: state.currentPlayerIndex,
    phase: state.phase,
    casinos: state.casinos,
    currentRoll: state.currentRoll,
    lastRoundReport: state.lastRoundReport,
    winners: state.winners,
    log: state.log
  };
}

function getRoomSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status, // 'LOBBY' | 'PLAYING'
    options: room.options,
    lobbyPlayers: room.lobbyPlayers.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isAI: p.isAI,
      aiStyle: p.aiStyle,
      ready: p.ready,
      connected: p.isAI ? true : p.connected
    })),
    game: sanitizeGameState(room.game),
    roundTransitionUntil: room.roundTransitionUntil,
    turnDeadline: room.turnDeadline
  };
}

function sendJson(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastRoom(room, msg) {
  const raw = JSON.stringify(msg);
  for (const client of room.clients.values()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

function broadcastState(room) {
  broadcastRoom(room, { type: 'room_state', room: getRoomSnapshot(room) });
}

function clearRoomTimers(room) {
  if (room.aiTimer) {
    clearTimeout(room.aiTimer);
    room.aiTimer = null;
  }
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.transitionTimer) {
    clearTimeout(room.transitionTimer);
    room.transitionTimer = null;
  }
}

function scheduleNextStep(room) {
  clearRoomTimers(room);
  room.turnDeadline = 0;

  if (!room.game || room.status !== 'PLAYING' || room.game.phase === 'GAME_OVER') {
    return;
  }

  const now = Date.now();
  if (room.roundTransitionUntil > now) {
    const delay = room.roundTransitionUntil - now;
    room.transitionTimer = setTimeout(() => {
      room.roundTransitionUntil = 0;
      broadcastState(room);
      scheduleNextStep(room);
    }, delay);
    return;
  }

  const cur = Engine.getCurrentPlayer(room.game);
  if (!cur) return;

  if (cur.isAI) {
    if (room.game.phase === 'WAIT_ROLL') {
      room.aiTimer = setTimeout(() => {
        if (!room.game || room.game.phase !== 'WAIT_ROLL') return;
        const roll = Engine.rollDiceForCurrentPlayer(room.game, secureRng);
        broadcastRoom(room, { type: 'event', kind: 'dice_rolled', payload: { playerId: cur.id, roll } });
        broadcastState(room);
        scheduleNextStep(room);
      }, 650);
    } else if (room.game.phase === 'WAIT_PLACE') {
      room.aiTimer = setTimeout(() => {
        if (!room.game || room.game.phase !== 'WAIT_PLACE') return;
        const face = Engine.chooseAiFace(room.game, cur.id, secureRng);
        executePlaceDice(room, cur.id, face);
      }, 950);
    }
  } else if (room.options.turnTimerSec > 0) {
    const sec = room.options.turnTimerSec;
    room.turnDeadline = Date.now() + sec * 1000;
    broadcastState(room);
    room.turnTimer = setTimeout(() => {
      if (!room.game || room.status !== 'PLAYING') return;
      const active = Engine.getCurrentPlayer(room.game);
      if (!active || active.id !== cur.id) return;
      if (room.game.phase === 'WAIT_ROLL') {
        const roll = Engine.rollDiceForCurrentPlayer(room.game, secureRng);
        broadcastRoom(room, { type: 'event', kind: 'dice_rolled', payload: { playerId: active.id, roll, auto: true } });
        const face = Engine.chooseAiFace(room.game, active.id, secureRng);
        executePlaceDice(room, active.id, face, true);
      } else if (room.game.phase === 'WAIT_PLACE') {
        const face = Engine.chooseAiFace(room.game, active.id, secureRng);
        executePlaceDice(room, active.id, face, true);
      }
    }, sec * 1000);
  }
}

function executePlaceDice(room, playerId, face, isAuto = false) {
  const outcome = Engine.placeDiceChoice(room.game, playerId, face);
  broadcastRoom(room, {
    type: 'event',
    kind: 'dice_placed',
    payload: { placement: outcome.placement, auto: isAuto }
  });

  if (outcome.roundEnded) {
    // Allow 5.2s for clients to enjoy the animated Casino 1->6 payout ceremony
    room.roundTransitionUntil = Date.now() + 5200;
    broadcastRoom(room, {
      type: 'event',
      kind: 'round_scored',
      payload: {
        roundReport: outcome.roundReport,
        gameOver: room.game.phase === 'GAME_OVER'
      }
    });
  }

  if (room.game.phase === 'GAME_OVER') {
    room.turnDeadline = 0;
    broadcastRoom(room, {
      type: 'event',
      kind: 'game_over',
      payload: { winners: room.game.winners }
    });
  }

  broadcastState(room);
  scheduleNextStep(room);
}

function cleanupStaleRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const connectedHumans = room.lobbyPlayers.filter(p => !p.isAI && p.connected).length;
    if (connectedHumans === 0 && now - room.lastActivityAt > 10 * 60 * 1000) {
      clearRoomTimers(room);
      rooms.delete(code);
    }
  }
}
setInterval(cleanupStaleRooms, 60 * 1000);

function detachSocketFromRoom(ws) {
  const { roomCode, playerId } = ws.meta || {};
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  room.clients.delete(playerId);

  const lp = room.lobbyPlayers.find(p => p.id === playerId);
  if (lp) {
    lp.connected = false;
  }

  // Reassign host if needed in lobby
  if (room.hostId === playerId) {
    const nextHost = room.lobbyPlayers.find(p => !p.isAI && p.connected);
    if (nextHost) {
      room.hostId = nextHost.id;
    }
  }

  // If still in lobby and player actually clicked leave, removal happens in leave handler;
  // on sudden disconnect, keep seat briefly or notify state
  room.lastActivityAt = Date.now();
  broadcastState(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.meta = { roomCode: null, playerId: null };

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (rawBuf) => {
    let msg;
    try {
      msg = JSON.parse(rawBuf.toString());
    } catch {
      return sendJson(ws, { type: 'error', message: '잘못된 메시지 형식입니다.' });
    }

    const type = msg.type;
    try {
      if (type === 'create_room') {
        detachSocketFromRoom(ws);
        const code = generateRoomCode();
        const playerId = makeId('p');
        const token = makeId('tok');
        const name = sanitizeName(msg.name, '호스트');
        const color = Engine.PLAYER_COLORS[msg.color] ? msg.color : 'red';
        const opts = msg.options || {};

        const room = {
          code,
          hostId: playerId,
          status: 'LOBBY',
          options: {
            neutralMode: ['auto', 'on', 'off'].includes(opts.neutralMode) ? opts.neutralMode : 'auto',
            bigDie: Boolean(opts.bigDie),
            turnTimerSec: [0, 30, 45, 60].includes(Number(opts.turnTimerSec)) ? Number(opts.turnTimerSec) : 0
          },
          lobbyPlayers: [
            {
              id: playerId,
              token,
              name,
              color,
              isAI: false,
              ready: true,
              connected: true
            }
          ],
          clients: new Map([[playerId, ws]]),
          game: null,
          roundTransitionUntil: 0,
          turnDeadline: 0,
          aiTimer: null,
          turnTimer: null,
          transitionTimer: null,
          lastActivityAt: Date.now()
        };

        rooms.set(code, room);
        ws.meta = { roomCode: code, playerId };
        sendJson(ws, {
          type: 'welcome',
          playerId,
          token,
          roomCode: code,
          room: getRoomSnapshot(room)
        });
        return;
      }

      if (type === 'join_room') {
        const code = String(msg.roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          return sendJson(ws, { type: 'error', message: `방 코드 [${code}]를 찾을 수 없습니다.` });
        }
        room.lastActivityAt = Date.now();

        // Check reconnection via token
        if (msg.token) {
          const existing = room.lobbyPlayers.find(p => !p.isAI && p.token === msg.token);
          if (existing) {
            detachSocketFromRoom(ws);
            existing.connected = true;
            if (msg.name) existing.name = sanitizeName(msg.name, existing.name);
            room.clients.set(existing.id, ws);
            ws.meta = { roomCode: code, playerId: existing.id };
            sendJson(ws, {
              type: 'welcome',
              playerId: existing.id,
              token: existing.token,
              roomCode: code,
              room: getRoomSnapshot(room)
            });
            broadcastState(room);
            return;
          }
        }

        if (room.status !== 'LOBBY') {
          return sendJson(ws, { type: 'error', message: '이미 게임이 진행 중인 방입니다.' });
        }
        if (room.lobbyPlayers.length >= 5) {
          return sendJson(ws, { type: 'error', message: '방 인원이 가득 찼습니다 (최대 5명).' });
        }

        detachSocketFromRoom(ws);
        const playerId = makeId('p');
        const token = makeId('tok');
        const name = sanitizeName(msg.name, `게스트 ${room.lobbyPlayers.length + 1}`);
        const color = pickAvailableColor(room, msg.color);

        room.lobbyPlayers.push({
          id: playerId,
          token,
          name,
          color,
          isAI: false,
          ready: true,
          connected: true
        });
        room.clients.set(playerId, ws);
        ws.meta = { roomCode: code, playerId };

        sendJson(ws, {
          type: 'welcome',
          playerId,
          token,
          roomCode: code,
          room: getRoomSnapshot(room)
        });
        broadcastState(room);
        return;
      }

      // All remaining actions require active room membership
      const { roomCode, playerId } = ws.meta;
      const room = rooms.get(roomCode);
      if (!room) {
        return sendJson(ws, { type: 'error', message: '방에 연결되어 있지 않습니다.' });
      }
      room.lastActivityAt = Date.now();

      if (type === 'leave_room') {
        room.clients.delete(playerId);
        if (room.status === 'LOBBY') {
          room.lobbyPlayers = room.lobbyPlayers.filter(p => p.id !== playerId);
          if (room.hostId === playerId) {
            const nextHost = room.lobbyPlayers.find(p => !p.isAI);
            room.hostId = nextHost ? nextHost.id : null;
          }
          if (room.lobbyPlayers.filter(p => !p.isAI).length === 0) {
            clearRoomTimers(room);
            rooms.delete(room.code);
          } else {
            broadcastState(room);
          }
        } else {
          const lp = room.lobbyPlayers.find(p => p.id === playerId);
          if (lp) lp.connected = false;
          broadcastState(room);
        }
        ws.meta = { roomCode: null, playerId: null };
        return;
      }

      if (type === 'update_options') {
        if (room.hostId !== playerId || room.status !== 'LOBBY') return;
        const opts = msg.options || {};
        if (['auto', 'on', 'off'].includes(opts.neutralMode)) room.options.neutralMode = opts.neutralMode;
        if (typeof opts.bigDie === 'boolean') room.options.bigDie = opts.bigDie;
        if ([0, 30, 45, 60].includes(Number(opts.turnTimerSec))) room.options.turnTimerSec = Number(opts.turnTimerSec);
        broadcastState(room);
        return;
      }

      if (type === 'change_color') {
        if (room.status !== 'LOBBY') return;
        const requested = msg.color;
        if (!Engine.PLAYER_COLORS[requested]) return;
        const takenByOther = room.lobbyPlayers.some(p => p.id !== playerId && p.color === requested);
        if (takenByOther) {
          return sendJson(ws, { type: 'error', message: '이미 다른 플레이어가 선택한 색상입니다.' });
        }
        const me = room.lobbyPlayers.find(p => p.id === playerId);
        if (me) {
          me.color = requested;
          broadcastState(room);
        }
        return;
      }

      if (type === 'toggle_ready') {
        if (room.status !== 'LOBBY') return;
        const me = room.lobbyPlayers.find(p => p.id === playerId);
        if (me) {
          me.ready = !me.ready;
          broadcastState(room);
        }
        return;
      }

      if (type === 'add_ai') {
        if (room.hostId !== playerId || room.status !== 'LOBBY') return;
        if (room.lobbyPlayers.length >= 5) {
          return sendJson(ws, { type: 'error', message: '최대 5명까지만 참여할 수 있습니다.' });
        }
        const usedNames = new Set(room.lobbyPlayers.map(p => p.name));
        const candidate = AI_ROSTER.find(a => !usedNames.has(a.name)) || {
          name: `딜러 ${room.lobbyPlayers.length + 1} (AI)`,
          style: 'balanced'
        };
        room.lobbyPlayers.push({
          id: makeId('ai'),
          token: null,
          name: candidate.name,
          color: pickAvailableColor(room),
          isAI: true,
          aiStyle: candidate.style,
          ready: true,
          connected: true
        });
        broadcastState(room);
        return;
      }

      if (type === 'remove_player') {
        if (room.hostId !== playerId || room.status !== 'LOBBY') return;
        const targetId = msg.targetId;
        if (targetId === playerId) return;
        const targetSocket = room.clients.get(targetId);
        if (targetSocket) {
          sendJson(targetSocket, { type: 'error', message: '호스트에 의해 방에서 내보내졌습니다.' });
          targetSocket.meta = { roomCode: null, playerId: null };
          room.clients.delete(targetId);
        }
        room.lobbyPlayers = room.lobbyPlayers.filter(p => p.id !== targetId);
        broadcastState(room);
        return;
      }

      if (type === 'start_game') {
        if (room.hostId !== playerId) return;
        if (room.lobbyPlayers.length < 2) {
          return sendJson(ws, { type: 'error', message: '최소 2명 이상이어야 게임을 시작할 수 있습니다.' });
        }
        const unready = room.lobbyPlayers.find(p => !p.isAI && p.id !== room.hostId && !p.ready);
        if (unready) {
          return sendJson(ws, { type: 'error', message: `${unready.name}님이 아직 준비하지 않았습니다.` });
        }
        room.status = 'PLAYING';
        room.roundTransitionUntil = 0;
        room.game = Engine.createInitialGameState(room.lobbyPlayers, room.options, secureRng);
        broadcastRoom(room, { type: 'event', kind: 'game_started', payload: {} });
        broadcastState(room);
        scheduleNextStep(room);
        return;
      }

      if (type === 'roll_dice') {
        if (room.status !== 'PLAYING' || !room.game) return;
        if (Date.now() < room.roundTransitionUntil) {
          return sendJson(ws, { type: 'error', message: '라운드 정산 연출 중입니다.' });
        }
        const cur = Engine.getCurrentPlayer(room.game);
        if (!cur || cur.id !== playerId) {
          return sendJson(ws, { type: 'error', message: '당신의 차례가 아닙니다.' });
        }
        const roll = Engine.rollDiceForCurrentPlayer(room.game, secureRng);
        broadcastRoom(room, { type: 'event', kind: 'dice_rolled', payload: { playerId, roll } });
        broadcastState(room);
        return;
      }

      if (type === 'place_dice') {
        if (room.status !== 'PLAYING' || !room.game) return;
        if (Date.now() < room.roundTransitionUntil) return;
        const cur = Engine.getCurrentPlayer(room.game);
        if (!cur || cur.id !== playerId) {
          return sendJson(ws, { type: 'error', message: '당신의 차례가 아닙니다.' });
        }
        executePlaceDice(room, playerId, msg.face);
        return;
      }

      if (type === 'skip_round_pause') {
        if (room.hostId !== playerId) return;
        if (room.roundTransitionUntil > Date.now()) {
          room.roundTransitionUntil = 0;
          broadcastState(room);
          scheduleNextStep(room);
        }
        return;
      }

      if (type === 'convert_to_ai') {
        if (room.hostId !== playerId || room.status !== 'PLAYING' || !room.game) return;
        const targetId = msg.targetId;
        const gp = room.game.players.find(p => p.id === targetId);
        const lp = room.lobbyPlayers.find(p => p.id === targetId);
        if (gp && lp && !gp.isAI) {
          gp.isAI = true;
          gp.name = gp.name.includes('(AI)') ? gp.name : `${gp.name} (AI)`;
          lp.isAI = true;
          lp.name = gp.name;
          broadcastState(room);
          scheduleNextStep(room);
        }
        return;
      }

      if (type === 'restart_game') {
        if (room.hostId !== playerId) return;
        clearRoomTimers(room);
        room.status = 'LOBBY';
        room.game = null;
        room.roundTransitionUntil = 0;
        room.turnDeadline = 0;
        for (const p of room.lobbyPlayers) {
          p.ready = p.isAI || p.id === room.hostId;
        }
        broadcastState(room);
        return;
      }

      if (type === 'chat') {
        const text = String(msg.text || '').trim().slice(0, 120);
        if (!text) return;
        const sender = room.lobbyPlayers.find(p => p.id === playerId);
        if (!sender) return;
        broadcastRoom(room, {
          type: 'event',
          kind: 'chat',
          payload: {
            playerId,
            name: sender.name,
            color: sender.color,
            text,
            ts: Date.now()
          }
        });
        return;
      }

      if (type === 'emote') {
        const sender = room.lobbyPlayers.find(p => p.id === playerId);
        if (!sender) return;
        const allowed = ['🍀', '🍸', '🔥', '😱', '💰', '😎', '👏', '🎲'];
        const emote = allowed.includes(msg.emote) ? msg.emote : '🎲';
        broadcastRoom(room, {
          type: 'event',
          kind: 'emote',
          payload: {
            playerId,
            name: sender.name,
            color: sender.color,
            emote
          }
        });
        return;
      }
    } catch (err) {
      sendJson(ws, { type: 'error', message: err.message || '요청 처리 중 오류가 발생했습니다.' });
    }
  });

  ws.on('close', () => {
    detachSocketFromRoom(ws);
  });
});

// Keep-alive ping interval for cloud reverse proxies
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

wss.on('close', () => clearInterval(heartbeatInterval));

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`🎰 Las Vegas Lounge server running at http://localhost:${PORT}`);
  });
}

module.exports = { app, server, wss, rooms };
