const fs = require('fs');
const path = require('path');

const CREDENTIALS_FILE = '/app/data/credentials.json';

function load() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load credentials:', e.message);
  }
  return { api_keys: {}, bot_tokens: {}, user_ids: {} };
}

function save(data) {
  const dir = path.dirname(CREDENTIALS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function apiKeys() { return load().api_keys || {}; }
function botTokens() { return load().bot_tokens || {}; }
function userIDs() { return load().user_ids || {}; }

function addApiKey(name, provider, key) {
  const data = load();
  if (data.api_keys && data.api_keys[name]) throw new Error(`API key '${name}' already exists`);
  if (!data.api_keys) data.api_keys = {};
  data.api_keys[name] = { provider, key };
  save(data);
}

function updateApiKey(name, provider, key) {
  const data = load();
  if (!data.api_keys) data.api_keys = {};
  data.api_keys[name] = { provider, key };
  save(data);
}

function deleteApiKey(name) {
  const data = load();
  if (data.api_keys) delete data.api_keys[name];
  save(data);
}

function addBotToken(name, token) {
  const data = load();
  if (data.bot_tokens && data.bot_tokens[name]) throw new Error(`Bot token '${name}' already exists`);
  if (!data.bot_tokens) data.bot_tokens = {};
  data.bot_tokens[name] = token;
  save(data);
}

function deleteBotToken(name) {
  const data = load();
  if (data.bot_tokens) delete data.bot_tokens[name];
  save(data);
}

function addUserId(name, uid) {
  const data = load();
  if (data.user_ids && data.user_ids[name]) throw new Error(`User ID '${name}' already exists`);
  if (!data.user_ids) data.user_ids = {};
  data.user_ids[name] = uid;
  save(data);
}

function deleteUserId(name) {
  const data = load();
  if (data.user_ids) delete data.user_ids[name];
  save(data);
}

function maskKey(key) {
  if (!key || key.length <= 8) return '****';
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
}

function importFromBotPrefixes() {
  const bpFile = '/workspace/bot-prefixes.json';
  if (!fs.existsSync(bpFile)) return false;
  try {
    const bpData = JSON.parse(fs.readFileSync(bpFile, 'utf8'));
    const data = load();
    let changed = false;
    if (bpData.bots) {
      for (const [name, token] of Object.entries(bpData.bots)) {
        if (!data.bot_tokens || !data.bot_tokens[name]) {
          if (!data.bot_tokens) data.bot_tokens = {};
          data.bot_tokens[name] = token;
          changed = true;
        }
      }
    }
    if (bpData.users) {
      for (const [name, uid] of Object.entries(bpData.users)) {
        if (!data.user_ids || !data.user_ids[name]) {
          if (!data.user_ids) data.user_ids = {};
          data.user_ids[name] = uid;
          changed = true;
        }
      }
    }
    if (changed) save(data);
    return changed;
  } catch (e) {
    console.error('Failed to import bot-prefixes:', e.message);
    return false;
  }
}

module.exports = {
  load, save,
  apiKeys, botTokens, userIDs,
  addApiKey, updateApiKey, deleteApiKey,
  addBotToken, deleteBotToken,
  addUserId, deleteUserId,
  maskKey, importFromBotPrefixes,
};
