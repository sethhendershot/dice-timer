const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FILES = {
  players: 'players.json',
  rolls: 'rolls.json',
  winners: 'winners.json',
  games: 'games.json',
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultData(filename) {
  const defaults = {
    'players.json': { players: [] },
    'rolls.json': { rolls: [] },
    'winners.json': { winners: [] },
    'games.json': { currentGameId: null, games: [] },
  };
  return defaults[filename] || {};
}

function readJson(filename) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    const data = defaultData(filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return data;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeJson(filename, data) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function newId() {
  return crypto.randomUUID();
}

function parsePointGoal(value) {
  if (value === undefined || value === null || value === '') return 21;
  const goal = Number(value);
  if (!Number.isInteger(goal) || goal < 1 || goal > 99) return null;
  return goal;
}

function cleanPlayerOrder(value) {
  if (!Array.isArray(value)) return [];
  const known = new Set(readJson(FILES.players).players.map((player) => player.id));
  const seen = new Set();
  const order = [];
  value.forEach((id) => {
    if (typeof id !== 'string') return;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed) || !known.has(trimmed)) return;
    seen.add(trimmed);
    order.push(trimmed);
  });
  return order;
}

const BUILD_FIELDS = ['roadsBuilt', 'settlementsBuilt', 'citiesBuilt'];
const BUILD_LABELS = { roadsBuilt: 'Roads built', settlementsBuilt: 'Settlements built', citiesBuilt: 'Cities built' };
const MAX_BUILDS_PER_TURN = 15;

// Reads roadsBuilt/settlementsBuilt/citiesBuilt from a request body.
// Missing fields default to 0 when fillMissing is true, otherwise they are skipped.
function parseBuildCounts(body, fillMissing) {
  const counts = {};
  for (const field of BUILD_FIELDS) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (fillMissing) counts[field] = 0;
      continue;
    }
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 0 || count > MAX_BUILDS_PER_TURN) {
      return { error: `${BUILD_LABELS[field]} must be a whole number from 0 to ${MAX_BUILDS_PER_TURN}` };
    }
    counts[field] = count;
  }
  return { counts };
}

function parseAwardHolder(value) {
  if (value === null || value === '') return { id: null };
  if (typeof value !== 'string') return { error: 'Award holder must be a player id or null' };
  const id = value.trim();
  const known = readJson(FILES.players).players.some((player) => player.id === id);
  if (!known) return { error: 'Award holder must be a known player' };
  return { id };
}

// Resolves the "called it" fields for a roll. Returns { error } or { calledIt, calledById, calledByName }.
// existing is the roll being edited (if any) so a caller who has since been removed can be kept as-is.
function resolveCalledIt(calledIt, calledById, existing) {
  if (typeof calledIt !== 'boolean') {
    return { error: 'Called it must be true or false' };
  }
  if (!calledIt) {
    if (calledById !== undefined && calledById !== null && calledById !== '') {
      return { error: 'Called by is only allowed when Called it is checked' };
    }
    return { calledIt: false, calledById: null, calledByName: null };
  }
  const id = typeof calledById === 'string' ? calledById.trim() : '';
  if (!id) {
    return { error: 'Choose who called it' };
  }
  const player = readJson(FILES.players).players.find((entry) => entry.id === id);
  if (player) {
    return { calledIt: true, calledById: player.id, calledByName: player.name };
  }
  if (existing && existing.calledById === id && existing.calledByName) {
    return { calledIt: true, calledById: id, calledByName: existing.calledByName };
  }
  return { error: 'Called by must be a known player' };
}

// --- Players ---

app.get('/api/players', (req, res) => {
  res.json(readJson(FILES.players));
});

app.post('/api/players', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Player name is required' });
  }
  const data = readJson(FILES.players);
  const player = {
    id: newId(),
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  data.players.push(player);
  writeJson(FILES.players, data);
  res.status(201).json(player);
});

