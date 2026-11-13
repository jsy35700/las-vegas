(function () {
  'use strict';

  const Engine = window.LasVegasEngine;
  const Audio = window.CasinoAudio;
  const Fx = window.CasinoFx;

  const AI_BOT_NAMES = [
    { name: '아리아 (AI)', style: 'aggressive' },
    { name: '마르코 (AI)', style: 'balanced' },
    { name: '루나 (AI)', style: 'frugal' },
    { name: '비니 (AI)', style: 'aggressive' }
  ];

  const PIP_CELLS = {
    1: [5],
    2: [1, 9],
    3: [3, 5, 7],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
  };

  const state = {
    mode: 'none', // 'none' | 'online' | 'solo' | 'pass'
    selectedColor: 'red',
    ws: null,
    wsConnected: false,
    wsUrl: '',
    myPlayerId: null,
    myToken: null,
    onlineRoom: null,
    localGame: null,
    localMyId: null,
    aiTimers: [],
    turnTimerRaf: null,
    isSettling: false,
    settlingCasinos: null,
    settlementTimers: [],
    settlementText: '',
    hoveredFace: null,
    rollAnimId: null,
    unreadChat: 0,
    prevTurnPlayerId: null,
    prevPhase: null
  };

  // --- DOM Cache ---
  const $ = (id) => document.getElementById(id);

  function init() {
    Fx.init($('fx-canvas'));
    renderHomeColorPicker();
    bindEvents();
    setupDefaultWsConnection();

    // Check URL ?room=CODE invite link
    const params = new URLSearchParams(window.location.search);
    const inviteCode = (params.get('room') || '').trim().toUpperCase();
    if (inviteCode) {
      $('input-room-code').value = inviteCode;
      showToast(`초대 코드 [${inviteCode}]가 입력되었습니다. '입장' 버튼을 누르세요!`);
    }
  }

  function unlockAudioOnce() {
    Audio.unlockAndStartBgm();
  }

  // --- Screen & Modal Helpers ---
  function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    $(screenId).classList.add('active');

    const inGame = screenId === 'screen-game';
    const inActiveSession = screenId === 'screen-lobby' || inGame;
    $('topbar-center').classList.toggle('hidden', !inGame);
    $('btn-leave-game').classList.toggle('hidden', !inActiveSession);
    $('mode-pill').classList.toggle('hidden', !inActiveSession);

    if (!inGame) {
      $('game-drawer').classList.remove('open');
      $('modal-gameover').classList.add('hidden');
    }
  }

  function showToast(message, isError = false) {
    const container = $('toast-container');
    const el = document.createElement('div');
    el.className = 'toast-msg' + (isError ? ' error' : '');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }, 3000);
  }

  // --- Home Color Picker ---
  function renderHomeColorPicker() {
    const wrap = $('home-color-picker');
    wrap.innerHTML = '';
    for (const colorKey of Engine.COLOR_ORDER) {
      const c = Engine.PLAYER_COLORS[colorKey];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch-btn' + (state.selectedColor === colorKey ? ' selected' : '');
      btn.style.background = c.hex;
      btn.style.color = c.hex;
      btn.title = c.name;
      btn.addEventListener('click', () => {
        unlockAudioOnce();
        state.selectedColor = colorKey;
        renderHomeColorPicker();
      });
      wrap.appendChild(btn);
    }
  }

  // --- WebSocket Connection (Online Multiplayer) ---
  function getDefaultWsUrl() {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${window.location.host}`;
    }
    return '';
  }

  function setupDefaultWsConnection() {
    const defaultUrl = getDefaultWsUrl();
    if (!defaultUrl) {
      setWsBadge(false, 'HTML 단독 모드 (서버 미연결)');
      $('server-url-details').open = false;
      return;
    }
    $('input-ws-url').value = defaultUrl;
    connectWebSocket(defaultUrl);
  }

  function setWsBadge(connected, label) {
    const badge = $('ws-status-badge');
    badge.textContent = label;
    badge.classList.toggle('offline', !connected);
  }

  function connectWebSocket(url) {
    if (!url) {
      showToast('연결할 WebSocket 서버 주소(ws:// 또는 wss://)를 입력하세요.', true);
      return;
    }
    if (state.ws) {
      try { state.ws.close(); } catch {}
    }
    state.wsUrl = url;
    setWsBadge(false, '서버 연결 중...');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      setWsBadge(false, '연결 실패 (주소 확인)');
      return;
    }
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.wsConnected = true;
      setWsBadge(true, '● 라이브 멀티플레이 서버 연결됨');

      // Auto-rejoin if this tab already had a session token
      const saved = getSavedSession();
      const params = new URLSearchParams(window.location.search);
      const urlRoom = (params.get('room') || '').trim().toUpperCase();
      if (saved && saved.roomCode && saved.token && (!urlRoom || urlRoom === saved.roomCode)) {
        sendWs({
          type: 'join_room',
          roomCode: saved.roomCode,
          token: saved.token,
          name: $('input-nickname').value.trim()
        });
      }
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleWsMessage(msg);
    });

    ws.addEventListener('close', () => {
      state.wsConnected = false;
      if (window.location.protocol === 'file:') {
        setWsBadge(false, 'HTML 단독 모드 (오프라인 가능)');
      } else {
        setWsBadge(false, '서버 연결 끊김 · 재시도 가능');
      }
    });

    ws.addEventListener('error', () => {
      state.wsConnected = false;
      setWsBadge(false, '서버 미연결 (오프라인 모드는 정상 작동)');
    });
  }

  function sendWs(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      showToast('온라인 서버에 연결되어 있지 않습니다. 서버 실행 후 접속하거나 오프라인 모드를 이용하세요!', true);
      return false;
    }
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  function saveSession(roomCode, playerId, token) {
    try {
      sessionStorage.setItem('vegas_session', JSON.stringify({ roomCode, playerId, token }));
    } catch {}
  }

  function getSavedSession() {
    try {
      const raw = sessionStorage.getItem('vegas_session');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearSavedSession() {
    try { sessionStorage.removeItem('vegas_session'); } catch {}
  }

  function handleWsMessage(msg) {
    if (msg.type === 'error') {
      showToast(msg.message, true);
      return;
    }

    if (msg.type === 'welcome') {
      state.mode = 'online';
      state.myPlayerId = msg.playerId;
      state.myToken = msg.token;
      state.onlineRoom = msg.room;
      saveSession(msg.roomCode, msg.playerId, msg.token);
      $('mode-pill').textContent = `ONLINE · ${msg.roomCode}`;
      syncOnlineRoomView();
      return;
    }

    if (msg.type === 'room_state') {
      if (state.mode !== 'online') return;
      state.onlineRoom = msg.room;
      syncOnlineRoomView();
      return;
    }

    if (msg.type === 'event') {
      handleServerEvent(msg.kind, msg.payload);
    }
  }

  function handleServerEvent(kind, payload) {
    if (kind === 'game_started') {
      Audio.playRoundStart();
      $('game-log-feed').innerHTML = '';
      showToast('🎲 라스베가스 테이블이 오픈되었습니다!');
    } else if (kind === 'dice_rolled') {
      abortSettlementIfActive();
      state.rollAnimId = Date.now();
      Audio.playDiceRoll(payload.roll?.dice?.length || 5);
    } else if (kind === 'dice_placed') {
      abortSettlementIfActive();
      const p = payload.placement;
      if (p) {
        Audio.playDicePlace(p.casinoId, p.totalWeightAdded);
        const casinoEl = document.querySelector(`.casino-card[data-casino-id="${p.casinoId}"]`);
        const colorHex = Engine.PLAYER_COLORS[p.playerColor]?.hex || '#f5c451';
        Fx.animateDiceFlight($('dice-pit'), casinoEl, colorHex, p.totalWeightAdded);
      }
    } else if (kind === 'round_scored') {
      runRoundSettlementCeremony(payload.roundReport, payload.gameOver);
    } else if (kind === 'chat') {
      appendChatMessage(payload);
    } else if (kind === 'emote') {
      Audio.playEmote();
      spawnEmoteToast(payload);
    }
  }

  function syncOnlineRoomView() {
    const room = state.onlineRoom;
    if (!room) return;
    if (room.status === 'LOBBY') {
      clearSettlementTimers();
      state.isSettling = false;
      showScreen('screen-lobby');
      renderLobby(room);
    } else if (room.status === 'PLAYING' && room.game) {
      showScreen('screen-game');
      renderGame(room.game);
    }
  }

  // --- Lobby Rendering ---
  function renderLobby(room) {
    const isHost = room.hostId === state.myPlayerId;
    $('lobby-room-code').textContent = room.code;
    $('lobby-count').textContent = room.lobbyPlayers.length;

    $('btn-lobby-add-ai').classList.toggle('hidden', !isHost || room.lobbyPlayers.length >= 5);
    $('btn-lobby-start').classList.toggle('hidden', !isHost);
    $('btn-lobby-ready').classList.toggle('hidden', isHost);

    const me = room.lobbyPlayers.find(p => p.id === state.myPlayerId);
    if (me && !isHost) {
      $('btn-lobby-ready').textContent = me.ready ? '준비 취소' : '준비 완료!';
      $('btn-lobby-ready').classList.toggle('btn-gold', !me.ready);
      $('btn-lobby-ready').classList.toggle('btn-outline', me.ready);
    }

    const listEl = $('lobby-player-list');
    listEl.innerHTML = '';

    const takenColors = new Set(room.lobbyPlayers.map(p => p.color));

    for (const p of room.lobbyPlayers) {
      const row = document.createElement('div');
      row.className = 'lobby-player-row';
      const cInfo = Engine.PLAYER_COLORS[p.color] || Engine.PLAYER_COLORS.red;

      const left = document.createElement('div');
      left.className = 'lobby-player-info';
      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = cInfo.hex;
      dot.style.color = cInfo.hex;

      const nameSpan = document.createElement('strong');
      nameSpan.textContent = p.name + (p.id === state.myPlayerId ? ' (나)' : '');

      left.append(dot, nameSpan);

      if (p.id === room.hostId) {
        const badge = document.createElement('span');
        badge.className = 'seat-tag me';
        badge.textContent = '👑 호스트';
        left.appendChild(badge);
      } else if (p.isAI) {
        const badge = document.createElement('span');
        badge.className = 'seat-tag';
        badge.textContent = '🤖 AI';
        left.appendChild(badge);
      }

      const right = document.createElement('div');
      right.className = 'lobby-player-actions';

      // Allow local user to change color in lobby
      if (p.id === state.myPlayerId) {
        const swatches = document.createElement('div');
        swatches.className = 'color-swatches';
        for (const ck of Engine.COLOR_ORDER) {
          const sw = document.createElement('button');
          sw.type = 'button';
          sw.className = 'swatch-btn' + (p.color === ck ? ' selected' : '');
          sw.style.width = '20px';
          sw.style.height = '20px';
          sw.style.background = Engine.PLAYER_COLORS[ck].hex;
          sw.style.color = Engine.PLAYER_COLORS[ck].hex;
          sw.disabled = takenColors.has(ck) && p.color !== ck;
          sw.addEventListener('click', () => sendWs({ type: 'change_color', color: ck }));
          swatches.appendChild(sw);
        }
        right.appendChild(swatches);
      }

      const statusPill = document.createElement('span');
      statusPill.className = 'seat-tag ' + (p.ready ? 'me' : '');
      statusPill.textContent = p.id === room.hostId ? '호스트' : (p.ready ? '준비 완료' : '대기 중');
      right.appendChild(statusPill);

      if (isHost && p.id !== state.myPlayerId) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn btn-sm btn-outline';
        kickBtn.textContent = '제외';
        kickBtn.addEventListener('click', () => sendWs({ type: 'remove_player', targetId: p.id }));
        right.appendChild(kickBtn);
      }

      row.append(left, right);
      listEl.appendChild(row);
    }

    // Sync options controls
    const optNeutral = $('lobby-opt-neutral');
    const optTimer = $('lobby-opt-timer');
    const optBigDie = $('lobby-opt-bigdie');
    optNeutral.value = room.options.neutralMode;
    optTimer.value = String(room.options.turnTimerSec || 0);
    optBigDie.checked = Boolean(room.options.bigDie);
    optNeutral.disabled = !isHost;
    optTimer.disabled = !isHost;
    optBigDie.disabled = !isHost;
  }

  // --- Offline Local Modes (Solo vs AI & Pass-and-Play) ---
  function clearLocalTimers() {
    while (state.aiTimers.length > 0) {
      clearTimeout(state.aiTimers.pop());
    }
  }

  function startSoloGame() {
    unlockAudioOnce();
    clearLocalTimers();
    clearSettlementTimers();
    state.isSettling = false;
    state.mode = 'solo';

    const nick = $('input-nickname').value.trim() || '하이롤러';
    const aiCount = Number($('solo-ai-count').value) || 3;
    const neutralMode = $('solo-neutral-mode').value;
    const bigDie = $('solo-big-die').checked;

    const usedColors = new Set([state.selectedColor]);
    const players = [{ id: 'human_1', name: nick, color: state.selectedColor, isAI: false }];

    for (let i = 0; i < aiCount; i++) {
      const bot = AI_BOT_NAMES[i] || { name: `딜러 ${i + 1} (AI)`, style: 'balanced' };
      const c = Engine.COLOR_ORDER.find(col => !usedColors.has(col));
      usedColors.add(c);
      players.push({
        id: `ai_${i + 1}`,
        name: bot.name,
        color: c,
        isAI: true,
        aiStyle: bot.style
      });
    }

    state.localMyId = 'human_1';
    state.localGame = Engine.createInitialGameState(players, { neutralMode, bigDie });
    $('mode-pill').textContent = `SOLO vs AI (${players.length}인)`;
    $('game-log-feed').innerHTML = '';
    Audio.playRoundStart();
    showScreen('screen-game');
    renderGame(state.localGame);
    driveLocalAiIfNeeded();
  }

  function startPassAndPlayGame() {
    unlockAudioOnce();
    clearLocalTimers();
    clearSettlementTimers();
    state.isSettling = false;
    state.mode = 'pass';

    const count = Number($('local-player-count').value) || 3;
    const bigDie = $('local-big-die').checked;
    const players = [];
    for (let i = 0; i < count; i++) {
      const color = Engine.COLOR_ORDER[i];
      players.push({
        id: `local_${i + 1}`,
        name: i === 0 ? ($('input-nickname').value.trim() || '플레이어 1') : `플레이어 ${i + 1}`,
        color,
        isAI: false
      });
    }

    state.localMyId = null;
    state.localGame = Engine.createInitialGameState(players, { neutralMode: 'auto', bigDie });
    $('mode-pill').textContent = `PASS & PLAY (${count}인)`;
    $('game-log-feed').innerHTML = '';
    Audio.playRoundStart();
    showScreen('screen-game');
    renderGame(state.localGame);
  }

  function driveLocalAiIfNeeded() {
    clearLocalTimers();
    if (state.mode !== 'solo' || !state.localGame || state.isSettling) return;
    if (state.localGame.phase === 'GAME_OVER') return;

    const cur = Engine.getCurrentPlayer(state.localGame);
    if (!cur || !cur.isAI) return;

    if (state.localGame.phase === 'WAIT_ROLL') {
      const t = setTimeout(() => {
        if (state.mode !== 'solo' || !state.localGame || state.localGame.phase !== 'WAIT_ROLL') return;
        Engine.rollDiceForCurrentPlayer(state.localGame);
        state.rollAnimId = Date.now();
        Audio.playDiceRoll(state.localGame.currentRoll.dice.length);
        renderGame(state.localGame);
        driveLocalAiIfNeeded();
      }, 650);
      state.aiTimers.push(t);
    } else if (state.localGame.phase === 'WAIT_PLACE') {
      const t = setTimeout(() => {
        if (state.mode !== 'solo' || !state.localGame || state.localGame.phase !== 'WAIT_PLACE') return;
        const face = Engine.chooseAiFace(state.localGame, cur.id);
        executeLocalPlace(cur.id, face);
      }, 950);
      state.aiTimers.push(t);
    }
  }

  function executeLocalRoll() {
    if (!state.localGame || state.isSettling) return;
    const cur = Engine.getCurrentPlayer(state.localGame);
    if (!cur) return;
    Engine.rollDiceForCurrentPlayer(state.localGame);
    state.rollAnimId = Date.now();
    Audio.playDiceRoll(state.localGame.currentRoll.dice.length);
    renderGame(state.localGame);
  }

  function executeLocalPlace(playerId, face) {
    if (!state.localGame || state.isSettling) return;
    const outcome = Engine.placeDiceChoice(state.localGame, playerId, face);
    const p = outcome.placement;
    Audio.playDicePlace(p.casinoId, p.totalWeightAdded);

    const casinoEl = document.querySelector(`.casino-card[data-casino-id="${p.casinoId}"]`);
    const colorHex = Engine.PLAYER_COLORS[p.playerColor]?.hex || '#f5c451';
    Fx.animateDiceFlight($('dice-pit'), casinoEl, colorHex, p.totalWeightAdded);

    if (outcome.roundEnded) {
      runRoundSettlementCeremony(outcome.roundReport, state.localGame.phase === 'GAME_OVER');
    } else {
      renderGame(state.localGame);
      driveLocalAiIfNeeded();
    }
  }

  // --- Round Settlement Ceremony ---
  function clearSettlementTimers() {
    while (state.settlementTimers.length > 0) {
      clearTimeout(state.settlementTimers.pop());
    }
  }

  function abortSettlementIfActive() {
    if (!state.isSettling) return;
    clearSettlementTimers();
    state.isSettling = false;
    state.settlingCasinos = null;
    $('payout-banner').classList.add('hidden');
    document.querySelectorAll('.casino-card').forEach(el => el.classList.remove('is-settling'));
  }

  function finishSettlementEarly() {
    clearSettlementTimers();
    state.isSettling = false;
    state.settlingCasinos = null;
    $('payout-banner').classList.add('hidden');
    document.querySelectorAll('.casino-card').forEach(el => el.classList.remove('is-settling'));

    if (state.mode === 'online' && state.onlineRoom?.hostId === state.myPlayerId) {
      sendWs({ type: 'skip_round_pause' });
    }

    const activeGame = getActiveGame();
    if (activeGame) {
      if (activeGame.phase === 'GAME_OVER') {
        showGameOverModal(activeGame);
      } else {
        Audio.playRoundStart();
        renderGame(activeGame);
        if (state.mode === 'solo') driveLocalAiIfNeeded();
      }
    }
  }

  function runRoundSettlementCeremony(roundReport, isGameOver) {
    clearSettlementTimers();
    state.isSettling = true;
    state.settlingCasinos = roundReport.preCasinos;
    state.settlementText = `라운드 ${roundReport.round} 정산 시작!`;

    const activeGame = getActiveGame();
    if (activeGame) renderGame(activeGame);

    $('payout-banner').classList.remove('hidden');
    $('payout-banner-text').textContent = state.settlementText;

    const reports = roundReport.casinoReports;
    reports.forEach((rep, idx) => {
      const t = setTimeout(() => {
        if (!state.isSettling) return;
        document.querySelectorAll('.casino-card').forEach(el => el.classList.remove('is-settling'));
        const cEl = document.querySelector(`.casino-card[data-casino-id="${rep.casinoId}"]`);
        if (cEl) cEl.classList.add('is-settling');

        const meta = Engine.CASINO_META[rep.casinoId - 1];
        const summaryParts = [];

        if (rep.tiedEntries.length > 0) {
          Audio.playTieAlert();
          Fx.spawnFloatingText(cEl, '⚡ 동점 상쇄!', '#fca5a5');
          summaryParts.push(`동점 상쇄 ${rep.tiedEntries.map(e => e.name).join('·')}`);
        }

        rep.winners.forEach((w, wIdx) => {
          setTimeout(() => {
            if (!state.isSettling) return;
            if (w.isNeutral) {
              Audio.playHouseSteal();
              Fx.spawnFloatingText(cEl, `하우스 회수 ${Engine.formatMoney(w.bill.value)}`, '#cbd5e1');
            } else {
              Audio.playCashWin(w.bill.value);
              const seatEl = document.querySelector(`.player-seat[data-player-id="${w.ownerId}"]`);
              Fx.animateBillFlight(cEl, seatEl, Engine.formatMoney(w.bill.value));
              Fx.spawnFloatingText(seatEl || cEl, `+${Engine.formatMoney(w.bill.value)}`, '#fde68a');
            }
          }, wIdx * 180);
          summaryParts.push(`${w.name} ${Engine.formatMoney(w.bill.value)}`);
        });

        $('payout-banner-text').textContent =
          `${rep.casinoId}번 ${meta.kr}: ${summaryParts.length ? summaryParts.join(' / ') : '승자 없음'}`;
      }, idx * 780);
      state.settlementTimers.push(t);
    });

    const endTimer = setTimeout(() => {
      if (!state.isSettling) return;
      state.isSettling = false;
      state.settlingCasinos = null;
      $('payout-banner').classList.add('hidden');
      document.querySelectorAll('.casino-card').forEach(el => el.classList.remove('is-settling'));

      const g = getActiveGame();
      if (!g) return;
      if (isGameOver || g.phase === 'GAME_OVER') {
        showGameOverModal(g);
      } else {
        Audio.playRoundStart();
        renderGame(g);
        if (state.mode === 'solo') driveLocalAiIfNeeded();
      }
    }, reports.length * 780 + 550);
    state.settlementTimers.push(endTimer);
  }

  // --- Active Game Helpers ---
  function getActiveGame() {
    if (state.mode === 'online') return state.onlineRoom?.game || null;
    return state.localGame;
  }

  function canLocalUserAct(game) {
    if (!game || state.isSettling || game.phase === 'GAME_OVER') return false;
    const cur = Engine.getCurrentPlayer(game);
    if (!cur || cur.isAI) return false;
    if (state.mode === 'pass') return true;
    if (state.mode === 'solo') return cur.id === state.localMyId;
    if (state.mode === 'online') return cur.id === state.myPlayerId;
    return false;
  }

  // --- Main Game Renderer ---
  function renderGame(game) {
    if (!game) return;
    const cur = Engine.getCurrentPlayer(game);
    const canAct = canLocalUserAct(game);

    // Subtle turn notification chime when it switches to our turn
    if (cur && canAct && (state.prevTurnPlayerId !== cur.id || state.prevPhase !== game.phase) && game.phase === 'WAIT_ROLL') {
      Audio.playTurnChime();
    }
    state.prevTurnPlayerId = cur?.id || null;
    state.prevPhase = game.phase;

    // Top HUD
    $('hud-round').textContent = `${game.round} / ${game.totalRounds}`;
    $('hud-deck-count').textContent = `${game.deckCount ?? game.deck?.length ?? 0}장`;
    $('neutral-legend').classList.toggle('hidden', (game.options?.neutralPerPlayer || 0) === 0);

    const turnBanner = $('hud-turn-banner');
    if (state.isSettling) {
      turnBanner.textContent = '✨ 라운드 정산 중...';
      turnBanner.classList.remove('is-my-turn');
    } else if (game.phase === 'GAME_OVER') {
      turnBanner.textContent = '🏆 게임 종료!';
      turnBanner.classList.remove('is-my-turn');
    } else if (cur) {
      const actionHint = game.phase === 'WAIT_ROLL' ? '주사위를 굴리세요!' : '배치할 숫자를 선택하세요!';
      turnBanner.textContent = canAct
        ? (state.mode === 'pass' ? `🎲 ${cur.name}님의 차례 · ${actionHint}` : `✨ 당신의 차례! ${actionHint}`)
        : `${cur.name}님이 ${game.phase === 'WAIT_ROLL' ? '굴리는 중...' : '배치 고민 중...'}`;
      turnBanner.classList.toggle('is-my-turn', canAct);
    }

    updateTurnTimerHud();
    renderPlayersStrip(game);
    renderCasinosGrid(game, canAct);
    renderDiceConsole(game, canAct);
    renderGameLog(game);

    if (game.phase === 'GAME_OVER' && !state.isSettling) {
      showGameOverModal(game);
    }
  }

  function updateTurnTimerHud() {
    cancelAnimationFrame(state.turnTimerRaf);
    const wrap = $('hud-timer-wrap');
    if (state.mode !== 'online' || !state.onlineRoom?.turnDeadline || state.isSettling) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');

    const tick = () => {
      const deadline = state.onlineRoom?.turnDeadline || 0;
      const leftMs = Math.max(0, deadline - Date.now());
      $('hud-timer-val').textContent = Math.ceil(leftMs / 1000) + 's';
      if (leftMs > 0 && state.mode === 'online') {
        state.turnTimerRaf = requestAnimationFrame(tick);
      }
    };
    tick();
  }

  function renderPlayersStrip(game) {
    const strip = $('players-strip');
    strip.innerHTML = '';
    const cur = Engine.getCurrentPlayer(game);
    const onlineLobbyMap = new Map(
      (state.onlineRoom?.lobbyPlayers || []).map(lp => [lp.id, lp])
    );

    game.players.forEach((p, idx) => {
      const seat = document.createElement('div');
      const cInfo = Engine.PLAYER_COLORS[p.color] || Engine.PLAYER_COLORS.red;
      const lobbyInfo = onlineLobbyMap.get(p.id);
      const isDisconnected = lobbyInfo && !lobbyInfo.isAI && !lobbyInfo.connected;
      const isActive = !state.isSettling && cur && cur.id === p.id && game.phase !== 'GAME_OVER';
      const isMe = state.mode === 'online' ? p.id === state.myPlayerId : (state.mode === 'solo' && p.id === state.localMyId);

      seat.className = 'player-seat' + (isActive ? ' is-active' : '') + (isDisconnected ? ' is-disconnected' : '');
      seat.dataset.playerId = p.id;
      seat.style.setProperty('--seat-color', cInfo.hex);

      const top = document.createElement('div');
      top.className = 'seat-top';
      const nameWrap = document.createElement('div');
      nameWrap.className = 'seat-name-wrap';

      const nameEl = document.createElement('span');
      nameEl.className = 'seat-name';
      nameEl.textContent = p.name;
      nameWrap.appendChild(nameEl);

      if (isMe) {
        const meTag = document.createElement('span');
        meTag.className = 'seat-tag me';
        meTag.textContent = '나';
        nameWrap.appendChild(meTag);
      }
      if (idx === game.startPlayerIndex) {
        const firstTag = document.createElement('span');
        firstTag.className = 'seat-tag first';
        firstTag.textContent = '선';
        nameWrap.appendChild(firstTag);
      }
      top.appendChild(nameWrap);

      if (isDisconnected) {
        const dcTag = document.createElement('span');
        dcTag.className = 'seat-tag';
        dcTag.textContent = '연결 끊김';
        top.appendChild(dcTag);
      }

      const cashRow = document.createElement('div');
      cashRow.className = 'seat-cash-row';
      const cashEl = document.createElement('span');
      cashEl.className = 'seat-cash';
      cashEl.textContent = Engine.formatMoney(p.cash);
      const billCountEl = document.createElement('span');
      billCountEl.className = 'seat-bills-count';
      billCountEl.textContent = `지폐 ${p.bills.length}장`;
      cashRow.append(cashEl, billCountEl);

      const diceDots = document.createElement('div');
      diceDots.className = 'seat-dice-dots';
      for (let i = 0; i < p.regularLeft; i++) {
        const dot = document.createElement('span');
        dot.className = 'mini-dot-die';
        diceDots.appendChild(dot);
      }
      for (let i = 0; i < p.bigLeft; i++) {
        const dot = document.createElement('span');
        dot.className = 'mini-dot-die big';
        dot.title = '왕주사위 (2배)';
        diceDots.appendChild(dot);
      }
      for (let i = 0; i < p.neutralLeft; i++) {
        const dot = document.createElement('span');
        dot.className = 'mini-dot-die neutral';
        dot.title = '중립 하우스 주사위';
        diceDots.appendChild(dot);
      }

      seat.append(top, cashRow, diceDots);

      // Host option to convert disconnected online player to AI
      if (isDisconnected && state.mode === 'online' && state.onlineRoom?.hostId === state.myPlayerId) {
        const aiBtn = document.createElement('button');
        aiBtn.className = 'btn btn-sm btn-outline';
        aiBtn.textContent = 'AI 대타 전환';
        aiBtn.addEventListener('click', () => sendWs({ type: 'convert_to_ai', targetId: p.id }));
        seat.appendChild(aiBtn);
      }

      strip.appendChild(seat);
    });
  }

  function getBillTierClass(val) {
    if (val >= 70000) return 'tier-vip';
    if (val >= 50000) return 'tier-high';
    if (val >= 30000) return 'tier-mid';
    return 'tier-low';
  }

  function buildCasinoPipSvg(num, color) {
    const cells = PIP_CELLS[num] || [];
    const circles = cells.map(cell => {
      const row = Math.floor((cell - 1) / 3);
      const col = (cell - 1) % 3;
      const cx = 7 + col * 8;
      const cy = 7 + row * 8;
      return `<circle cx="${cx}" cy="${cy}" r="2.3" fill="${color}" />`;
    }).join('');
    return `<svg width="24" height="24" viewBox="0 0 30 30" aria-hidden="true">${circles}</svg>`;
  }

  function renderCasinosGrid(game, canAct) {
    const grid = $('casinos-grid');
    grid.innerHTML = '';

    const casinosToRender = state.isSettling && state.settlingCasinos ? state.settlingCasinos : game.casinos;
    const availableFaces = (canAct && game.phase === 'WAIT_PLACE' && game.currentRoll)
      ? new Set(Engine.getAvailableFaces(game.currentRoll))
      : new Set();
    const cur = Engine.getCurrentPlayer(game);

    casinosToRender.forEach((casino) => {
      const meta = Engine.CASINO_META[casino.id - 1];
      const standings = Engine.evaluateCasinoStandings(casino, game.players);
      const isTargetable = availableFaces.has(casino.id);

      const card = document.createElement('article');
      card.className = 'casino-card'
        + (isTargetable ? ' is-targetable' : '')
        + (state.hoveredFace === casino.id && isTargetable ? ' is-highlighted' : '');
      card.dataset.casinoId = casino.id;
      card.style.setProperty('--casino-color', meta.color);
      card.style.setProperty('--casino-glow', meta.glow);

      // Header
      const header = document.createElement('div');
      header.className = 'casino-header';
      header.innerHTML = `
        <div class="casino-title-wrap">
          <div class="casino-pip-badge">${buildCasinoPipSvg(casino.id, meta.color)}</div>
          <div>
            <div class="casino-name">${casino.id} · ${meta.name}</div>
            <div class="casino-kr">${meta.kr}</div>
          </div>
        </div>
        <div class="casino-pool">${Engine.formatMoney(standings.totalPool)}</div>
      `;

      // Banknotes
      const billsEl = document.createElement('div');
      billsEl.className = 'casino-bills';
      for (const b of standings.bills) {
        const billEl = document.createElement('span');
        billEl.className = `banknote ${getBillTierClass(b.value)}`;
        billEl.textContent = Engine.formatMoney(b.value);
        billsEl.appendChild(billEl);
      }

      // Placed Dice Arena (sorted descending by weight)
      const arena = document.createElement('div');
      arena.className = 'casino-arena';

      const displayRows = [];
      for (const w of standings.winners) displayRows.push({ ...w, badgeType: `rank-${w.rank}` });
      for (const m of standings.missedOut) displayRows.push({ ...m, badgeType: 'out' });
      for (const t of standings.tiedEntries) displayRows.push({ ...t, badgeType: 'tied' });
      displayRows.sort((a, b) => b.weight - a.weight);

      if (displayRows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'casino-empty-hint';
        empty.textContent = isTargetable ? '클릭하여 주사위 배치' : '배치된 주사위 없음';
        arena.appendChild(empty);
      } else {
        for (const rowData of displayRows) {
          const row = document.createElement('div');
          row.className = 'casino-owner-row'
            + (rowData.badgeType === 'tied' ? ' is-tied' : '')
            + (rowData.badgeType === 'rank-1' ? ' is-rank-1' : '');

          const cInfo = rowData.isNeutral
            ? Engine.NEUTRAL_COLOR
            : (Engine.PLAYER_COLORS[rowData.color] || Engine.PLAYER_COLORS.red);

          const left = document.createElement('div');
          left.className = 'owner-left';

          const nameSpan = document.createElement('span');
          nameSpan.className = 'owner-name';
          nameSpan.style.color = rowData.isNeutral ? '#e2e8f0' : cInfo.light;
          nameSpan.textContent = rowData.name;

          const diceStack = document.createElement('div');
          diceStack.className = 'owner-dice-stack';
          for (let i = 0; i < rowData.big; i++) {
            const md = document.createElement('span');
            md.className = 'mini-die big';
            md.style.setProperty('--die-bg', cInfo.hex);
            md.textContent = '2×';
            diceStack.appendChild(md);
          }
          for (let i = 0; i < rowData.regular; i++) {
            const md = document.createElement('span');
            md.className = 'mini-die' + (rowData.isNeutral ? ' neutral' : '');
            md.style.setProperty('--die-bg', cInfo.hex);
            md.textContent = casino.id;
            diceStack.appendChild(md);
          }

          left.append(nameSpan, diceStack);

          const status = document.createElement('span');
          if (rowData.badgeType === 'tied') {
            status.className = 'owner-status-badge status-tied';
            status.textContent = `상쇄 (${rowData.weight})`;
          } else if (rowData.badgeType.startsWith('rank-')) {
            const r = rowData.rank;
            status.className = `owner-status-badge status-win-${Math.min(r, 3)}`;
            status.textContent = `${r}위 · ${Engine.formatMoney(rowData.bill.value)}`;
          } else {
            status.className = 'owner-status-badge status-out';
            status.textContent = `${rowData.weight}개`;
          }

          row.append(left, status);
          arena.appendChild(row);
        }
      }

      card.append(header, billsEl, arena);

      // Projected hover outcome preview when placing
      if (isTargetable && cur && game.currentRoll) {
        const proj = Engine.projectCasinoOutcome(casino, game.players, game.currentRoll, cur.id);
        const myWin = proj.after.winners.find(w => w.ownerId === cur.id);
        const isMyTied = proj.after.tiedEntries.some(t => t.ownerId === cur.id);

        const preview = document.createElement('div');
        preview.className = 'casino-preview-bar' + (isMyTied ? ' warn-tie' : '');
        if (myWin) {
          preview.textContent = `배치 예상: ${myWin.rank}위 (${Engine.formatMoney(myWin.bill.value)})`;
        } else if (isMyTied) {
          preview.textContent = '⚠️ 배치 시 동점 상쇄 예상!';
        } else {
          preview.textContent = '배치 가능 (현재 순위권 밖)';
        }
        card.appendChild(preview);

        card.addEventListener('mouseenter', () => setHoveredFace(casino.id));
        card.addEventListener('mouseleave', () => setHoveredFace(null));
        card.addEventListener('click', () => handlePlaceAction(casino.id));
      }

      grid.appendChild(card);
    });
  }

  function setHoveredFace(face) {
    if (state.hoveredFace === face) return;
    state.hoveredFace = face;
    if (face !== null) Audio.playHover();
    document.querySelectorAll('.casino-card').forEach(el => {
      el.classList.toggle('is-highlighted', Number(el.dataset.casinoId) === face);
    });
    document.querySelectorAll('.dice-group-btn').forEach(el => {
      el.classList.toggle('is-hovered', Number(el.dataset.placeFace) === face);
    });
  }

  function build3DDieElement(die, playerColorKey, animateTumble) {
    const cInfo = die.isNeutral
      ? Engine.NEUTRAL_COLOR
      : (Engine.PLAYER_COLORS[playerColorKey] || Engine.PLAYER_COLORS.red);

    const scene = document.createElement('div');
    scene.className = 'die-scene'
      + (die.isNeutral ? ' is-neutral' : '')
      + (die.isBig ? ' is-big' : '');

    scene.style.setProperty('--die-main', cInfo.hex);
    scene.style.setProperty('--die-light', cInfo.light);
    scene.style.setProperty('--die-dark', cInfo.dark);

    const cube = document.createElement('div');
    cube.className = `die-cube face-${die.face}` + (animateTumble ? ' rolling' : '');

    for (let f = 1; f <= 6; f++) {
      const faceEl = document.createElement('div');
      faceEl.className = `die-face f${f}`;
      const pipSet = new Set(PIP_CELLS[f]);
      for (let cell = 1; cell <= 9; cell++) {
        const dot = document.createElement('span');
        if (pipSet.has(cell)) dot.className = 'pip';
        faceEl.appendChild(dot);
      }
      cube.appendChild(faceEl);
    }

    scene.appendChild(cube);
    return scene;
  }

  function renderDiceConsole(game, canAct) {
    const cur = Engine.getCurrentPlayer(game);
    const rollBtn = $('btn-roll-dice');
    const promptEl = $('dice-pit-prompt');
    const contentEl = $('dice-pit-content');

    contentEl.innerHTML = '';

    if (state.isSettling) {
      rollBtn.classList.add('hidden');
      promptEl.textContent = '라운드 정산 진행 중...';
      return;
    }

    if (game.phase === 'GAME_OVER') {
      rollBtn.classList.add('hidden');
      promptEl.textContent = '모든 라운드가 종료되었습니다.';
      return;
    }

    if (game.phase === 'WAIT_ROLL') {
      rollBtn.classList.toggle('hidden', !canAct);
      const total = cur ? Engine.getTotalDiceLeft(cur) : 0;
      promptEl.textContent = cur
        ? (canAct
          ? `주사위 ${total}개 굴릴 준비 완료! (내 주사위 ${(cur.regularLeft || 0) + (cur.bigLeft || 0)}${cur.neutralLeft ? ` + 중립 ${cur.neutralLeft}` : ''})`
          : `${cur.name}님이 주사위 ${total}개를 굴릴 차례입니다...`)
        : '';
      return;
    }

    // WAIT_PLACE: Show grouped rolled dice
    rollBtn.classList.add('hidden');
    if (!game.currentRoll) return;

    const roller = game.players.find(p => p.id === game.currentRoll.playerId);
    const shouldAnimate = state.rollAnimId && (Date.now() - state.rollAnimId < 650);

    promptEl.textContent = canAct
      ? '배치할 눈금 그룹을 클릭하거나 숫자키 [1~6]을 누르세요!'
      : `${roller?.name || ''}님이 배치할 카지노를 고르는 중...`;

    const groups = new Map();
    for (const d of game.currentRoll.dice) {
      if (!groups.has(d.face)) groups.set(d.face, []);
      groups.get(d.face).push(d);
    }

    const sortedFaces = Array.from(groups.keys()).sort((a, b) => a - b);
    for (const face of sortedFaces) {
      const diceList = groups.get(face);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dice-group-btn' + (canAct ? ' selectable' : '');
      btn.dataset.placeFace = face;
      btn.disabled = !canAct;

      const row = document.createElement('div');
      row.className = 'dice-group-row';
      for (const d of diceList) {
        row.appendChild(build3DDieElement(d, roller?.color || 'red', shouldAnimate));
      }

      const meta = document.createElement('div');
      meta.className = 'dice-group-meta';
      const ownCnt = diceList.filter(d => !d.isNeutral && !d.isBig).length;
      const bigCnt = diceList.filter(d => d.isBig).length;
      const neuCnt = diceList.filter(d => d.isNeutral).length;
      const parts = [];
      if (ownCnt > 0) parts.push(`${ownCnt}개`);
      if (bigCnt > 0) parts.push(`왕주사위(2×)`);
      if (neuCnt > 0) parts.push(`중립 ${neuCnt}`);
      meta.innerHTML = `<kbd>${face}</kbd><span>${face}번 카지노 · ${parts.join(' + ')}</span>`;

      btn.append(row, meta);

      if (canAct) {
        btn.addEventListener('mouseenter', () => setHoveredFace(face));
        btn.addEventListener('mouseleave', () => setHoveredFace(null));
        btn.addEventListener('click', () => handlePlaceAction(face));
      }
      contentEl.appendChild(btn);
    }
  }

  function renderGameLog(game) {
    const feed = $('game-log-feed');
    const logs = game.log || [];
    const lastText = logs.length ? logs[logs.length - 1].text : '';
    const sig = `${logs.length}:${lastText}`;
    if (feed.dataset.lastLogSig === sig) return;
    feed.dataset.lastLogSig = sig;

    // Preserve chat lines
    const chatNodes = Array.from(feed.querySelectorAll('.chat-msg'));
    feed.innerHTML = '';
    for (const entry of logs) {
      const div = document.createElement('div');
      div.className = 'log-entry' + (entry.type === 'round_start' || entry.type === 'game_over' ? ' round' : '');
      div.textContent = entry.text;
      feed.appendChild(div);
    }
    for (const cn of chatNodes) feed.appendChild(cn);
    feed.scrollTop = feed.scrollHeight;
  }

  // --- Player Actions ---
  function handleRollAction() {
    unlockAudioOnce();
    const game = getActiveGame();
    if (!canLocalUserAct(game) || game.phase !== 'WAIT_ROLL') return;

    if (state.mode === 'online') {
      sendWs({ type: 'roll_dice' });
    } else {
      executeLocalRoll();
    }
  }

  function handlePlaceAction(face) {
    unlockAudioOnce();
    const game = getActiveGame();
    if (!canLocalUserAct(game) || game.phase !== 'WAIT_PLACE') return;
    setHoveredFace(null);

    if (state.mode === 'online') {
      sendWs({ type: 'place_dice', face });
    } else {
      const cur = Engine.getCurrentPlayer(game);
      executeLocalPlace(cur.id, face);
    }
  }

  // --- Chat & Emotes ---
  function appendChatMessage(payload) {
    const colorHex = Engine.PLAYER_COLORS[payload.color]?.light || '#f8fafc';
    const makeNode = () => {
      const div = document.createElement('div');
      div.className = 'chat-msg';
      const author = document.createElement('span');
      author.className = 'chat-author';
      author.style.color = colorHex;
      author.textContent = payload.name + ':';
      const body = document.createElement('span');
      body.textContent = payload.text;
      div.append(author, body);
      return div;
    };

    const lobbyFeed = $('lobby-chat-messages');
    lobbyFeed.appendChild(makeNode());
    lobbyFeed.scrollTop = lobbyFeed.scrollHeight;

    const drawerFeed = $('game-log-feed');
    drawerFeed.appendChild(makeNode());
    drawerFeed.scrollTop = drawerFeed.scrollHeight;

    if (!$('game-drawer').classList.contains('open') && $('screen-game').classList.contains('active')) {
      $('chat-unread-dot').classList.remove('hidden');
    }
  }

  function spawnEmoteToast(payload) {
    const layer = $('emote-toast-layer');
    const toast = document.createElement('div');
    toast.className = 'emote-toast';
    const cHex = Engine.PLAYER_COLORS[payload.color]?.light || '#fde68a';
    toast.innerHTML = `<span style="font-size:1.3rem">${payload.emote}</span><strong style="color:${cHex}">${escapeHtml(payload.name)}</strong>`;
    layer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 2600);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[s]));
  }

  // --- Game Over Modal ---
  function showGameOverModal(game) {
    Audio.playVictoryFanfare();
    Fx.emitConfetti(120);

    const sorted = game.players.slice().sort((a, b) => {
      if (b.cash !== a.cash) return b.cash - a.cash;
      return b.bills.length - a.bills.length;
    });
    const winners = game.winners || Engine.computeFinalWinners(game.players);
    const winnerIds = new Set(winners.map(w => w.id));

    $('gameover-title').textContent = `🏆 ${winners.map(w => w.name).join(' & ')} 우승!`;
    $('gameover-subtitle').textContent = `최종 상금 ${Engine.formatMoney(winners[0]?.cash || 0)} (지폐 ${winners[0]?.bills?.length || 0}장)`;

    const listEl = $('podium-list');
    listEl.innerHTML = '';

    sorted.forEach((p, idx) => {
      const cInfo = Engine.PLAYER_COLORS[p.color] || Engine.PLAYER_COLORS.red;
      const isWin = winnerIds.has(p.id);
      const row = document.createElement('div');
      row.className = 'podium-row' + (isWin ? ' winner' : '');

      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}위`;
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:1.2rem;">${medal}</span>
          <span class="color-dot" style="background:${cInfo.hex};color:${cInfo.hex};"></span>
          <div>
            <strong>${escapeHtml(p.name)}</strong>
            <div style="font-size:0.75rem;color:var(--text-muted);">
              지폐 ${p.bills.length}장 · 카지노 승리 ${p.stats?.casinosWon || 0}회 · 상쇄 ${p.stats?.tiesCaused || 0}회
            </div>
          </div>
        </div>
        <div style="font-family:var(--font-mono);font-size:1.1rem;font-weight:800;color:var(--gold-bright);">
          ${Engine.formatMoney(p.cash)}
        </div>
      `;
      listEl.appendChild(row);
    });

    const rematchBtn = $('btn-rematch');
    if (state.mode === 'online') {
      const isHost = state.onlineRoom?.hostId === state.myPlayerId;
      rematchBtn.classList.toggle('hidden', !isHost);
      rematchBtn.textContent = '🎲 대기실로 돌아가 재대결';
    } else {
      rematchBtn.classList.remove('hidden');
      rematchBtn.textContent = '🎲 한 판 더 하기';
    }

    $('modal-gameover').classList.remove('hidden');
  }

  function leaveToHome() {
    clearLocalTimers();
    clearSettlementTimers();
    cancelAnimationFrame(state.turnTimerRaf);
    state.isSettling = false;

    if (state.mode === 'online') {
      sendWs({ type: 'leave_room' });
      clearSavedSession();
      state.onlineRoom = null;
    }
    state.localGame = null;
    state.mode = 'none';
    showScreen('screen-home');
  }

  // --- Event Bindings ---
  function bindEvents() {
    // Top bar audio controls
    $('btn-bgm-toggle').addEventListener('click', () => {
      Audio.unlockAndStartBgm();
      const next = !Audio.bgmEnabled;
      Audio.setBgmEnabled(next);
      $('btn-bgm-toggle').classList.toggle('active', next);
    });

    $('btn-track-switch').addEventListener('click', () => {
      Audio.unlockAndStartBgm();
      const nextTrack = Audio.track === 'nujazz' ? 'deephouse' : 'nujazz';
      Audio.setTrack(nextTrack);
      $('track-label').textContent = nextTrack === 'nujazz' ? 'Nu-Jazz' : 'Deep House';
      showToast(`BGM 스타일: ${nextTrack === 'nujazz' ? '🍸 Velvet Nu-Jazz' : '✨ High-Roller Deep House'}`);
    });

    $('btn-sfx-toggle').addEventListener('click', () => {
      Audio.ensureContext();
      const next = !Audio.sfxEnabled;
      Audio.setSfxEnabled(next);
      $('btn-sfx-toggle').classList.toggle('active', next);
      $('btn-sfx-toggle').querySelector('.pill-ico').textContent = next ? '🔊' : '🔇';
    });

    // Navigation & modals
    $('btn-rules').addEventListener('click', () => $('modal-rules').classList.remove('hidden'));
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
    });
    document.querySelectorAll('.modal-backdrop').forEach(bg => {
      bg.addEventListener('click', (e) => {
        if (e.target === bg && bg.id === 'modal-rules') bg.classList.add('hidden');
      });
    });

    $('btn-logo-home').addEventListener('click', () => {
      if (state.mode !== 'none') leaveToHome();
    });
    $('btn-leave-game').addEventListener('click', leaveToHome);

    // Home Online Actions
    $('btn-connect-ws').addEventListener('click', () => {
      connectWebSocket($('input-ws-url').value.trim());
    });

    $('btn-create-room').addEventListener('click', () => {
      unlockAudioOnce();
      if (!state.wsConnected) {
        $('server-url-details').open = true;
        showToast('먼저 서버에 연결하거나(배포 URL 입력), 아래 AI 대전 / 로컬 모드를 이용하세요!', true);
        return;
      }
      sendWs({
        type: 'create_room',
        name: $('input-nickname').value.trim() || '호스트',
        color: state.selectedColor
      });
    });

    $('btn-join-room').addEventListener('click', () => {
      unlockAudioOnce();
      const code = $('input-room-code').value.trim().toUpperCase();
      if (!code) {
        showToast('입장할 방 코드를 입력하세요.', true);
        return;
      }
      if (!state.wsConnected) {
        $('server-url-details').open = true;
        showToast('먼저 서버에 연결되어 있어야 온라인 방에 입장할 수 있습니다.', true);
        return;
      }
      sendWs({
        type: 'join_room',
        roomCode: code,
        name: $('input-nickname').value.trim() || '플레이어',
        color: state.selectedColor
      });
    });

    // Home Offline Modes
    $('btn-start-solo').addEventListener('click', startSoloGame);
    $('btn-start-local').addEventListener('click', startPassAndPlayGame);

    // Lobby actions
    $('btn-copy-invite').addEventListener('click', () => {
      const code = state.onlineRoom?.code || '';
      const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
      if (navigator.clipboard && window.location.protocol !== 'file:') {
        navigator.clipboard.writeText(inviteUrl).then(
          () => showToast(`초대 링크가 복사되었습니다! (방 코드: ${code})`),
          () => showToast(`방 코드: ${code}`)
        );
      } else {
        showToast(`방 코드: ${code} (공유하여 입장하세요!)`);
      }
    });

    $('btn-lobby-add-ai').addEventListener('click', () => sendWs({ type: 'add_ai' }));
    $('btn-lobby-ready').addEventListener('click', () => sendWs({ type: 'toggle_ready' }));
    $('btn-lobby-start').addEventListener('click', () => sendWs({ type: 'start_game' }));

    $('lobby-opt-neutral').addEventListener('change', (e) => {
      sendWs({ type: 'update_options', options: { neutralMode: e.target.value } });
    });
    $('lobby-opt-timer').addEventListener('change', (e) => {
      sendWs({ type: 'update_options', options: { turnTimerSec: Number(e.target.value) } });
    });
    $('lobby-opt-bigdie').addEventListener('change', (e) => {
      sendWs({ type: 'update_options', options: { bigDie: e.target.checked } });
    });

    // Chats
    $('lobby-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('lobby-chat-input');
      const text = inp.value.trim();
      if (!text) return;
      sendWs({ type: 'chat', text });
      inp.value = '';
    });

    $('game-chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('game-chat-input');
      const text = inp.value.trim();
      if (!text) return;
      if (state.mode === 'online') {
        sendWs({ type: 'chat', text });
      } else {
        appendChatMessage({ name: '테이블 메모', color: 'amber', text });
      }
      inp.value = '';
    });

    // Gameplay actions
    $('btn-roll-dice').addEventListener('click', handleRollAction);
    $('btn-skip-payout').addEventListener('click', finishSettlementEarly);

    $('btn-toggle-drawer').addEventListener('click', () => {
      $('game-drawer').classList.toggle('open');
      $('chat-unread-dot').classList.add('hidden');
    });
    $('btn-close-drawer').addEventListener('click', () => {
      $('game-drawer').classList.remove('open');
    });

    document.querySelectorAll('.emote-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        unlockAudioOnce();
        const emote = btn.dataset.emote;
        if (state.mode === 'online') {
          sendWs({ type: 'emote', emote });
        } else {
          Audio.playEmote();
          spawnEmoteToast({ name: '나', color: state.selectedColor, emote });
        }
      });
    });

    // Game Over actions
    $('btn-rematch').addEventListener('click', () => {
      $('modal-gameover').classList.add('hidden');
      if (state.mode === 'online') {
        sendWs({ type: 'restart_game' });
      } else if (state.mode === 'solo') {
        startSoloGame();
      } else if (state.mode === 'pass') {
        startPassAndPlayGame();
      }
    });
    $('btn-back-home').addEventListener('click', leaveToHome);

    // Keyboard shortcuts (Space to roll, 1-6 to place)
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) {
        return;
      }
      const game = getActiveGame();
      if (!canLocalUserAct(game)) return;

      if ((e.code === 'Space' || e.code === 'Enter') && game.phase === 'WAIT_ROLL') {
        e.preventDefault();
        handleRollAction();
      } else if (game.phase === 'WAIT_PLACE' && e.key >= '1' && e.key <= '6') {
        const face = Number(e.key);
        const avail = Engine.getAvailableFaces(game.currentRoll);
        if (avail.includes(face)) {
          e.preventDefault();
          handlePlaceAction(face);
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
