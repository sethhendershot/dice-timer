(() => {
  'use strict';

  const CATAN_VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const HOT_NUMBERS = new Set([6, 8]);
  const DICE_WAYS = {
    2: [[1, 1]],
    3: [[1, 2]],
    4: [[1, 3], [2, 2]],
    5: [[1, 4], [2, 3]],
    6: [[1, 5], [2, 4], [3, 3]],
    7: [[1, 6], [2, 5], [3, 4]],
    8: [[2, 6], [3, 5], [4, 4]],
    9: [[3, 6], [4, 5]],
    10: [[4, 6], [5, 5]],
    11: [[5, 6]],
    12: [[6, 6]],
  };
  const PIP_LAYOUTS = {
    1: [[50, 50]],
    2: [[28, 28], [72, 72]],
    3: [[28, 28], [50, 50], [72, 72]],
    4: [[28, 28], [72, 28], [28, 72], [72, 72]],
    5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
    6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
  };

  let players = [];
  let rolls = [];
  let winners = [];
  let games = [];
  const DEFAULT_POINT_GOAL = 21;

  let currentGameId = null;
  let draftTurnOrder = [];
  let draftPointGoal = DEFAULT_POINT_GOAL;
  let gameClockInterval = null;
  let selectedPastGameId = null;
  let editingRollId = null;

  const STARTING_SETTLEMENTS = 2;
  // House rules allow extra pieces, so there are no piece-count limits.
  const MAX_GAME_COUNT = 999;
  const AWARD_POINTS = 2;
  const AWARDS = [
    { key: 'longestRoad', field: 'longestRoadPlayerId', label: 'Longest Road', short: 'LR' },
    { key: 'largestArmy', field: 'largestArmyPlayerId', label: 'Largest Army', short: 'LA' },
  ];
  let rollChart = null;

  // --- Timer state ---
  let timerInterval = null;
  let timerRemainingMs = 0;
  let timerRunning = false;

  const $ = (id) => document.getElementById(id);

  // --- API helpers ---

  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // --- Toast ---

  let toastTimer = null;
  function showToast(message, type = 'success') {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast ${type}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  // --- Timer ---

  function getTimerDurationMs() {
    const mins = Math.max(0, parseInt($('timerMinutes').value, 10) || 0);
    const secs = Math.max(0, Math.min(59, parseInt($('timerSeconds').value, 10) || 0));
    return (mins * 60 + secs) * 1000;
  }

  function formatTime(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function updateTimerDisplay() {
    const display = $('timerDisplay');
    display.textContent = formatTime(timerRemainingMs);
    display.classList.remove('warning', 'expired');
    if (timerRemainingMs <= 0 && !timerRunning) {
      display.classList.add('expired');
    } else if (timerRemainingMs <= 10000) {
      display.classList.add('warning');
    }
  }

  function setTimerStatus(text) {
    const el = $('timerStatus');
    el.textContent = text;
    el.classList.toggle('running', text === 'Running');
  }

  function setTimerExpired(expired) {
    const panel = $('timerPanel');
    const overlay = $('timerExpiredOverlay');
    panel.classList.toggle('expired', expired);
    overlay.setAttribute('aria-hidden', expired ? 'false' : 'true');
  }

  // --- Timer-done sound ---

  const TIMER_SOUND_DEFAULT = '/sounds/timer-done.wav';
  let timerSound = null;
  let timerSoundUnlocked = false;

  function getTimerSound() {
    if (!timerSound) {
      timerSound = new Audio(TIMER_SOUND_DEFAULT);
      timerSound.preload = 'auto';
    }
    return timerSound;
  }

  function unlockTimerSound() {
    if (timerSoundUnlocked) return;
    timerSoundUnlocked = true;
    const audio = getTimerSound();
    audio.muted = true;
    const p = audio.play();
    const done = () => { audio.pause(); audio.currentTime = 0; audio.muted = false; };
    if (p && typeof p.then === 'function') {
      p.then(done).catch(() => { audio.muted = false; timerSoundUnlocked = false; });
    } else {
      done();
    }
  }

  function playTimerSound() {
    try {
      const audio = getTimerSound();
      audio.muted = false;
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) {
      // Audio unavailable; the visual alert still shows.
    }
  }

  function stopTimerInterval() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    timerRunning = false;
  }

  function playTimer() {
    if (timerRunning) return;
    if (timerRemainingMs <= 0) {
      timerRemainingMs = getTimerDurationMs();
    }
    setTimerExpired(false);
    timerRunning = true;
    setTimerStatus('Running');
    updateTimerDisplay();
    timerInterval = setInterval(() => {
      timerRemainingMs -= 100;
      if (timerRemainingMs <= 0) {
        timerRemainingMs = 0;
        stopTimerInterval();
        setTimerExpired(true);
        playTimerSound();
        setTimerStatus("Time's up!");
        updateTimerDisplay();
      } else {
        updateTimerDisplay();
      }
    }, 100);
  }

  function pauseTimer() {
    stopTimerInterval();
    setTimerStatus('Paused');
  }

  function resetTimer() {
    stopTimerInterval();
    setTimerExpired(false);
    timerRemainingMs = getTimerDurationMs();
    setTimerStatus('Ready');
    updateTimerDisplay();
  }

  // --- Data loading ---

  async function loadPlayers() {
    const data = await api('/api/players');
    players = data.players;
    renderPlayers();
    populatePlayerSelects();
    renderTurnOrder();
  }

  async function loadRolls() {
    const data = await api('/api/rolls');
    rolls = data.rolls;
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    renderChartGameOptions();
    updateChart();
  }

  async function loadWinners() {
    const data = await api('/api/winners');
    winners = data.winners;
    renderWinnerHistory();
    renderChartGameOptions();
  }

  async function loadGames() {
    const data = await api('/api/games');
    games = data.games;
    currentGameId = data.currentGameId;
    if (!currentGameId) {
      const latest = getSortedGames().find((game) => Array.isArray(game.playerOrder) && game.playerOrder.length);
      draftTurnOrder = latest ? [...latest.playerOrder] : [];
      const latestGoal = getSortedGames().find((game) => Number.isInteger(Number(game.pointGoal)));
      draftPointGoal = latestGoal ? pointGoalOf(latestGoal) : DEFAULT_POINT_GOAL;
    }
    renderGameInfo(data);
    updateHeaderStatus();
    renderTurnOrder();
    renderChartGameOptions();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    updateChart();
  }

  // --- Rendering ---

  function renderPlayers() {
    const list = $('playerList');
    if (players.length === 0) {
      list.innerHTML = '<li class="empty-state">No players yet — add one below</li>';
      return;
    }
    list.innerHTML = players.map((p) => `
      <li>
        <span>${escapeHtml(p.name)}</span>
        <button class="delete-btn" data-id="${p.id}" title="Remove player">&times;</button>
      </li>
    `).join('');

    list.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => deletePlayer(btn.dataset.id));
    });
  }

  function populatePlayerSelects() {
    const options = players.map((p) =>
      `<option value="${p.id}" data-name="${escapeAttr(p.name)}">${escapeHtml(p.name)}</option>`
    ).join('');

    $('rollPlayer').innerHTML = `<option value="">Select player…</option>${options}`;
    $('winnerPlayer').innerHTML = `<option value="">Select winner…</option>${options}`;
    const calledBy = $('rollCalledBy').value;
    $('rollCalledBy').innerHTML = `<option value="">Select who called it…</option>${options}`;
    if (players.some((p) => p.id === calledBy)) $('rollCalledBy').value = calledBy;
  }

  function syncCalledByField(checkboxId, fieldId, selectId) {
    const checked = $(checkboxId).checked;
    $(fieldId).hidden = !checked;
    $(selectId).required = checked;
    if (!checked) $(selectId).value = '';
  }

  function chartScopeValue() {
    return $('chartScope')?.value || 'game';
  }

  function getChartScope() {
    const value = chartScopeValue();
    if (value === 'all' || value === 'game') return value;
    return 'past';
  }

  function getScopedRolls() {
    const scope = getChartScope();
    if (scope === 'all') return rolls;
    if (scope === 'past') {
      return rolls.filter((r) => r.gameId === chartScopeValue());
    }
    if (!currentGameId) return [];
    return rolls.filter((r) => r.gameId === currentGameId);
  }

  function getEditingTurnOrder() {
    if (currentGameId) {
      const game = games.find((g) => g.id === currentGameId);
      return [...(game?.playerOrder || [])];
    }
    return [...draftTurnOrder];
  }

  function getActiveTurnOrder() {
    if (!currentGameId) return [];
    return getEditingTurnOrder().filter((id) => players.some((player) => player.id === id));
  }

  function getRollsForGame(gameId) {
    return rolls
      .filter((r) => r.gameId === gameId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  function getGameRolls() {
    if (!currentGameId) return [];
    return getRollsForGame(currentGameId);
  }

  function getWinnerForGame(gameId) {
    return winners.find((w) => w.gameId === gameId) || null;
  }

  function getSortedGames() {
    return [...games].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  function rollValueClass(value) {
    if (value === 7) return 'seven';
    if (HOT_NUMBERS.has(value)) return 'hot';
    return '';
  }

  function buildPlayerRollBreakdown(gameRolls) {
    const byPlayer = new Map();
    gameRolls.forEach((r) => {
      if (!byPlayer.has(r.playerId)) {
        byPlayer.set(r.playerId, {
          playerId: r.playerId,
          playerName: r.playerName,
          counts: buildRollCounts([]),
          total: 0,
        });
      }
      const entry = byPlayer.get(r.playerId);
      entry.counts[r.value]++;
      entry.total++;
    });
    return Array.from(byPlayer.values()).sort((a, b) => b.total - a.total);
  }

  // --- Builds, points and awards ---

  function buildCount(roll, field) {
    const count = Number(roll[field]);
    return Number.isInteger(count) && count > 0 ? count : 0;
  }

  function getGamePlayers(game, gameRolls) {
    const ids = [...(game?.playerOrder || [])];
    gameRolls.forEach((r) => {
      if (r.playerId && !ids.includes(r.playerId)) ids.push(r.playerId);
    });
    return ids.map((id) => {
      const player = players.find((p) => p.id === id);
      const roll = gameRolls.find((r) => r.playerId === id);
      return { id, name: player ? player.name : (roll ? roll.playerName : 'Unknown player') };
    });
  }

  // Game-level counts entered on Player Standings: game.builds[playerId] = { settlements, cities, victoryPoints }.
  function gameCount(game, playerId, field) {
    const entry = game && game.builds && game.builds[playerId];
    const count = entry ? Number(entry[field]) : 0;
    return Number.isInteger(count) && count > 0 ? count : 0;
  }

  function buildStandings(game) {
    const gameRolls = getRollsForGame(game.id);
    return getGamePlayers(game, gameRolls).map((player) => {
      // Older games stored builds on rolls; those still count, plus the game-level counts.
      let settlementsBuilt = 0;
      let citiesBuilt = 0;
      let cityWithoutSettlement = false;
      gameRolls.filter((r) => r.playerId === player.id).forEach((r) => {
        settlementsBuilt += buildCount(r, 'settlementsBuilt');
        citiesBuilt += buildCount(r, 'citiesBuilt');
        if (STARTING_SETTLEMENTS + settlementsBuilt - citiesBuilt < 0) cityWithoutSettlement = true;
      });
      const extraSettlements = gameCount(game, player.id, 'settlements');
      const extraCities = gameCount(game, player.id, 'cities');
      const victoryPoints = gameCount(game, player.id, 'victoryPoints');
      settlementsBuilt += extraSettlements;
      citiesBuilt += extraCities;
      const settlements = STARTING_SETTLEMENTS + settlementsBuilt - citiesBuilt;
      if (settlements < 0) cityWithoutSettlement = true;
      const cities = citiesBuilt;
      const awards = AWARDS.filter((award) => game[award.field] === player.id);
      const buildPoints = STARTING_SETTLEMENTS + settlementsBuilt + citiesBuilt;
      const points = buildPoints + awards.length * AWARD_POINTS + victoryPoints;

      const warnings = [];
      if (cityWithoutSettlement) warnings.push('a city was built with no settlement to upgrade');

      return {
        ...player, settlements, cities, victoryPoints, points, awards, warnings,
        gameCounts: { settlements: extraSettlements, cities: extraCities, victoryPoints },
      };
    });
  }

  function renderStandingsTable(game, { editable = false } = {}) {
    const standings = buildStandings(game);
    if (standings.length === 0) {
      return '<p class="empty-state">Add players to the turn order to track points</p>';
    }
    const goal = pointGoalOf(game);
    const awardCell = (award, p) => {
      const holds = game[award.field] === p.id;
      if (!editable) {
        return `<td class="pb-award">${holds ? `<span class="award-badge" title="${award.label}">${award.short}</span>` : ''}</td>`;
      }
      return `<td class="pb-award">
        <button type="button" class="award-toggle${holds ? ' active' : ''}" data-field="${award.field}" data-player="${escapeAttr(p.id)}"
          aria-pressed="${holds}" title="${holds ? `Remove ${award.label} from ${escapeAttr(p.name)}` : `Give ${award.label} to ${escapeAttr(p.name)}`}">${award.short}</button>
      </td>`;
    };
    const countCell = (p, field, value, label) => {
      if (!editable) return `<td class="pb-count has-roll">${value}</td>`;
      const name = escapeAttr(p.name);
      return `<td class="pb-count has-roll">
        <span class="stepper">
          <button type="button" class="step-btn" data-field="${field}" data-player="${escapeAttr(p.id)}" data-step="-1"
            ${p.gameCounts[field] > 0 ? '' : 'disabled'} aria-label="One fewer ${label} for ${name}">&minus;</button>
          <span class="step-value">${value}</span>
          <button type="button" class="step-btn" data-field="${field}" data-player="${escapeAttr(p.id)}" data-step="1"
            aria-label="One more ${label} for ${name}">+</button>
        </span>
      </td>`;
    };
    const warnings = standings.filter((p) => p.warnings.length);
    const turnRoll = editable ? getCurrentTurnRoll() : null;
    const turnPlayerId = turnRoll ? turnRoll.playerId : null;
    return `
      <div class="player-breakdown-table-wrap">
        <table class="player-breakdown-table standings-table">
          <thead>
            <tr>
              <th>Player</th>
              <th title="Settlements, cities and victory point cards, plus 2 for each award">Points</th>
              <th title="Settlements on the board">Settl.</th>
              <th>Cities</th>
              <th title="Victory point cards">VP</th>
              <th title="Longest Road (+${AWARD_POINTS})">Longest Road</th>
              <th title="Largest Army (+${AWARD_POINTS})">Largest Army</th>
            </tr>
          </thead>
          <tbody>
            ${standings.map((p) => `
              <tr${p.id === turnPlayerId ? ' class="current-turn-row" title="Current turn"' : ''}>
                <td class="pb-player">${escapeHtml(p.name)}${p.warnings.length ? ' <span class="standings-warn-icon" title="Check builds">&#9888;</span>' : ''}</td>
                <td class="pb-total pb-points${p.points >= goal ? ' reached' : ''}">${p.points}</td>
                ${countCell(p, 'settlements', p.settlements, 'settlement')}
                ${countCell(p, 'cities', p.cities, 'city')}
                ${countCell(p, 'victoryPoints', p.victoryPoints, 'victory point')}
                ${AWARDS.map((award) => awardCell(award, p)).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${warnings.length ? `<ul class="standings-warnings">${warnings.map((p) =>
        `<li>&#9888; ${escapeHtml(p.name)}: ${p.warnings.map(escapeHtml).join('; ')}</li>`).join('')}</ul>` : ''}
    `;
  }

  // The current turn belongs to whoever's roll was recorded last in the active game:
  // they are the one entering builds, knights and so on.
  function getCurrentTurnRoll() {
    const gameRolls = getGameRolls();
    return gameRolls.length ? gameRolls[gameRolls.length - 1] : null;
  }

  function renderCurrentTurn() {
    const box = $('currentTurn');
    const nameEl = $('currentTurnName');
    const roll = currentGameId ? getCurrentTurnRoll() : null;
    box.classList.toggle('is-active', Boolean(roll));
    if (!currentGameId) {
      nameEl.textContent = 'No active game';
      box.title = 'Start a game to track turns';
      return;
    }
    if (!roll) {
      nameEl.textContent = 'No rolls yet';
      box.title = 'Record the first roll of this game';
      return;
    }
    const player = players.find((p) => p.id === roll.playerId);
    const name = player ? player.name : roll.playerName;
    nameEl.textContent = name;
    box.title = `${name} rolled ${roll.value} at ${formatRollTime(roll.timestamp)}`;
  }

  function renderPlayerStandings() {
    renderCurrentTurn();
    const el = $('playerStandings');
    const game = currentGame();
    if (!currentGameId || !game) {
      el.innerHTML = '<p class="empty-state">Start a game to track points</p>';
      return;
    }
    el.innerHTML = renderStandingsTable(game, { editable: true });
    el.querySelectorAll('.award-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleAward(game.id, btn.dataset.field, btn.dataset.player).catch((err) => showToast(err.message, 'error'));
      });
    });
    el.querySelectorAll('.step-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        adjustGameCount(game.id, btn.dataset.player, btn.dataset.field, Number(btn.dataset.step))
          .catch((err) => showToast(err.message, 'error'));
      });
    });
  }

  async function adjustGameCount(gameId, playerId, field, step) {
    const game = games.find((g) => g.id === gameId);
    if (!game) return;
    const current = gameCount(game, playerId, field);
    const next = Math.min(MAX_GAME_COUNT, Math.max(0, current + step));
    if (next === current) return;
    const updated = await api(`/api/games/${gameId}/builds`, {
      method: 'PATCH',
      body: JSON.stringify({ playerId, [field]: next }),
    });
    const index = games.findIndex((g) => g.id === gameId);
    if (index !== -1) games[index] = updated;
    renderPlayerStandings();
    if (!$('pastGamesModal').hidden && selectedPastGameId === gameId) {
      renderPastGameDetail(gameId);
    }
  }

  async function toggleAward(gameId, field, playerId) {
    const game = games.find((g) => g.id === gameId);
    if (!game) return;
    const nextHolder = game[field] === playerId ? null : playerId;
    const updated = await api(`/api/games/${gameId}/awards`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: nextHolder }),
    });
    const index = games.findIndex((g) => g.id === gameId);
    if (index !== -1) games[index] = updated;
    renderPlayerStandings();
    if (!$('pastGamesModal').hidden && selectedPastGameId === gameId) {
      renderPastGameDetail(gameId);
    }
    const award = AWARDS.find((a) => a.field === field);
    const holder = nextHolder ? getGamePlayers(updated, getRollsForGame(gameId)).find((p) => p.id === nextHolder) : null;
    showToast(holder ? `${award.label}: ${holder.name}` : `${award.label} cleared`);
  }

  function renderPlayerBreakdown() {
    renderPlayerStandings();
    const el = $('playerBreakdown');
    const gameRolls = getGameRolls();

    if (!currentGameId) {
      el.innerHTML = '<p class="empty-state">Start a game to see player breakdown</p>';
      return;
    }

    const breakdown = buildPlayerRollBreakdown(gameRolls);
    if (breakdown.length === 0) {
      el.innerHTML = '<p class="empty-state">No rolls recorded yet</p>';
      return;
    }

    el.innerHTML = `
      <div class="player-breakdown-table-wrap">
        <table class="player-breakdown-table">
          <thead>
            <tr>
              <th>Player</th>
              ${CATAN_VALUES.map((v) => `<th class="pb-num ${rollValueClass(v)}">${v}</th>`).join('')}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${breakdown.map((p) => `
              <tr>
                <td class="pb-player">${escapeHtml(p.playerName)}</td>
                ${CATAN_VALUES.map((v) => {
                  const count = p.counts[v];
                  return `<td class="pb-count${count ? ' has-roll' : ''}">${count || 0}</td>`;
                }).join('')}
                <td class="pb-total">${p.total}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderScoreboard() {
    const el = $('scoreboard');
    const gameRolls = getGameRolls();
    const counts = buildRollCounts(gameRolls);

    if (!currentGameId) {
      el.innerHTML = '<p class="empty-state">Start a game to track rolls</p>';
      return;
    }

    el.innerHTML = CATAN_VALUES.map((v) => `
      <div class="scoreboard-cell ${rollValueClass(v)}">
        <span class="scoreboard-num">${v}</span>
        <span class="scoreboard-count">${counts[v]}</span>
      </div>
    `).join('');
  }

  function renderGameRollHistory() {
    renderGameRollHistoryInto($('gameRollHistory'), $('gameRollCount'));
    if (!$('gameRollsModal').hidden) {
      renderGameRollHistoryInto($('gameRollsModalBody'), $('gameRollsModalCount'));
    }
  }

  function openGameRollsModal() {
    $('gameRollsModal').hidden = false;
    document.body.style.overflow = 'hidden';
    renderGameRollHistory();
  }

  function closeGameRollsModal() {
    $('gameRollsModal').hidden = true;
    releaseModalScroll();
  }

  function renderGameRollHistoryInto(tbody, countEl) {
    const gameRolls = getGameRolls();

    if (!currentGameId) {
      countEl.textContent = 'No active game';
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Start a game to begin recording rolls</td></tr>';
      return;
    }

    countEl.textContent = `${gameRolls.length} roll${gameRolls.length === 1 ? '' : 's'}`;

    if (gameRolls.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No rolls recorded for this game yet</td></tr>';
      return;
    }

    tbody.innerHTML = renderRollRows(gameRolls);
    bindRollDeleteButtons(tbody);
  }

  // gameRolls arrive oldest-first; number them in that order, then show newest first.
  function renderRollRows(gameRolls, compact = false) {
    return gameRolls.map((r, index) => ({ r, num: index + 1 })).reverse().map(({ r, num }) => `
      <tr>
        <td class="roll-num">${num}</td>
        <td class="roll-value ${rollValueClass(r.value)}">${r.value}</td>
        <td class="roll-player">${escapeHtml(r.playerName)}${r.knightPlayed === true ? ' <span class="knight-badge" title="Knight played" aria-label="Knight played">&#9822;</span>' : ''}${r.calledIt === true && r.calledByName ? ` <span class="called-badge" title="Called by ${escapeAttr(r.calledByName)}">&#127919; ${escapeHtml(r.calledByName)}</span>` : ''}</td>
        ${compact ? '' : `<td class="roll-date">${formatRollDate(r.timestamp)}</td>`}
        <td class="roll-time">${formatRollTime(r.timestamp)}</td>
        <td class="roll-actions">
          <button type="button" class="edit-roll-btn" data-id="${r.id}" title="Edit roll" aria-label="Edit roll of ${r.value} by ${escapeAttr(r.playerName)}">&#9998;</button>
          <button type="button" class="delete-roll-btn" data-id="${r.id}" aria-label="Delete roll of ${r.value} by ${escapeAttr(r.playerName)}">&times;</button>
        </td>
      </tr>
    `).join('');
  }

  function bindRollDeleteButtons(root) {
    root.querySelectorAll('.delete-roll-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteRoll(btn.dataset.id).catch((err) => showToast(err.message, 'error'));
      });
    });
    root.querySelectorAll('.edit-roll-btn').forEach((btn) => {
      btn.addEventListener('click', () => openEditRollModal(btn.dataset.id));
    });
  }

  function renderPastGamesList() {
    const list = $('pastGamesList');
    const sorted = getSortedGames();

    if (sorted.length === 0) {
      list.innerHTML = '<li class="empty-state">No games recorded yet</li>';
      return;
    }

    list.innerHTML = sorted.map((game) => {
      const gameRolls = getRollsForGame(game.id);
      const winner = getWinnerForGame(game.id);
      const isActive = !game.endedAt && game.id === currentGameId;
      const isSelected = game.id === selectedPastGameId;

      return `
        <li>
          <button type="button" class="past-game-item${isSelected ? ' active' : ''}" data-id="${game.id}">
            <div class="game-date">${formatRollDate(game.startedAt)}</div>
            <div class="game-meta">${gameRolls.length} roll${gameRolls.length === 1 ? '' : 's'}${winner ? ` · ${escapeHtml(winner.playerName)} won` : ''}${renderBiasBadge(game)}</div>
            <span class="game-status ${isActive ? 'active' : 'completed'}">${isActive ? 'Active' : 'Completed'}</span>
          </button>
        </li>
      `;
    }).join('');

    list.querySelectorAll('.past-game-item').forEach((btn) => {
      btn.addEventListener('click', () => selectPastGame(btn.dataset.id));
    });
  }

  function renderPastGameDetail(gameId) {
    const detail = $('pastGameDetail');
    const game = games.find((g) => g.id === gameId);

    if (!game) {
      detail.innerHTML = '<p class="empty-state">Game not found</p>';
      return;
    }

    const gameRolls = getRollsForGame(game.id);
    const winner = getWinnerForGame(game.id);
    const endedText = game.endedAt
      ? `${formatRollDate(game.endedAt)} at ${formatRollTime(game.endedAt)}`
      : 'In progress';

    detail.innerHTML = `
      <div class="past-game-heading">
        <h3>${formatRollDate(game.startedAt)}${renderBiasBadge(game)}</h3>
        <button type="button" class="btn btn-danger" id="deletePastGame">Delete game</button>
      </div>
      <div class="past-game-stats">
        <span>Started: <strong>${formatRollTime(game.startedAt)}</strong></span>
        <span>Ended: <strong>${endedText}</strong></span>
        <span>Length: <strong id="pastGameDuration">${formatGameLength(game)}</strong></span>
        <span>To: <strong id="pastGamePoints">${pointGoalOf(game)}</strong></span>
        <span>Total rolls: <strong>${gameRolls.length}</strong></span>
      </div>
      <h4 class="past-game-subheading">Points</h4>
      ${renderStandingsTable(game)}
      ${winner
        ? `<div class="past-game-winner"><span class="trophy">&#9733;</span> Winner: <strong>${escapeHtml(winner.playerName)}</strong>${winner.winnerHadKnight === true ? ' <span class="knight-badge" title="Winner had played a knight">&#9822; Knight</span>' : ''}</div>`
        : '<p class="empty-state">No winner recorded for this game</p>'}
      <div class="game-rolls-table-wrap">
        <table class="game-rolls-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Roll</th>
              <th>Player</th>
              <th>Date</th>
              <th>Time</th>
              <th class="roll-actions"><span class="sr-only">Delete</span></th>
            </tr>
          </thead>
          <tbody>
            ${gameRolls.length > 0
              ? renderRollRows(gameRolls)
              : '<tr class="empty-row"><td colspan="6">No rolls recorded for this game</td></tr>'}
          </tbody>
        </table>
      </div>
    `;

    detail.querySelector('#deletePastGame').addEventListener('click', () => {
      deleteGame(game.id).catch((err) => showToast(err.message, 'error'));
    });
    bindRollDeleteButtons(detail);
  }

  function selectPastGame(gameId) {
    selectedPastGameId = gameId;
    renderPastGamesList();
    renderPastGameDetail(gameId);
  }

  function openPastGamesModal() {
    renderPastGamesList();
    if (selectedPastGameId) {
      renderPastGameDetail(selectedPastGameId);
    } else {
      const sorted = getSortedGames();
      if (sorted.length > 0) {
        selectPastGame(sorted[0].id);
      } else {
        $('pastGameDetail').innerHTML = '<p class="empty-state">No games recorded yet</p>';
      }
    }
    $('pastGamesModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closePastGamesModal() {
    $('pastGamesModal').hidden = true;
    releaseModalScroll();
  }

  function openPlayersModal() {
    renderPlayers();
    $('playersModal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('playerName').focus();
  }

  function closePlayersModal() {
    $('playersModal').hidden = true;
    releaseModalScroll();
  }

  function openGameModal() {
    renderTurnOrder();
    $('gameModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeGameModal() {
    $('gameModal').hidden = true;
    releaseModalScroll();
  }

  function openEditRollModal(id) {
    const roll = rolls.find((entry) => entry.id === id);
    if (!roll) {
      showToast('Roll not found', 'error');
      return;
    }
    editingRollId = id;
    const known = players.some((p) => p.id === roll.playerId);
    const options = players.map((p) =>
      `<option value="${p.id}" data-name="${escapeAttr(p.name)}">${escapeHtml(p.name)}</option>`
    ).join('');
    const missing = known
      ? ''
      : `<option value="${escapeAttr(roll.playerId)}" data-name="${escapeAttr(roll.playerName)}">${escapeHtml(roll.playerName)}</option>`;
    $('editRollPlayer').innerHTML = missing + options;
    $('editRollPlayer').value = roll.playerId;
    $('editRollValue').value = roll.value;
    $('editRollKnight').checked = roll.knightPlayed === true;
    const calledKnown = !roll.calledById || players.some((p) => p.id === roll.calledById);
    const calledMissing = calledKnown
      ? ''
      : `<option value="${escapeAttr(roll.calledById)}" data-name="${escapeAttr(roll.calledByName || '')}">${escapeHtml(roll.calledByName || 'Unknown player')}</option>`;
    $('editRollCalledBy').innerHTML = `<option value="">Select who called it…</option>${calledMissing}${options}`;
    $('editRollCalledIt').checked = roll.calledIt === true;
    syncCalledByField('editRollCalledIt', 'editRollCalledByField', 'editRollCalledBy');
    if (roll.calledIt === true && roll.calledById) $('editRollCalledBy').value = roll.calledById;
    $('editRollMeta').textContent = `Recorded ${formatRollDate(roll.timestamp)} at ${formatRollTime(roll.timestamp)}`;
    $('editRollModal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('editRollValue').focus();
  }

  function closeEditRollModal() {
    editingRollId = null;
    $('editRollModal').hidden = true;
    releaseModalScroll();
  }

  async function saveEditedRoll() {
    const id = editingRollId;
    if (!id) return;
    const player = getSelectedPlayer($('editRollPlayer'));
    const value = parseInt($('editRollValue').value, 10);
    if (!player) {
      showToast('Select a player', 'error');
      return;
    }
    if (!Number.isInteger(value) || value < 2 || value > 12) {
      showToast('Roll must be between 2 and 12', 'error');
      return;
    }
    const calledIt = $('editRollCalledIt').checked;
    const calledById = calledIt ? $('editRollCalledBy').value : null;
    if (calledIt && !calledById) {
      showToast('Choose who called it', 'error');
      return;
    }
    const updated = await api(`/api/rolls/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        playerId: player.id,
        playerName: player.name,
        value,
        knightPlayed: $('editRollKnight').checked,
        calledIt,
        calledById,
      }),
    });
    const index = rolls.findIndex((entry) => entry.id === id);
    if (index !== -1) rolls[index] = updated;
    closeEditRollModal();
    refreshAfterRollChange();
    showToast(`Roll updated: ${updated.playerName} rolled ${updated.value}`);
  }

  function releaseModalScroll() {
    const open = ['playersModal', 'pastGamesModal', 'gameModal', 'editRollModal', 'gameRollsModal'].some((id) => !$(id).hidden);
    if (!open) document.body.style.overflow = '';
  }

  function renderWinnerHistory() {
    const list = $('winnerHistory');
    const recent = [...winners].reverse().slice(0, 10);
    if (recent.length === 0) {
      list.innerHTML = '<li class="empty-state">No winners recorded yet</li>';
      return;
    }
    list.innerHTML = recent.map((w) => `
      <li>
        <span><span class="trophy">&#9733;</span>${escapeHtml(w.playerName)}${w.winnerHadKnight === true ? ' <span class="knight-badge" title="Winner had played a knight" aria-label="Winner had played a knight">&#9822;</span>' : ''}</span>
        <span class="roll-time">${formatTimestamp(w.timestamp)}</span>
      </li>
    `).join('');
  }

  function renderGameInfo(gamesData) {
    const info = $('gameInfo');
    const endBtn = $('endGame');
    const deleteBtn = $('deleteCurrentGame');
    const winnerSelect = $('winnerPlayer');
    const winnerBtn = $('recordWinnerBtn');

    $('openGame').classList.toggle('game-active', Boolean(currentGameId));

    if (currentGameId) {
      const game = gamesData.games.find((g) => g.id === currentGameId);
      const started = game ? `${formatRollDate(game.startedAt)} at ${formatRollTime(game.startedAt)}` : 'unknown';
      info.textContent = `Active game — started ${started}`;
      endBtn.disabled = false;
      deleteBtn.disabled = false;
      winnerSelect.disabled = false;
      winnerBtn.disabled = false;
      $('winnerHadKnight').disabled = false;
    } else {
      info.textContent = 'No active game — start one to group rolls';
      endBtn.disabled = true;
      deleteBtn.disabled = true;
      winnerSelect.disabled = true;
      winnerBtn.disabled = true;
      $('winnerHadKnight').disabled = true;
    }
  }

  function renderChartGameOptions() {
    const select = $('chartScope');
    if (!select) return;
    const previous = select.value || 'game';
    const pastGames = getSortedGames().filter((game) => game.id !== currentGameId);
    const pastOptions = pastGames.map((game) => {
      const count = getRollsForGame(game.id).length;
      const winner = getWinnerForGame(game.id);
      const winnerText = winner ? ` · ${winner.playerName}` : '';
      const label = `${formatRollDate(game.startedAt)} · ${count} roll${count === 1 ? '' : 's'}${winnerText}`;
      return `<option value="${game.id}">${escapeHtml(label)}</option>`;
    }).join('');
    const group = pastOptions ? `<optgroup label="Past games">${pastOptions}</optgroup>` : '';
    select.innerHTML = `<option value="game">Current game</option><option value="all">All time</option>${group}`;
    const valid = [...select.options].some((option) => option.value === previous);
    select.value = valid ? previous : 'game';
  }

  function renderTurnOrder() {
    const order = (currentGameId ? getActiveTurnOrder() : getEditingTurnOrder())
      .filter((id) => players.some((player) => player.id === id));
    const list = $('turnOrderList');
    const empty = $('turnOrderEmpty');
    empty.hidden = order.length > 0;

    list.innerHTML = order.map((id, index) => {
      const player = players.find((entry) => entry.id === id);
      return `
        <li>
          <span class="turn-order-name">${escapeHtml(player.name)}</span>
          <span class="turn-order-actions">
            <button type="button" class="btn" data-move="up" data-id="${id}" ${index === 0 ? 'disabled' : ''}>Up</button>
            <button type="button" class="btn" data-move="down" data-id="${id}" ${index === order.length - 1 ? 'disabled' : ''}>Down</button>
            <button type="button" class="btn btn-danger" data-move="remove" data-id="${id}">Remove</button>
          </span>
        </li>
      `;
    }).join('');

    list.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => onTurnOrderAction(btn.dataset.move, btn.dataset.id));
    });

    const remaining = players.filter((player) => !order.includes(player.id));
    $('turnOrderPlayer').innerHTML = `<option value="">Add player…</option>${
      remaining.map((player) => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join('')
    }`;
  }

  async function setTurnOrder(nextOrder) {
    const unique = [];
    nextOrder.forEach((id) => {
      if (typeof id === 'string' && id && !unique.includes(id) && players.some((player) => player.id === id)) {
        unique.push(id);
      }
    });

    if (currentGameId) {
      const game = await api(`/api/games/${currentGameId}/order`, {
        method: 'PATCH',
        body: JSON.stringify({ playerOrder: unique }),
      });
      const index = games.findIndex((entry) => entry.id === game.id);
      if (index === -1) games.push(game);
      else games[index] = game;
    } else {
      draftTurnOrder = unique;
    }
    renderTurnOrder();
  }

  async function onTurnOrderAction(action, id) {
    const order = (currentGameId ? getActiveTurnOrder() : getEditingTurnOrder())
      .filter((playerId) => players.some((player) => player.id === playerId));
    const index = order.indexOf(id);
    if (index === -1) return;
    if (action === 'remove') {
      order.splice(index, 1);
    } else if (action === 'up' && index > 0) {
      [order[index - 1], order[index]] = [order[index], order[index - 1]];
    } else if (action === 'down' && index < order.length - 1) {
      [order[index + 1], order[index]] = [order[index], order[index + 1]];
    } else {
      return;
    }
    try {
      await setTurnOrder(order);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function selectNextPlayer(recordedPlayerId) {
    const order = getActiveTurnOrder();
    if (order.length === 0) return;
    const index = order.indexOf(recordedPlayerId);
    const nextId = index === -1 ? order[0] : order[(index + 1) % order.length];
    const select = $('rollPlayer');
    if ([...select.options].some((option) => option.value === nextId)) {
      select.value = nextId;
    }
  }

  function buildRollCounts(scopedRolls) {
    const counts = Object.fromEntries(CATAN_VALUES.map((v) => [v, 0]));
    scopedRolls.forEach((r) => {
      if (counts[r.value] !== undefined) counts[r.value]++;
    });
    return counts;
  }

  function getChartType() {
    return document.querySelector('input[name="chartType"]:checked')?.value || 'bar';
  }

  function rollBarColors() {
    return CATAN_VALUES.map((v) =>
      v === 7 ? 'rgba(232, 93, 93, 0.75)' :
      HOT_NUMBERS.has(v) ? 'rgba(232, 168, 56, 0.75)' :
      'rgba(61, 139, 253, 0.65)'
    );
  }

  function solidRollColors(bgColors) {
    return bgColors.map((c) => c.replace('0.75', '1').replace('0.65', '1'));
  }

  function buildChartDataset(data, type) {
    const bgColors = rollBarColors();
    const borderColors = solidRollColors(bgColors);
    if (type === 'line') {
      return {
        label: 'Rolls',
        data,
        borderColor: 'rgba(61, 139, 253, 0.95)',
        backgroundColor: 'rgba(61, 139, 253, 0.15)',
        pointBackgroundColor: borderColors,
        pointBorderColor: '#162030',
        pointHoverBackgroundColor: borderColors,
        pointRadius: 5,
        pointHoverRadius: 7,
        pointBorderWidth: 2,
        borderWidth: 2,
        tension: 0.35,
        fill: true,
      };
    }
    return {
      label: 'Rolls',
      data,
      backgroundColor: bgColors,
      borderColor: borderColors,
      borderWidth: 1,
      borderRadius: 4,
    };
  }

  function chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `Rolled ${items[0].label}`,
            label: (item) => `${item.raw} time${item.raw === 1 ? '' : 's'}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Dice Total', color: '#8b9cb3' },
          ticks: { color: '#8b9cb3' },
          grid: { color: 'rgba(45, 63, 86, 0.5)' },
        },
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1, color: '#8b9cb3' },
          grid: { color: 'rgba(45, 63, 86, 0.5)' },
        },
      },
    };
  }

  function renderChartScopeNote(scopedRolls) {
    const note = $('chartScopeNote');
    const count = scopedRolls.length;
    const noun = count === 1 ? 'roll' : 'rolls';
    const scope = getChartScope();
    if (scope === 'all') {
      note.textContent = `${count} ${noun} across all games`;
      return;
    }
    if (scope === 'past') {
      const gameId = chartScopeValue();
      const game = games.find((entry) => entry.id === gameId);
      const when = game ? formatRollDate(game.startedAt) : 'that game';
      note.textContent = `${count} ${noun} on ${when}`;
      return;
    }
    if (!currentGameId) {
      note.textContent = 'No active game. These totals stay at zero until a game is started.';
      return;
    }
    note.textContent = `${count} ${noun} in the current game`;
  }

  function updateChart() {
    const scoped = getScopedRolls();
    renderChartScopeNote(scoped);
    const counts = buildRollCounts(scoped);
    const labels = CATAN_VALUES.map(String);
    const data = CATAN_VALUES.map((v) => counts[v]);
    const type = getChartType();

    if (rollChart && rollChart.config.type !== type) {
      rollChart.destroy();
      rollChart = null;
    }

    if (!rollChart) {
      rollChart = new Chart($('rollChart').getContext('2d'), {
        type,
        data: {
          labels,
          datasets: [buildChartDataset(data, type)],
        },
        options: chartOptions(),
      });
      return;
    }

    rollChart.data.datasets[0].data = data;
    rollChart.update('none');
  }

  function diceSvg(face) {
    const pips = PIP_LAYOUTS[face].map(([x, y]) =>
      `<circle class="die-pip" cx="${x}" cy="${y}" r="8"/>`
    ).join('');
    return `<svg class="die" viewBox="0 0 100 100" aria-hidden="true"><rect class="die-face" x="6" y="6" width="88" height="88" rx="16"/>${pips}</svg>`;
  }

  function diceWaysLabel(ways) {
    return ways.map(([a, b]) => `${a} and ${b}`).join(', or ');
  }

  function syncDiceSelection() {
    const value = String($('rollValue').value || '');
    document.querySelectorAll('.quick-roll-btn').forEach((btn) => {
      const selected = btn.dataset.value === value;
      btn.classList.toggle('selected', selected);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  // Board order: top row 2-6, then the tall 7, then the bottom row reversed (12 under 2 ... 8 under 6).
  // DOM order follows the visual order so Tab moves across each row left to right.
  const QUICK_ROLL_ORDER = [2, 3, 4, 5, 6, 7, 12, 11, 10, 9, 8];

  function buildQuickRolls() {
    const container = $('quickRolls');
    container.innerHTML = QUICK_ROLL_ORDER.map((value) => {
      const ways = DICE_WAYS[value];
      const pairs = ways.map(([a, b]) => `<span class="dice-pair">${diceSvg(a)}${diceSvg(b)}</span>`).join('');
      const tone = value === 7 ? ' seven' : HOT_NUMBERS.has(value) ? ' hot' : '';
      return `
        <button type="button" class="btn quick-roll-btn${tone}" data-value="${value}" aria-label="Set roll to ${value}: ${diceWaysLabel(ways)}">
          <span class="dice-total">${value}</span>
          <span class="dice-ways">${pairs}</span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.quick-roll-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('rollValue').value = btn.dataset.value;
        syncDiceSelection();
      });
    });
    syncDiceSelection();
  }

  // --- Actions ---

  async function addPlayer(name) {
    const player = await api('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    players.push(player);
    renderPlayers();
    populatePlayerSelects();
    renderTurnOrder();
    showToast(`Added player: ${player.name}`);
  }

  async function deletePlayer(id) {
    await api(`/api/players/${id}`, { method: 'DELETE' });
    players = players.filter((p) => p.id !== id);
    renderPlayers();
    populatePlayerSelects();
    await setTurnOrder(getEditingTurnOrder().filter((playerId) => playerId !== id));
    showToast('Player removed');
  }

  async function recordRoll(playerId, playerName, value) {
    const knightPlayed = $('rollKnightPlayed').checked;
    const calledIt = $('rollCalledIt').checked;
    const calledById = calledIt ? $('rollCalledBy').value : null;
    if (calledIt && !calledById) {
      showToast('Choose who called it', 'error');
      return;
    }
    const roll = await api('/api/rolls', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        playerName,
        value,
        gameId: currentGameId,
        knightPlayed,
        calledIt,
        calledById,
      }),
    });
    rolls.push(roll);
    updateChart();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    renderChartGameOptions();
    if (!$('pastGamesModal').hidden && selectedPastGameId === currentGameId) {
      renderPastGamesList();
      renderPastGameDetail(selectedPastGameId);
    }
    showToast(`${playerName} rolled ${value}`);
    $('rollValue').value = '';
    $('rollKnightPlayed').checked = false;
    $('rollCalledIt').checked = false;
    syncCalledByField('rollCalledIt', 'rollCalledByField', 'rollCalledBy');
    syncDiceSelection();
    selectNextPlayer(playerId);
    resetTimer();
  }

  async function recordWinner(playerId, playerName) {
    const winnerHadKnight = $('winnerHadKnight').checked;
    const winner = await api('/api/winners', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        playerName,
        gameId: currentGameId,
        winnerHadKnight,
      }),
    });
    winners.push(winner);
    $('winnerHadKnight').checked = false;
    renderWinnerHistory();
    renderChartGameOptions();
    if (!$('pastGamesModal').hidden && selectedPastGameId === currentGameId) {
      renderPastGamesList();
      renderPastGameDetail(selectedPastGameId);
    }
    showToast(`${playerName} wins!`);
  }

  async function startNewGame() {
    const playerOrder = getEditingTurnOrder().filter((id) => players.some((player) => player.id === id));
    const typedGoal = Number($('pointGoal').value);
    const pointGoal = Number.isInteger(typedGoal) && typedGoal >= 1 && typedGoal <= 99
      ? typedGoal
      : pointGoalOf(currentGame() || { pointGoal: draftPointGoal });
    const game = await api('/api/games', {
      method: 'POST',
      body: JSON.stringify({ playerOrder, pointGoal }),
    });
    currentGameId = game.id;
    games.push(game);
    const gamesData = await api('/api/games');
    renderGameInfo(gamesData);
    renderTurnOrder();
    renderChartGameOptions();
    updateChart();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    if (playerOrder[0]) $('rollPlayer').value = playerOrder[0];
    updateHeaderStatus();
    showToast('New game started');
  }

  async function savePointGoal(rawValue) {
    const goal = Number(rawValue);
    if (!Number.isInteger(goal) || goal < 1 || goal > 99) {
      updateHeaderStatus();
      throw new Error('Points to win must be a whole number from 1 to 99');
    }
    if (currentGameId) {
      const game = await api(`/api/games/${currentGameId}/goal`, {
        method: 'PATCH',
        body: JSON.stringify({ pointGoal: goal }),
      });
      const index = games.findIndex((entry) => entry.id === game.id);
      if (index === -1) games.push(game);
      else games[index] = game;
    } else {
      draftPointGoal = goal;
    }
    updateHeaderStatus();
  }

  async function deleteRoll(id) {
    const roll = rolls.find((entry) => entry.id === id);
    if (!roll) return;
    const confirmed = window.confirm(`Delete ${roll.playerName}'s roll of ${roll.value}?`);
    if (!confirmed) return;
    await api(`/api/rolls/${id}`, { method: 'DELETE' });
    rolls = rolls.filter((entry) => entry.id !== id);
    refreshAfterRollChange();
    showToast('Roll deleted');
  }

  async function deleteGame(id) {
    const game = games.find((entry) => entry.id === id);
    if (!game) return;
    const count = getRollsForGame(id).length;
    const rollText = `${count} roll${count === 1 ? '' : 's'}`;
    const confirmed = window.confirm(`Delete the ${formatRollDate(game.startedAt)} game and its ${rollText}? This also removes its winner.`);
    if (!confirmed) return;
    await api(`/api/games/${id}`, { method: 'DELETE' });
    if (currentGameId === id) {
      draftTurnOrder = [...(game.playerOrder || [])];
      draftPointGoal = pointGoalOf(game);
      currentGameId = null;
    }
    games = games.filter((entry) => entry.id !== id);
    rolls = rolls.filter((entry) => entry.gameId !== id);
    winners = winners.filter((entry) => entry.gameId !== id);
    if (selectedPastGameId === id) {
      selectedPastGameId = getSortedGames()[0]?.id || null;
    }
    const gamesData = await api('/api/games');
    games = gamesData.games;
    currentGameId = gamesData.currentGameId;
    renderGameInfo(gamesData);
    renderTurnOrder();
    renderWinnerHistory();
    renderChartGameOptions();
    updateHeaderStatus();
    refreshAfterRollChange();
    if (!$('pastGamesModal').hidden) {
      renderPastGamesList();
      if (selectedPastGameId) renderPastGameDetail(selectedPastGameId);
      else $('pastGameDetail').innerHTML = '<p class="empty-state">No games recorded yet</p>';
    }
    showToast('Game deleted');
  }

  function refreshAfterRollChange() {
    updateChart();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    renderChartGameOptions();
    if (!$('pastGamesModal').hidden) {
      renderPastGamesList();
      if (selectedPastGameId) renderPastGameDetail(selectedPastGameId);
    }
  }

  async function endCurrentGame() {
    if (!currentGameId) return;
    const endedId = currentGameId;
    const endedGame = await api(`/api/games/${endedId}/end`, { method: 'PATCH' });
    const gameIndex = games.findIndex((g) => g.id === endedId);
    if (gameIndex !== -1) games[gameIndex] = endedGame;
    draftTurnOrder = [...(endedGame.playerOrder || [])];
    draftPointGoal = pointGoalOf(endedGame);
    currentGameId = null;
    const gamesData = await api('/api/games');
    renderGameInfo(gamesData);
    renderTurnOrder();
    renderChartGameOptions();
    updateChart();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    updateHeaderStatus();
    showToast('Game ended');
  }

  function pointGoalOf(game) {
    const goal = Number(game && game.pointGoal);
    if (Number.isInteger(goal) && goal >= 1 && goal <= 99) return goal;
    return DEFAULT_POINT_GOAL;
  }

  function currentGame() {
    if (!currentGameId) return null;
    return games.find((game) => game.id === currentGameId) || null;
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    if (hours > 0) return `${hours}:${mm}:${ss}`;
    return `${minutes}:${ss}`;
  }

  function formatGameLength(game) {
    if (!game || !game.startedAt) return '—';
    const start = new Date(game.startedAt).getTime();
    const end = game.endedAt ? new Date(game.endedAt).getTime() : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
    return formatElapsed(end - start);
  }

  function hasBias(game) {
    return Boolean(game) && game.bias === true;
  }

  function renderBiasBadge(game) {
    return hasBias(game)
      ? '<span class="bias-badge" title="The gavel of no bias was overruled">&#9878; Bias</span>'
      : '';
  }

  function updateBiasToggle(game) {
    const btn = $('biasToggle');
    const active = Boolean(game) && !game.endedAt;
    const bias = active && hasBias(game);
    btn.disabled = !active;
    btn.classList.toggle('is-biased', bias);
    btn.setAttribute('aria-pressed', String(bias));
    $('biasValue').textContent = bias ? 'Yes!' : 'No';
    btn.title = !active
      ? 'Start a game to record bias'
      : (bias ? 'Bias detected this game. Click to clear the record.' : 'The game of no bias. Click if there was bias.');
  }

  async function toggleBias() {
    const game = currentGame();
    if (!game || game.endedAt) return;
    const bias = !hasBias(game);
    const updated = await api(`/api/games/${game.id}/bias`, {
      method: 'PATCH',
      body: JSON.stringify({ bias }),
    });
    const index = games.findIndex((g) => g.id === game.id);
    if (index !== -1) games[index] = updated;
    updateHeaderStatus();
    if (!$('pastGamesModal').hidden) {
      renderPastGamesList();
      if (selectedPastGameId) renderPastGameDetail(selectedPastGameId);
    }
    showToast(bias ? 'Bias recorded. The gavel is disappointed.' : 'Bias cleared. No bias here.');
  }

  function updateHeaderStatus() {
    const game = currentGame();
    updateBiasToggle(game);
    const goal = game ? pointGoalOf(game) : draftPointGoal;
    $('pointGoalValue').textContent = String(goal);
    const goalInput = $('pointGoal');
    if (goalInput && document.activeElement !== goalInput) goalInput.value = String(goal);

    const clock = $('gameClock');
    const clockValue = $('gameClockValue');
    if (!game || game.endedAt) {
      clockValue.textContent = '—';
      clock.classList.remove('is-live');
    } else {
      clockValue.textContent = formatGameLength(game);
      clock.classList.add('is-live');
    }

    const durationEl = $('pastGameDuration');
    const pointsEl = $('pastGamePoints');
    if (selectedPastGameId && (durationEl || pointsEl)) {
      const selected = games.find((entry) => entry.id === selectedPastGameId);
      if (selected) {
        if (durationEl) durationEl.textContent = formatGameLength(selected);
        if (pointsEl) pointsEl.textContent = String(pointGoalOf(selected));
      }
    }
  }

  function startGameClock() {
    if (gameClockInterval) clearInterval(gameClockInterval);
    updateHeaderStatus();
    gameClockInterval = setInterval(updateHeaderStatus, 1000);
  }

  // --- Utilities ---

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  function formatTimestamp(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatRollDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function formatRollTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function getSelectedPlayer(selectEl) {
    const option = selectEl.selectedOptions[0];
    if (!option || !option.value) return null;
    return { id: option.value, name: option.dataset.name || option.textContent };
  }

  // --- Event wiring ---

  function bindEvents() {
    ['pointerdown', 'keydown', 'touchstart'].forEach((type) => {
      document.addEventListener(type, unlockTimerSound, { capture: true, passive: true });
    });
    $('timerPlay').addEventListener('click', playTimer);
    $('timerPause').addEventListener('click', pauseTimer);
    $('timerReset').addEventListener('click', resetTimer);
    $('timerExpiredOverlay').addEventListener('click', () => setTimerExpired(false));

    ['timerMinutes', 'timerSeconds'].forEach((id) => {
      $(id).addEventListener('change', () => {
        if (!timerRunning) resetTimer();
      });
    });

    $('playerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('playerName');
      const name = input.value.trim();
      if (!name) return;
      try {
        await addPlayer(name);
        input.value = '';
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('rollForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const player = getSelectedPlayer($('rollPlayer'));
      const value = parseInt($('rollValue').value, 10);
      if (!player) {
        showToast('Select a player first', 'error');
        return;
      }
      try {
        await recordRoll(player.id, player.name, value);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('winnerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const player = getSelectedPlayer($('winnerPlayer'));
      if (!player) {
        showToast('Select a winner', 'error');
        return;
      }
      try {
        await recordWinner(player.id, player.name);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('newGame').addEventListener('click', async () => {
      try {
        await startNewGame();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('endGame').addEventListener('click', async () => {
      try {
        await endCurrentGame();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('pointGoal').addEventListener('change', async () => {
      try {
        await savePointGoal($('pointGoal').value);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('deleteCurrentGame').addEventListener('click', async () => {
      if (!currentGameId) return;
      try {
        await deleteGame(currentGameId);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('rollValue').addEventListener('input', syncDiceSelection);
    $('biasToggle').addEventListener('click', () => {
      toggleBias().catch((err) => showToast(err.message, 'error'));
    });

    $('rollCalledIt').addEventListener('change', () => {
      syncCalledByField('rollCalledIt', 'rollCalledByField', 'rollCalledBy');
    });
    $('editRollCalledIt').addEventListener('change', () => {
      syncCalledByField('editRollCalledIt', 'editRollCalledByField', 'editRollCalledBy');
    });

    document.querySelectorAll('input[name="chartType"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        updateChart();
      });
    });

    $('chartScope').addEventListener('change', () => {
      updateChart();
    });

    $('addTurnPlayer').addEventListener('click', async () => {
      const id = $('turnOrderPlayer').value;
      if (!id) {
        showToast('Choose a player to add', 'error');
        return;
      }
      try {
        await setTurnOrder([...getEditingTurnOrder(), id]);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    $('openGame').addEventListener('click', openGameModal);
    $('closeGame').addEventListener('click', closeGameModal);
    $('gameBackdrop').addEventListener('click', closeGameModal);

    $('openPlayers').addEventListener('click', openPlayersModal);
    $('closePlayers').addEventListener('click', closePlayersModal);
    $('playersBackdrop').addEventListener('click', closePlayersModal);

    $('editRollForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await saveEditedRoll();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    $('cancelEditRoll').addEventListener('click', closeEditRollModal);
    $('closeEditRoll').addEventListener('click', closeEditRollModal);
    $('editRollBackdrop').addEventListener('click', closeEditRollModal);

    $('expandGameRolls').addEventListener('click', openGameRollsModal);
    $('closeGameRolls').addEventListener('click', closeGameRollsModal);
    $('gameRollsBackdrop').addEventListener('click', closeGameRollsModal);

    $('openPastGames').addEventListener('click', openPastGamesModal);
    $('closePastGames').addEventListener('click', closePastGamesModal);
    $('pastGamesBackdrop').addEventListener('click', closePastGamesModal);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('editRollModal').hidden) closeEditRollModal();
      else if (!$('gameRollsModal').hidden) closeGameRollsModal();
      else if (!$('gameModal').hidden) closeGameModal();
      else if (!$('playersModal').hidden) closePlayersModal();
      else if (!$('pastGamesModal').hidden) closePastGamesModal();
    });
  }

  // --- Init ---

  async function init() {
    buildQuickRolls();
    bindEvents();
    resetTimer();

    try {
      await Promise.all([loadPlayers(), loadRolls(), loadWinners(), loadGames()]);
      renderTurnOrder();
      renderChartGameOptions();
      renderScoreboard();
      renderPlayerBreakdown();
      renderGameRollHistory();
      updateChart();
      updateHeaderStatus();
    } catch (err) {
      showToast('Failed to load data: ' + err.message, 'error');
    }
    startGameClock();
  }

  document.addEventListener('DOMContentLoaded', init);
})();