app.delete('/api/players/:id', (req, res) => {
  const data = readJson(FILES.players);
  const index = data.players.findIndex((p) => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Player not found' });
  }
  data.players.splice(index, 1);
  writeJson(FILES.players, data);
  res.json({ ok: true });
});

// --- Rolls ---

app.get('/api/rolls', (req, res) => {
  const data = readJson(FILES.rolls);
  const { gameId } = req.query;
  if (gameId) {
    data.rolls = data.rolls.filter((r) => r.gameId === gameId);
  }
  res.json(data);
});

app.post('/api/rolls', (req, res) => {
  const { playerId, playerName, value, gameId, knightPlayed, calledIt, calledById } = req.body;
  const rollValue = Number(value);
  if (!playerId || !playerName) {
    return res.status(400).json({ error: 'Player is required' });
  }
  if (!Number.isInteger(rollValue) || rollValue < 2 || rollValue > 12) {
    return res.status(400).json({ error: 'Roll must be an integer between 2 and 12' });
  }
  const called = resolveCalledIt(calledIt === undefined ? false : calledIt, calledById);
  if (called.error) {
    return res.status(400).json({ error: called.error });
  }
  const builds = parseBuildCounts(req.body, true);
  if (builds.error) {
    return res.status(400).json({ error: builds.error });
  }
  const data = readJson(FILES.rolls);
  const roll = {
    id: newId(),
    playerId,
    playerName,
    value: rollValue,
    gameId: gameId || null,
    knightPlayed: knightPlayed === true,
    calledIt: called.calledIt,
    calledById: called.calledById,
    calledByName: called.calledByName,
    ...builds.counts,
    timestamp: new Date().toISOString(),
  };
  data.rolls.push(roll);
  writeJson(FILES.rolls, data);
  res.status(201).json(roll);
});

