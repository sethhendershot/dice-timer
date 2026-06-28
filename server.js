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
  const { playerId, playerName, value, gameId } = req.body;
  const rollValue = Number(value);
  if (!playerId || !playerName) {
    return res.status(400).json({ error: 'Player is required' });
  }
  if (!Number.isInteger(rollValue) || rollValue < 2 || rollValue > 12) {
    return res.status(400).json({ error: 'Roll must be an integer between 2 and 12' });
  }
  const data = readJson(FILES.rolls);
  const roll = {
    id: newId(),
    playerId,
    playerName,
    value: rollValue,
    gameId: gameId || null,
    timestamp: new Date().toISOString(),
  };
  data.rolls.push(roll);
  writeJson(FILES.rolls, data);
  res.status(201).json(roll);
});

// --- Winners ---

app.get('/api/winners', (req, res) => {
  res.json(readJson(FILES.winners));
});

app.post('/api/winners', (req, res) => {
  const { playerId, playerName, gameId } = req.body;
  if (!playerId || !playerName) {
    return res.status(400).json({ error: 'Player is required' });
  }
  const data = readJson(FILES.winners);
  const winner = {
    id: newId(),
    playerId,
    playerName,
    gameId: gameId || null,
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
  const data = readJson(FILES.games);
  const game = {
    id: newId(),
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  data.games.push(game);
  data.currentGameId = game.id;
  writeJson(FILES.games, data);
  res.status(201).json(game);
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

app.listen(PORT, () => {
  ensureDataDir();
  console.log(`Dice Timer running at http://localhost:${PORT}`);
});