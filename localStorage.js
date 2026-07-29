// Reemplaza el localStorage del navegador por uno respaldado en disco (data/store.json),
// para que el motor original (engine.js) no necesite cambios en su lógica de guardado.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'store.json');

let store = {};
try {
  if (fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.warn('No se pudo leer data/store.json, empezando en blanco:', e.message);
  store = {};
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store));
  } catch (e) {
    console.error('No se pudo guardar el estado en disco:', e.message);
  }
}

global.localStorage = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  },
  setItem(key, value) {
    store[key] = String(value);
    persist();
  },
  removeItem(key) {
    delete store[key];
    persist();
  }
};

module.exports = { persist };
