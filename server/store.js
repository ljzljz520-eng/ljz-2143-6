import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.VOW_DATA_DIR || path.resolve('data');
let ASSET_DIR = path.join(DATA_DIR, 'assets');
let DB_FILE = path.join(DATA_DIR, 'db.json');

const emptyDatabase = () => ({
  schema: 1,
  events: [],
  devices: [],
  screenGroups: [],
  assets: [],
  versions: [],
  releases: [],
  screenshots: [],
  audits: []
});

function ensureStorage() {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(emptyDatabase(), null, 2));
  }
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export class JsonStore {
  constructor(file = DB_FILE) {
    this.file = file;
    ensureStorage();
    this.db = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...emptyDatabase(), ...parsed };
    } catch (error) {
      throw new Error(`Cannot read event database ${this.file}: ${error.message}`);
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get state() {
    return this.db;
  }

  list(collection, predicate) {
    const rows = this.db[collection] || [];
    return clone(predicate ? rows.filter(predicate) : rows);
  }

  find(collection, predicate) {
    return clone((this.db[collection] || []).find(predicate));
  }

  getById(collection, id) {
    return this.find(collection, (row) => row.id === id);
  }

  insert(collection, row) {
    if (!this.db[collection]) this.db[collection] = [];
    this.db[collection].push(row);
    this.save();
    return clone(row);
  }

  update(collection, id, patch) {
    const row = (this.db[collection] || []).find((item) => item.id === id);
    if (!row) throw Object.assign(new Error(`${collection} not found`), { status: 404 });
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return clone(row);
  }

  replace(collection, predicate, nextFactory) {
    const rows = this.db[collection] || [];
    let changed = 0;
    rows.forEach((row, index) => {
      if (predicate(row)) {
        rows[index] = nextFactory(clone(row));
        changed += 1;
      }
    });
    if (changed) this.save();
    return changed;
  }
}

export const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
export const now = () => new Date().toISOString();
export function configureStorage(dataDir = DATA_DIR) {
  const root = path.resolve(dataDir);
  ASSET_DIR = path.join(root, 'assets');
  DB_FILE = path.join(root, 'db.json');
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  return { DATA_DIR: root, ASSET_DIR, DB_FILE };
}

export const publicAssetPath = path.join(DATA_DIR, 'assets');
export { DATA_DIR, ASSET_DIR, DB_FILE, clone };
