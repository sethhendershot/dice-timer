(() => {
  'use strict';

  const CATAN_VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const HOT_NUMBERS = new Set([6, 8]);

  let players = [];
  let rolls = [];
  let winners = [];
  let games = [];
  let currentGameId = null;
  let selectedPastGameId = null;
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
  }

  async function loadRolls() {
    const data = await api('/api/rolls');
    rolls = data.rolls;
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    updateChart();
  }

  async function loadWinners() {
    const data = await api('/api/winners');
    winners = data.winners;
    renderWinnerHistory();
  }

  async function loadGames() {
    const data = await api('/api/games');
    games = data.games;
    currentGameId = data.currentGameId;
    renderGameInfo(data);
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
  }

  function getScopedRolls() {
    const scope = document.querySelector('input[name="chartScope"]:checked')?.value || 'game';
    if (scope === 'game' && currentGameId) {
      return rolls.filter((r) => r.gameId === currentGameId);
    }
    return rolls;
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

  function renderPlayerBreakdown() {
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
    const tbody = $('gameRollHistory');
    const countEl = $('gameRollCount');
    const gameRolls = getGameRolls();

    if (!currentGameId) {
      countEl.textContent = 'No active game';
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Start a game to begin recording rolls</td></tr>';
      return;
    }

    countEl.textContent = `${gameRolls.length} roll${gameRolls.length === 1 ? '' : 's'}`;

    if (gameRolls.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No rolls recorded for this game yet</td></tr>';
      return;
    }

    tbody.innerHTML = renderRollRows(gameRolls);
  }

  function renderRollRows(gameRolls, compact = false) {
    return gameRolls.map((r, index) => `
      <tr>
        <td class="roll-num">${index + 1}</td>
        <td class="roll-value ${rollValueClass(r.value)}">${r.value}</td>
        <td class="roll-player">${escapeHtml(r.playerName)}</td>
        ${compact ? '' : `<td class="roll-date">${formatRollDate(r.timestamp)}</td>`}
        <td class="roll-time">${formatRollTime(r.timestamp)}</td>
      </tr>
    `).join('');
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
            <div class="game-meta">${gameRolls.length} roll${gameRolls.length === 1 ? '' : 's'}${winner ? ` · ${escapeHtml(winner.playerName)} won` : ''}</div>
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
      <h3>${formatRollDate(game.startedAt)}</h3>
      <div class="past-game-stats">
        <span>Started: <strong>${formatRollTime(game.startedAt)}</strong></span>
        <span>Ended: <strong>${endedText}</strong></span>
        <span>Total rolls: <strong>${gameRolls.length}</strong></span>
      </div>
      ${winner
        ? `<div class="past-game-winner"><span class="trophy">&#9733;</span> Winner: <strong>${escapeHtml(winner.playerName)}</strong></div>`
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
            </tr>
          </thead>
          <tbody>
            ${gameRolls.length > 0
              ? renderRollRows(gameRolls)
              : '<tr class="empty-row"><td colspan="5">No rolls recorded for this game</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
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
    if ($('playersModal').hidden) {
      document.body.style.overflow = '';
    }
  }

  function openPlayersModal() {
    renderPlayers();
    $('playersModal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('playerName').focus();
  }

  function closePlayersModal() {
    $('playersModal').hidden = true;
    if ($('pastGamesModal').hidden) {
      document.body.style.overflow = '';
    }
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
        <span><span class="trophy">&#9733;</span>${escapeHtml(w.playerName)}</span>
        <span class="roll-time">${formatTimestamp(w.timestamp)}</span>
      </li>
    `).join('');
  }

  function renderGameInfo(gamesData) {
    const info = $('gameInfo');
    const endBtn = $('endGame');
    const winnerSelect = $('winnerPlayer');
    const winnerBtn = $('recordWinnerBtn');

    if (currentGameId) {
      const game = gamesData.games.find((g) => g.id === currentGameId);
      const started = game ? `${formatRollDate(game.startedAt)} at ${formatRollTime(game.startedAt)}` : 'unknown';
      info.textContent = `Active game — started ${started}`;
      endBtn.disabled = false;
      winnerSelect.disabled = false;
      winnerBtn.disabled = false;
    } else {
      info.textContent = 'No active game — start one to group rolls';
      endBtn.disabled = true;
      winnerSelect.disabled = true;
      winnerBtn.disabled = true;
    }
  }

  function buildRollCounts(scopedRolls) {
    const counts = Object.fromEntries(CATAN_VALUES.map((v) => [v, 0]));
    scopedRolls.forEach((r) => {
      if (counts[r.value] !== undefined) counts[r.value]++;
    });
    return counts;
  }

  function updateChart() {
    const scoped = getScopedRolls();
    const counts = buildRollCounts(scoped);
    const labels = CATAN_VALUES.map(String);
    const data = CATAN_VALUES.map((v) => counts[v]);
    const bgColors = CATAN_VALUES.map((v) =>
      v === 7 ? 'rgba(232, 93, 93, 0.75)' :
      HOT_NUMBERS.has(v) ? 'rgba(232, 168, 56, 0.75)' :
      'rgba(61, 139, 253, 0.65)'
    );

    if (!rollChart) {
      const ctx = $('rollChart').getContext('2d');
      rollChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'Rolls',
            data,
            backgroundColor: bgColors,
            borderColor: bgColors.map((c) => c.replace('0.75', '1').replace('0.65', '1')),
            borderWidth: 1,
            borderRadius: 4,
          }],
        },
        options: {
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
        },
      });
    } else {
      rollChart.data.datasets[0].data = data;
      rollChart.data.datasets[0].backgroundColor = bgColors;
      rollChart.data.datasets[0].borderColor = bgColors.map((c) => c.replace('0.75', '1').replace('0.65', '1'));
      rollChart.update('none');
    }
  }

  function buildQuickRolls() {
    const container = $('quickRolls');
    container.innerHTML = CATAN_VALUES.map((v) => `
      <button type="button" class="btn quick-roll-btn${HOT_NUMBERS.has(v) ? ' hot' : ''}${v === 7 ? ' btn-danger' : ''}" data-value="${v}">${v}</button>
    `).join('');

    container.querySelectorAll('.quick-roll-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $('rollValue').value = btn.dataset.value;
      });
    });
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
    showToast(`Added player: ${player.name}`);
  }

  async function deletePlayer(id) {
    await api(`/api/players/${id}`, { method: 'DELETE' });
    players = players.filter((p) => p.id !== id);
    renderPlayers();
    populatePlayerSelects();
    showToast('Player removed');
  }

  async function recordRoll(playerId, playerName, value) {
    const roll = await api('/api/rolls', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        playerName,
        value,
        gameId: currentGameId,
      }),
    });
    rolls.push(roll);
    updateChart();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    if (!$('pastGamesModal').hidden && selectedPastGameId === currentGameId) {
      renderPastGamesList();
      renderPastGameDetail(selectedPastGameId);
    }
    showToast(`${playerName} rolled ${value}`);
    $('rollValue').value = '';
    resetTimer();
  }

  async function recordWinner(playerId, playerName) {
    const winner = await api('/api/winners', {
      method: 'POST',
      body: JSON.stringify({
        playerId,
        playerName,
        gameId: currentGameId,
      }),
    });
    winners.push(winner);
    renderWinnerHistory();
    if (!$('pastGamesModal').hidden && selectedPastGameId === currentGameId) {
      renderPastGamesList();
      renderPastGameDetail(selectedPastGameId);
    }
    showToast(`${playerName} wins!`);
  }

  async function startNewGame() {
    const game = await api('/api/games', { method: 'POST' });
    currentGameId = game.id;
    games.push(game);
    const gamesData = await api('/api/games');
    renderGameInfo(gamesData);
    updateChart();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    showToast('New game started');
  }

  async function endCurrentGame() {
    if (!currentGameId) return;
    const endedId = currentGameId;
    const endedGame = await api(`/api/games/${endedId}/end`, { method: 'PATCH' });
    const gameIndex = games.findIndex((g) => g.id === endedId);
    if (gameIndex !== -1) games[gameIndex] = endedGame;
    currentGameId = null;
    const gamesData = await api('/api/games');
    renderGameInfo(gamesData);
    updateChart();
    renderScoreboard();
    renderPlayerBreakdown();
    renderGameRollHistory();
    showToast('Game ended');
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

    document.querySelectorAll('input[name="chartScope"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        updateChart();
      });
    });

    $('openPlayers').addEventListener('click', openPlayersModal);
    $('closePlayers').addEventListener('click', closePlayersModal);
    $('playersBackdrop').addEventListener('click', closePlayersModal);

    $('openPastGames').addEventListener('click', openPastGamesModal);
    $('closePastGames').addEventListener('click', closePastGamesModal);
    $('pastGamesBackdrop').addEventListener('click', closePastGamesModal);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('playersModal').hidden) closePlayersModal();
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
      renderScoreboard();
      renderPlayerBreakdown();
      renderGameRollHistory();
    } catch (err) {
      showToast('Failed to load data: ' + err.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();