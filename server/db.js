const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'vm.db');

let db = null;

// Save DB to disk periodically and on changes
function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }
}

// Auto-save every 5 seconds
let saveTimer = setInterval(saveDatabase, 5000);

// Save on process exit
process.on('exit', saveDatabase);
process.on('SIGINT', () => { saveDatabase(); process.exit(); });
process.on('SIGTERM', () => { saveDatabase(); process.exit(); });

async function initDatabase() {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON');

    // ==================== CREATE TABLES ====================
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            displayName TEXT NOT NULL,
            bio TEXT DEFAULT '',
            color TEXT NOT NULL,
            createdAt INTEGER NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS tokens (
            token TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            createdAt INTEGER NOT NULL,
            FOREIGN KEY (userId) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            type TEXT DEFAULT 'private',
            createdAt INTEGER NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS chat_members (
            chatId TEXT NOT NULL,
            userId TEXT NOT NULL,
            joinedAt INTEGER NOT NULL,
            PRIMARY KEY (chatId, userId),
            FOREIGN KEY (chatId) REFERENCES chats(id),
            FOREIGN KEY (userId) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chatId TEXT NOT NULL,
            senderId TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            read INTEGER DEFAULT 0,
            FOREIGN KEY (chatId) REFERENCES chats(id),
            FOREIGN KEY (senderId) REFERENCES users(id)
        )
    `);

    // Add new columns for media messages (safe migration)
    try { db.run('ALTER TABLE messages ADD COLUMN msgType TEXT DEFAULT \'text\''); } catch (e) {}
    try { db.run('ALTER TABLE messages ADD COLUMN fileUrl TEXT DEFAULT NULL'); } catch (e) {}
    try { db.run('ALTER TABLE messages ADD COLUMN fileName TEXT DEFAULT NULL'); } catch (e) {}
    try { db.run('ALTER TABLE messages ADD COLUMN fileSize INTEGER DEFAULT 0'); } catch (e) {}
    try { db.run('ALTER TABLE messages ADD COLUMN duration REAL DEFAULT 0'); } catch (e) {}

    // Create indexes (use IF NOT EXISTS workaround)
    try { db.run('CREATE INDEX idx_messages_chatId ON messages(chatId)'); } catch (e) {}
    try { db.run('CREATE INDEX idx_messages_timestamp ON messages(timestamp)'); } catch (e) {}
    try { db.run('CREATE INDEX idx_chat_members_userId ON chat_members(userId)'); } catch (e) {}
    try { db.run('CREATE INDEX idx_tokens_userId ON tokens(userId)'); } catch (e) {}

    // ==================== SEED DATA ====================
    const COLORS = [
        '#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7',
        '#ee7aae', '#6ec9cb', '#faa774', '#82b1ff', '#f48fb1'
    ];

    const countResult = db.exec('SELECT COUNT(*) as count FROM users');
    const userCount = countResult[0].values[0][0];

    if (userCount === 0) {
        const hashedPassword = bcrypt.hashSync('123', 10);
        const now = Date.now();

        const demoUsers = [
            { id: uuidv4(), username: 'ivan', displayName: 'Иван Петров', bio: 'Люблю программирование', color: COLORS[0] },
            { id: uuidv4(), username: 'anna', displayName: 'Анна Смирнова', bio: 'Дизайнер', color: COLORS[1] },
            { id: uuidv4(), username: 'dmitry', displayName: 'Дмитрий Козлов', bio: 'Менеджер проектов', color: COLORS[3] },
            { id: uuidv4(), username: 'elena', displayName: 'Елена Волкова', bio: '', color: COLORS[4] },
            { id: uuidv4(), username: 'alex', displayName: 'Алексей Новиков', bio: 'Full-stack разработчик', color: COLORS[6] },
        ];

        const stmt = db.prepare('INSERT INTO users (id, username, password, displayName, bio, color, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const u of demoUsers) {
            stmt.run([u.id, u.username, hashedPassword, u.displayName, u.bio, u.color, now]);
        }
        stmt.free();

        saveDatabase();
        console.log('Seeded 5 demo users (password: 123)');
    }

    return db;
}

// ==================== QUERY HELPERS ====================
// sql.js returns results differently than better-sqlite3
// These helpers provide a similar API

function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

function queryGet(sql, params = []) {
    const rows = queryAll(sql, params);
    return rows.length > 0 ? rows[0] : null;
}

function runSql(sql, params = []) {
    db.run(sql, params);
    saveDatabase();
}

module.exports = { initDatabase, queryAll, queryGet, runSql, saveDatabase };
