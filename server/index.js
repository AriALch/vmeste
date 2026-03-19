const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { initDatabase, queryAll, queryGet, runSql } = require('./db');

const app = express();

// Try to load SSL certificates for HTTPS
const certsDir = path.join(__dirname, 'certs');
let server;
let useHttps = false;
try {
    const key = fs.readFileSync(path.join(certsDir, 'key.pem'));
    const cert = fs.readFileSync(path.join(certsDir, 'cert.pem'));
    server = https.createServer({ key, cert }, app);
    useHttps = true;
} catch {
    server = http.createServer(app);
}

const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// ==================== UPLOADS ====================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + '-' + Date.now() + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ==================== MIDDLEWARE ====================
app.use(express.json());

// Serve static files
const ROOT_DIR = path.join(__dirname, '..');
app.use('/public', express.static(path.join(ROOT_DIR, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ==================== AUTH HELPERS ====================
const COLORS = [
    '#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7',
    '#ee7aae', '#6ec9cb', '#faa774', '#82b1ff', '#f48fb1'
];

function authenticate(req, res, next) {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

    const row = queryGet('SELECT userId FROM tokens WHERE token = ?', [token]);
    if (!row) return res.status(401).json({ error: 'Недействительный токен' });

    const user = queryGet('SELECT id, username, displayName, bio, color FROM users WHERE id = ?', [row.userId]);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

    req.user = user;
    next();
}

function sanitizeUser(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        color: user.color
    };
}

// ==================== AUTH ROUTES ====================
app.post('/api/register', (req, res) => {
    const { username, password, displayName } = req.body;

    if (!username || !password || !displayName) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const cleanUsername = username.toLowerCase().trim();
    const existing = queryGet('SELECT id FROM users WHERE username = ?', [cleanUsername]);
    if (existing) {
        return res.status(409).json({ error: 'Это имя уже занято' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const userId = uuidv4();
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const now = Date.now();

    runSql(
        'INSERT INTO users (id, username, password, displayName, bio, color, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, cleanUsername, hashedPassword, displayName.trim(), '', color, now]
    );

    const token = uuidv4();
    runSql('INSERT INTO tokens (token, userId, createdAt) VALUES (?, ?, ?)', [token, userId, now]);

    const user = queryGet('SELECT id, username, displayName, bio, color FROM users WHERE id = ?', [userId]);

    res.json({ user: sanitizeUser(user), token });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Заполните все поля' });
    }

    const user = queryGet('SELECT * FROM users WHERE username = ?', [username.toLowerCase().trim()]);
    if (!user) {
        return res.status(401).json({ error: 'Пользователь не найден' });
    }

    if (!bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Неверный пароль' });
    }

    const token = uuidv4();
    runSql('INSERT INTO tokens (token, userId, createdAt) VALUES (?, ?, ?)', [token, user.id, Date.now()]);

    res.json({ user: sanitizeUser(user), token });
});

// ==================== API ROUTES ====================
app.get('/api/users', authenticate, (req, res) => {
    const users = queryAll('SELECT id, username, displayName, bio, color FROM users WHERE id != ?', [req.user.id]);
    res.json(users);
});

app.get('/api/chats', authenticate, (req, res) => {
    const chats = queryAll(`
        SELECT c.id, c.type, c.createdAt
        FROM chats c
        JOIN chat_members cm ON cm.chatId = c.id
        WHERE cm.userId = ?
    `, [req.user.id]);

    const result = chats.map(chat => {
        // Get members
        const members = queryAll(
            'SELECT u.id, u.username, u.displayName, u.bio, u.color FROM chat_members cm JOIN users u ON u.id = cm.userId WHERE cm.chatId = ?',
            [chat.id]
        );

        // Get last message
        const lastMessage = queryGet(
            'SELECT * FROM messages WHERE chatId = ? ORDER BY timestamp DESC LIMIT 1',
            [chat.id]
        );

        // Count unread
        const unreadRow = queryGet(
            'SELECT COUNT(*) as count FROM messages WHERE chatId = ? AND senderId != ? AND read = 0',
            [chat.id, req.user.id]
        );
        const unread = unreadRow ? unreadRow.count : 0;

        return {
            ...chat,
            members,
            lastMessage: lastMessage || null,
            unread
        };
    });

    // Sort by last message time descending
    result.sort((a, b) => {
        const aTime = a.lastMessage ? a.lastMessage.timestamp : a.createdAt;
        const bTime = b.lastMessage ? b.lastMessage.timestamp : b.createdAt;
        return bTime - aTime;
    });

    res.json(result);
});

app.post('/api/chats', authenticate, (req, res) => {
    const { otherUserId } = req.body;

    if (!otherUserId) {
        return res.status(400).json({ error: 'Укажите пользователя' });
    }

    // Check if other user exists
    const otherUser = queryGet('SELECT id FROM users WHERE id = ?', [otherUserId]);
    if (!otherUser) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Check if chat already exists between these two users
    const existingChat = queryGet(`
        SELECT c.id FROM chats c
        JOIN chat_members cm1 ON cm1.chatId = c.id AND cm1.userId = ?
        JOIN chat_members cm2 ON cm2.chatId = c.id AND cm2.userId = ?
        WHERE c.type = 'private'
    `, [req.user.id, otherUserId]);

    if (existingChat) {
        const chat = queryGet('SELECT * FROM chats WHERE id = ?', [existingChat.id]);
        const members = queryAll(
            'SELECT u.id, u.username, u.displayName, u.bio, u.color FROM chat_members cm JOIN users u ON u.id = cm.userId WHERE cm.chatId = ?',
            [chat.id]
        );
        return res.json({ ...chat, members });
    }

    // Create new chat
    const chatId = uuidv4();
    const now = Date.now();

    runSql('INSERT INTO chats (id, type, createdAt) VALUES (?, ?, ?)', [chatId, 'private', now]);
    runSql('INSERT INTO chat_members (chatId, userId, joinedAt) VALUES (?, ?, ?)', [chatId, req.user.id, now]);
    runSql('INSERT INTO chat_members (chatId, userId, joinedAt) VALUES (?, ?, ?)', [chatId, otherUserId, now]);

    const chat = queryGet('SELECT * FROM chats WHERE id = ?', [chatId]);
    const members = queryAll(
        'SELECT u.id, u.username, u.displayName, u.bio, u.color FROM chat_members cm JOIN users u ON u.id = cm.userId WHERE cm.chatId = ?',
        [chatId]
    );

    res.json({ ...chat, members });
});

app.get('/api/chats/:chatId/messages', authenticate, (req, res) => {
    const { chatId } = req.params;

    // Verify user is a member of this chat
    const member = queryGet('SELECT * FROM chat_members WHERE chatId = ? AND userId = ?', [chatId, req.user.id]);
    if (!member) {
        return res.status(403).json({ error: 'Нет доступа к этому чату' });
    }

    const messages = queryAll('SELECT * FROM messages WHERE chatId = ? ORDER BY timestamp ASC', [chatId]);

    // Mark messages as read
    runSql('UPDATE messages SET read = 1 WHERE chatId = ? AND senderId != ? AND read = 0', [chatId, req.user.id]);

    res.json(messages);
});

// ==================== FILE UPLOAD ====================
app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не прикреплён' });
    }

    const { chatId, msgType } = req.body;
    if (!chatId || !msgType) {
        return res.status(400).json({ error: 'Не указан чат или тип сообщения' });
    }

    // Verify membership
    const member = queryGet('SELECT * FROM chat_members WHERE chatId = ? AND userId = ?', [chatId, req.user.id]);
    if (!member) {
        return res.status(403).json({ error: 'Нет доступа к этому чату' });
    }

    const validTypes = ['image', 'file', 'voice', 'video_circle'];
    if (!validTypes.includes(msgType)) {
        return res.status(400).json({ error: 'Неверный тип сообщения' });
    }

    const msgId = uuidv4();
    const timestamp = Date.now();
    const fileUrl = '/uploads/' + req.file.filename;
    const fileName = req.file.originalname;
    const fileSize = req.file.size;
    const duration = parseFloat(req.body.duration) || 0;

    runSql(
        'INSERT INTO messages (id, chatId, senderId, text, timestamp, read, msgType, fileUrl, fileName, fileSize, duration) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
        [msgId, chatId, req.user.id, '', timestamp, msgType, fileUrl, fileName, fileSize, duration]
    );

    const message = {
        id: msgId,
        chatId,
        senderId: req.user.id,
        text: '',
        timestamp,
        read: 0,
        msgType,
        fileUrl,
        fileName,
        fileSize,
        duration
    };

    // Broadcast to chat members via WebSocket
    const members = queryAll('SELECT userId FROM chat_members WHERE chatId = ?', [chatId]);
    for (const m of members) {
        sendToUser(m.userId, { type: 'new_message', message });
    }

    res.json({ message });
});

// ==================== SERVE INDEX.HTML ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

// Fallback for SPA
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(ROOT_DIR, 'index.html'));
    }
});