app.patch('/api/rolls/:id', (req, res) => {
  const body = req.body || {};
  const updates = {};

  if (body.value !== undefined) {
    const rollValue = Number(body.value);
    if (!Number.isInteger(rollValue) || rollValue < 2 || rollValue > 12) {
      return res.status(400).json({ error: 'Roll must be an integer between 2 and 12' });
    }
    updates.value = rollValue;
  }

  if (body.playerId !== undefined || body.playerName !== undefined) {
    const playerId = typeof body.playerId === 'string' ? body.playerId.trim() : '';
    const playerName = typeof body.playerName === 'string' ? body.playerName.trim() : '';
    if (!playerId || !playerName) {
      return res.status(400).json({ error: 'Player is required' });
    }
    updates.playerId = playerId;
    updates.playerName = playerName;
  }

  if (body.knightPlayed !== undefined) {
    if (typeof body.knightPlayed !== 'boolean') {
      return res.status(400).json({ error: 'Knight played must be true or false' });
    }
    updates.knightPlayed = body.knightPlayed;
  }

  const builds = parseBuildCounts(body, false);
  if (builds.error) {
    return res.status(400).json({ error: builds.error });
  }
  Object.assign(updates, builds.counts);

  const data = readJson(FILES.rolls);
  const roll = data.rolls.find((entry) => entry.id === req.params.id);
  if (!roll) {
    return res.status(404).json({ error: 'Roll not found' });
  }

  if (body.calledIt !== undefined || body.calledById !== undefined) {
    const calledIt = body.calledIt !== undefined ? body.calledIt : roll.calledIt === true;
    const calledById = body.calledById !== undefined
      ? body.calledById
      : (calledIt === true ? roll.calledById : undefined);
    const called = resolveCalledIt(calledIt, calledById, roll);
    if (called.error) {
      return res.status(400).json({ error: called.error });
    }
    Object.assign(updates, called);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  Object.assign(roll, updates, { editedAt: new Date().toISOString() });
  writeJson(FILES.rolls, data);
  res.json(roll);
});

app.delete('/api/rolls/:id', (req, res) => {
  const data = readJson(FILES.rolls);
  const index = data.rolls.findIndex((roll) => roll.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Roll not found' });
  }
  data.rolls.splice(index, 1);
  writeJson(FILES.rolls, data);
  res.json({ ok: true });
});

// --- Winners ---

app.get('/api/winners', (req, res) => {
  res.json(readJson(FILES.winners));
});

app.post('/api/winners', (req, res) => {
  const { playerId, playerName, gameId, winnerHadKnight } = req.body;
  if (!playerId || !playerName) {
    return res.status(400).json({ error: 'Player is required' });
  }
  const data = readJson(FILES.winners);
  const winner = {
    id: newId(),
    playerId,
    playerName,
    gameId: gameId || null,
    winnerHadKnight: winnerHadKnight === true,
    timestamp: new Date().toISOString(),
  };
  data.winners.push(winner);
  writeJson(FILES.winners, data);
  res.status(201).json(winner);
});

// --- Games ---

app.get('/api/games', (req, res) => {
  res.json(readJson(FILES.games));
});

app.post('/api/games', (req, res) => {
  const pointGoal = parsePointGoal(req.body && req.body.pointGoal);
  if (pointGoal === null) {
    return res.status(400).json({ error: 'Points to win must be a whole number from 1 to 99' });
  }
  const data = readJson(FILES.games);
  const game = {
    id: newId(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    pointGoal,
    playerOrder: cleanPlayerOrder(req.body && req.body.playerOrder),
  };
  data.games.push(game);
  data.currentGameId = game.id;
  writeJson(FILES.games, data);
  res.status(201).json(game);
});

app.patch('/api/games/:id/goal', (req, res) => {
  const pointGoal = parsePointGoal(req.body && req.body.pointGoal);
  if (pointGoal === null) {
    return res.status(400).json({ error: 'Points to win must be a whole number from 1 to 99' });
  }
  const data = readJson(FILES.games);
  const game = data.games.find((entry) => entry.id === req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  game.pointGoal = pointGoal;
  writeJson(FILES.games, data);
  res.json(game);
});

app.patch('/api/games/:id/awards', (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const field of ['longestRoadPlayerId', 'largestArmyPlayerId']) {
    if (body[field] === undefined) continue;
    const holder = parseAwardHolder(body[field]);
    if (holder.error) {
      return res.status(400).json({ error: holder.error });
    }
    updates[field] = holder.id;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const data = readJson(FILES.games);
  const game = data.games.find((entry) => entry.id === req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  Object.assign(game, updates);
  writeJson(FILES.games, data);
  res.json(game);
});

app.patch('/api/games/:id/order', (req, res) => {
  const data = readJson(FILES.games);
  const game = data.games.find((g) => g.id === req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  game.playerOrder = cleanPlayerOrder(req.body && req.body.playerOrder);
  writeJson(FILES.games, data);
  res.json(game);
});

app.patch('/api/games/:id/end', (req, res) => {
  const data = readJson(FILES.games);
  const game = data.games.find((g) => g.id === req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  game.endedAt = new Date().toISOString();
  if (data.currentGameId === game.id) {
    data.currentGameId = null;
  }
  writeJson(FILES.games, data);
  res.json(game);
});

app.delete('/api/games/:id', (req, res) => {
  const gamesData = readJson(FILES.games);
  const index = gamesData.games.findIndex((game) => game.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Game not found' });
  }
  gamesData.games.splice(index, 1);
  if (gamesData.currentGameId === req.params.id) {
    gamesData.currentGameId = null;
  }
  writeJson(FILES.games, gamesData);

  const rollsData = readJson(FILES.rolls);
  rollsData.rolls = rollsData.rolls.filter((roll) => roll.gameId !== req.params.id);
  writeJson(FILES.rolls, rollsData);

  const winnersData = readJson(FILES.winners);
  winnersData.winners = winnersData.winners.filter((winner) => winner.gameId !== req.params.id);
  writeJson(FILES.winners, winnersData);

  res.json({ ok: true });
});

app.listen(PORT, () => {
  ensureDataDir();
  console.log(`Dice Timer running at http://localhost:${PORT}`);
});