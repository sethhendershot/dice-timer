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

// Settlements, cities and VP cards are tracked per game on the Player Standings table
// (game.builds[playerId] = { settlements, cities, victoryPoints }), not on rolls. Build fields
// sent with a roll (roadsBuilt, settlementsBuilt, citiesBuilt) are ignored; values already stored
// on older rolls are left untouched and still count toward that game's totals.
const GAME_COUNT_FIELDS = ['settlements', 'cities', 'victoryPoints'];
const GAME_COUNT_LABELS = { settlements: 'Settlements', cities: 'Cities', victoryPoints: 'Victory points' };
const MAX_GAME_COUNT = 999;

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

app.patch('/api/games/:id/bias', (req, res) => {
  const bias = req.body && req.body.bias;
  if (typeof bias !== 'boolean') {
    return res.status(400).json({ error: 'Bias must be true or false' });
  }
  const data = readJson(FILES.games);
  const game = data.games.find((entry) => entry.id === req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  game.bias = bias;
  writeJson(FILES.games, data);
  res.json(game);
});

app.patch('/api/games/:id/builds', (req, res) => {
  const body = req.body || {};
  const playerId = typeof body.playerId === 'string' ? body.playerId.trim() : '';
  if (!playerId) {
    return res.status(400).json({ error: 'Player is required' });
  }
  const counts = {};
  for (const field of GAME_COUNT_FIELDS) {
    if (body[field] === undefined) continue;
    const count = body[field];
    if (!Number.isInteger(count) || count < 0 || count > MAX_GAME_COUNT) {
      return res.status(400).json({ error: `${GAME_COUNT_LABELS[field]} must be a whole number from 0 to ${MAX_GAME_COUNT}` });
    }
    counts[field] = count;
  }
  if (Object.keys(counts).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const data = readJson(FILES.games);
  const game = data.games.find((entry) => entry.id === req.params.id);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  const inGame = Array.isArray(game.playerOrder) && game.playerOrder.includes(playerId);
  const known = readJson(FILES.players).players.some((player) => player.id === playerId);
  const rolledInGame = readJson(FILES.rolls).rolls.some((roll) => roll.gameId === game.id && roll.playerId === playerId);
  if (!inGame && !known && !rolledInGame) {
    return res.status(400).json({ error: 'Player is not part of this game' });
  }
  if (!game.builds || typeof game.builds !== 'object' || Array.isArray(game.builds)) {
    game.builds = {};
  }
  const current = game.builds[playerId] || {};
  game.builds[playerId] = {
    settlements: Number.isInteger(current.settlements) ? current.settlements : 0,
    cities: Number.isInteger(current.cities) ? current.cities : 0,
    victoryPoints: Number.isInteger(current.victoryPoints) ? current.victoryPoints : 0,
    ...counts,
  };
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

// --- Timer sound ---

const SOUNDS_DIR = path.join(__dirname, 'public', 'sounds');
const SOUND_SETTINGS_FILE = path.join(__dirname, 'sound-settings.json');
const DEFAULT_SOUND_URL = '/sounds/timer-done.wav';
const MAX_SOUND_BYTES = 5 * 1024 * 1024;
const SOUND_TYPES = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
};

function detectSoundFormat(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

function readSoundSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SOUND_SETTINGS_FILE, 'utf8'));
    if (settings && typeof settings.file === 'string' && /^custom-[\w-]+\.(mp3|wav|ogg)$/.test(settings.file)
      && fs.existsSync(path.join(SOUNDS_DIR, settings.file))) {
      return settings;
    }
  } catch (err) {
    // No settings yet, or unreadable: use the default chime.
  }
  return null;
}

function soundResponse() {
  const settings = readSoundSettings();
  if (!settings) return { url: DEFAULT_SOUND_URL, custom: false, name: null };
  return { url: `/sounds/${settings.file}`, custom: true, name: settings.name || settings.file };
}

app.get('/api/sound', (req, res) => {
  res.json(soundResponse());
});

app.post('/api/sound', (req, res, next) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!SOUND_TYPES[type]) {
    return res.status(415).json({ error: 'Sound must be an MP3, WAV or OGG file' });
  }
  next();
}, express.raw({ type: () => true, limit: MAX_SOUND_BYTES }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return res.status(400).json({ error: 'Sound file is empty' });
  }
  const format = detectSoundFormat(buf);
  if (!format) {
    return res.status(415).json({ error: 'File is not a valid MP3, WAV or OGG sound' });
  }
  let name = '';
  try {
    name = decodeURIComponent(String(req.headers['x-filename'] || ''));
  } catch (err) {
    name = '';
  }
  name = name.replace(/[\u0000-\u001f]/g, '').slice(0, 120) || `sound.${format}`;

  if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
  const file = `custom-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${format}`;
  fs.writeFileSync(path.join(SOUNDS_DIR, file), buf);
  fs.writeFileSync(SOUND_SETTINGS_FILE, JSON.stringify({ file, name, uploadedAt: new Date().toISOString() }, null, 2));
  res.json(soundResponse());
});

app.delete('/api/sound', (req, res) => {
  if (fs.existsSync(SOUND_SETTINGS_FILE)) fs.unlinkSync(SOUND_SETTINGS_FILE);
  res.json(soundResponse());
});

app.use('/api/sound', (err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Sound file is too large (max 5 MB)' });
  }
  next(err);
});

app.listen(PORT, () => {
  ensureDataDir();
  console.log(`Dice Timer running at http://localhost:${PORT}`);
});