// ==================== WEBSOCKET ====================
// Track connected clients: Map<ws, { userId, token }>
const clients = new Map();
// Track online users: Map<userId, Set<ws>>
const onlineUsers = new Map();

function broadcastOnlineStatus() {
    const onlineIds = Array.from(onlineUsers.keys());
    const msg = JSON.stringify({ type: 'online', users: onlineIds });
    for (const [ws] of clients) {
        if (ws.readyState === 1) {
            ws.send(msg);
        }
    }
}

function sendToUser(userId, data) {
    const sockets = onlineUsers.get(userId);
    if (sockets) {
        const msg = JSON.stringify(data);
        for (const ws of sockets) {
            if (ws.readyState === 1) {
                ws.send(msg);
            }
        }
    }
}

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }

        // ---- AUTH ----
        if (data.type === 'auth') {
            const tokenRow = queryGet('SELECT userId FROM tokens WHERE token = ?', [data.token]);
            if (!tokenRow) {
                ws.send(JSON.stringify({ type: 'error', message: 'Недействительный токен' }));
                return;
            }

            const user = queryGet('SELECT id, username, displayName, bio, color FROM users WHERE id = ?', [tokenRow.userId]);
            if (!user) return;

            clients.set(ws, { userId: user.id, token: data.token });

            if (!onlineUsers.has(user.id)) {
                onlineUsers.set(user.id, new Set());
            }
            onlineUsers.get(user.id).add(ws);

            ws.send(JSON.stringify({ type: 'auth_ok', user }));
            broadcastOnlineStatus();
            return;
        }

        // All other messages require auth
        const clientInfo = clients.get(ws);
        if (!clientInfo) {
            ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
            return;
        }

        // ---- NEW MESSAGE ----
        if (data.type === 'message') {
            const { chatId, text } = data;
            if (!chatId || !text || !text.trim()) return;

            // Verify membership
            const member = queryGet('SELECT * FROM chat_members WHERE chatId = ? AND userId = ?', [chatId, clientInfo.userId]);
            if (!member) return;

            const msgId = uuidv4();
            const timestamp = Date.now();

            runSql(
                'INSERT INTO messages (id, chatId, senderId, text, timestamp, read) VALUES (?, ?, ?, ?, ?, 0)',
                [msgId, chatId, clientInfo.userId, text.trim(), timestamp]
            );

            const message = {
                id: msgId,
                chatId,
                senderId: clientInfo.userId,
                text: text.trim(),
                timestamp,
                read: 0
            };

            // Send to all chat members
            const members = queryAll('SELECT userId FROM chat_members WHERE chatId = ?', [chatId]);
            for (const m of members) {
                sendToUser(m.userId, { type: 'new_message', message });
            }
            return;
        }

        // ---- TYPING ----
        if (data.type === 'typing') {
            const { chatId } = data;
            if (!chatId) return;

            const members = queryAll('SELECT userId FROM chat_members WHERE chatId = ?', [chatId]);
            for (const m of members) {
                if (m.userId !== clientInfo.userId) {
                    sendToUser(m.userId, {
                        type: 'typing',
                        chatId,
                        userId: clientInfo.userId
                    });
                }
            }
            return;
        }

        // ---- MARK READ ----
        if (data.type === 'mark_read') {
            const { chatId } = data;
            if (!chatId) return;

            runSql('UPDATE messages SET read = 1 WHERE chatId = ? AND senderId != ? AND read = 0', [chatId, clientInfo.userId]);

            // Notify the other user that messages were read
            const members = queryAll('SELECT userId FROM chat_members WHERE chatId = ?', [chatId]);
            for (const m of members) {
                if (m.userId !== clientInfo.userId) {
                    sendToUser(m.userId, { type: 'messages_read', chatId, byUserId: clientInfo.userId });
                }
            }
            return;
        }
    });

    ws.on('close', () => {
        const clientInfo = clients.get(ws);
        if (clientInfo) {
            const sockets = onlineUsers.get(clientInfo.userId);
            if (sockets) {
                sockets.delete(ws);
                if (sockets.size === 0) {
                    onlineUsers.delete(clientInfo.userId);
                }
            }
            clients.delete(ws);
            broadcastOnlineStatus();
        }
    });

    ws.on('error', () => {
        ws.close();
    });
});

// ==================== START ====================
async function start() {
    await initDatabase();
    const proto = useHttps ? 'https' : 'http';
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`VMeste server running on ${proto}://0.0.0.0:${PORT}`);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
