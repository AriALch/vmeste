// VMeste (VM) — Messenger App
(function() {
    'use strict';

    // ==================== API & WEBSOCKET LAYER ====================
    const API_BASE = '/api';
    let authToken = localStorage.getItem('vm_token');

    async function api(method, path, body) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (authToken) {
            opts.headers['Authorization'] = authToken;
        }
        if (body) {
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(API_BASE + path, opts);
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || 'Ошибка сервера');
        }
        return data;
    }

    async function uploadFile(file, chatId, msgType, duration) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('chatId', chatId);
        formData.append('msgType', msgType);
        if (duration) formData.append('duration', duration);

        const res = await fetch(API_BASE + '/upload', {
            method: 'POST',
            headers: { 'Authorization': authToken },
            body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
        return data;
    }

    // ==================== WEBSOCKET ====================
    let ws = null;
    let wsReconnectTimer = null;
    let onlineUserIds = [];

    function connectWebSocket() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = protocol + '//' + window.location.host;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            if (authToken) {
                ws.send(JSON.stringify({ type: 'auth', token: authToken }));
            }
        };

        ws.onmessage = (event) => {
            let data;
            try { data = JSON.parse(event.data); } catch { return; }
            handleWsMessage(data);
        };

        ws.onclose = () => { scheduleReconnect(); };
        ws.onerror = () => {};
    }

    function scheduleReconnect() {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        if (authToken) {
            wsReconnectTimer = setTimeout(connectWebSocket, 2000);
        }
    }

    function disconnectWebSocket() {
        if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
        if (ws) { ws.onclose = null; ws.close(); ws = null; }
    }

    function wsSend(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    function handleWsMessage(data) {
        switch (data.type) {
            case 'auth_ok': break;
            case 'online':
                onlineUserIds = data.users || [];
                updateOnlineIndicators();
                break;
            case 'new_message':
                handleIncomingMessage(data.message);
                break;
            case 'typing':
                handleTypingIndicator(data.chatId, data.userId);
                break;
            case 'messages_read':
                handleMessagesRead(data.chatId);
                break;
            case 'error':
                showToast(data.message);
                break;
        }
    }

    function handleIncomingMessage(message) {
        if (currentChatId === message.chatId) {
            appendMessage(message);
            scrollToBottom();
            wsSend({ type: 'mark_read', chatId: message.chatId });
        }
        loadChatList();
    }

    function handleTypingIndicator(chatId, userId) {
        if (currentChatId !== chatId) return;
        const statusEl = document.getElementById('header-status');
        statusEl.textContent = 'печатает...';
        clearTimeout(statusEl._typingTimeout);
        statusEl._typingTimeout = setTimeout(updateHeaderStatus, 2000);
    }

    function handleMessagesRead(chatId) {
        if (currentChatId === chatId) {
            document.querySelectorAll('.message.outgoing .message-check').forEach(el => {
                el.textContent = '\u2713\u2713';
            });
        }
        loadChatList();
    }

    function updateOnlineIndicators() { updateHeaderStatus(); }

    function updateHeaderStatus() {
        if (!currentChatId || !currentChatData) return;
        const other = getOtherUserFromChat(currentChatData);
        if (!other) return;
        const statusEl = document.getElementById('header-status');
        const isOnline = onlineUserIds.includes(other.id);
        statusEl.textContent = isOnline ? 'в сети' : 'не в сети';
    }

    // ==================== STATE ====================
    let currentUser = null;
    let currentChatId = null;
    let currentChatData = null;
    let chatListData = [];
    let isMobile = window.innerWidth <= 768;
    let typingTimeout = null;

    // Media recording state
    let mediaRecorder = null;
    let mediaChunks = [];
    let recordingStartTime = 0;
    let recordingTimer = null;
    let videoStream = null;

    // ==================== AUTH ====================
    async function checkSession() {
        if (!authToken) { showAuth(); return; }
        try {
            await api('GET', '/users');
            const stored = localStorage.getItem('vm_user');
            if (stored) { currentUser = JSON.parse(stored); showApp(); }
            else { authToken = null; localStorage.removeItem('vm_token'); showAuth(); }
        } catch {
            authToken = null;
            localStorage.removeItem('vm_token');
            localStorage.removeItem('vm_user');
            showAuth();
        }
    }

    async function login(username, password) {
        if (!username.trim() || !password) return showToast('Заполните все поля');
        try {
            const data = await api('POST', '/login', { username, password });
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('vm_token', data.token);
            localStorage.setItem('vm_user', JSON.stringify(data.user));
            showApp();
        } catch (err) { showToast(err.message); }
    }

    async function register(displayName, username, password) {
        if (!displayName.trim() || !username.trim() || !password) return showToast('Заполните все поля');
        try {
            const data = await api('POST', '/register', { username, password, displayName });
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('vm_token', data.token);
            localStorage.setItem('vm_user', JSON.stringify(data.user));
            showApp();
        } catch (err) { showToast(err.message); }
    }

    function logout() {
        currentUser = null; currentChatId = null; currentChatData = null; chatListData = [];
        authToken = null;
        localStorage.removeItem('vm_token');
        localStorage.removeItem('vm_user');
        disconnectWebSocket();
        showAuth();
    }

    // ==================== SCREENS ====================
    function showAuth() {
        document.getElementById('auth-screen').classList.add('active');
        document.getElementById('app-screen').classList.remove('active');
    }

    function showApp() {
        document.getElementById('auth-screen').classList.remove('active');
        document.getElementById('app-screen').classList.add('active');
        updateMenuProfile();
        loadChatList();
        showEmptyState();
        connectWebSocket();
    }

    function showEmptyState() {
        document.getElementById('empty-state').classList.remove('hidden');
        document.getElementById('chat-header').classList.add('hidden');
        document.getElementById('messages-container').classList.add('hidden');
        document.getElementById('input-area').classList.add('hidden');
        currentChatId = null; currentChatData = null;
        if (isMobile) document.getElementById('sidebar').classList.remove('chat-open');
        updateActiveChatItem();
    }

    // ==================== CHAT LIST ====================
    async function loadChatList(filter) {
        try {
            chatListData = await api('GET', '/chats');
            renderChatList(filter || document.getElementById('search-input').value);
        } catch (err) {}
    }

    function getMessagePreview(msg) {
        if (!msg) return 'Нет сообщений';
        const prefix = msg.senderId === currentUser.id ? '<span style="color:var(--accent)">Вы: </span>' : '';
        const type = msg.msgType || 'text';
        switch (type) {
            case 'image': return prefix + 'Фото';
            case 'file': return prefix + 'Файл';
            case 'voice': return prefix + 'Голосовое сообщение';
            case 'video_circle': return prefix + 'Видеосообщение';
            default: return prefix + escapeHtml(msg.text);
        }
    }

    function renderChatList(filter = '') {
        const chatList = document.getElementById('chat-list');
        const filteredChats = chatListData.filter(chat => {
            if (!filter) return true;
            const other = getOtherUserFromChat(chat);
            return other && (
                other.displayName.toLowerCase().includes(filter.toLowerCase()) ||
                other.username.toLowerCase().includes(filter.toLowerCase())
            );
        });

        chatList.innerHTML = '';
        if (filteredChats.length === 0) {
            chatList.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: var(--text-secondary); font-size: 14px;">
                ${filter ? 'Ничего не найдено' : 'Нет чатов. Нажмите + чтобы начать'}
            </div>`;
            return;
        }

        filteredChats.forEach(chat => {
            const other = getOtherUserFromChat(chat);
            if (!other) return;
            const lastMsg = chat.lastMessage;
            const unread = chat.unread || 0;

            const el = document.createElement('div');
            el.className = 'chat-item' + (currentChatId === chat.id ? ' active' : '');
            el.dataset.chatId = chat.id;
            const avatarContent = other.avatarUrl
                ? `<img src="${other.avatarUrl}" alt="">`
                : getInitials(other.displayName);
            el.innerHTML = `
                <div class="chat-item-avatar" style="background:${other.color}">${avatarContent}</div>
                <div class="chat-item-info">
                    <div class="chat-item-top">
                        <span class="chat-item-name">${escapeHtml(other.displayName)}</span>
                        <span class="chat-item-time">${lastMsg ? formatTime(lastMsg.timestamp) : ''}</span>
                    </div>
                    <div class="chat-item-bottom">
                        <span class="chat-item-preview">${getMessagePreview(lastMsg)}</span>
                        ${unread > 0 ? `<span class="chat-item-badge">${unread}</span>` : ''}
                    </div>
                </div>
            `;
            el.addEventListener('click', () => openChat(chat.id));
            chatList.appendChild(el);
        });
    }

    function getOtherUserFromChat(chat) {
        if (!chat.members) return null;
        return chat.members.find(m => m.id !== currentUser.id);
    }

    function updateActiveChatItem() {
        document.querySelectorAll('.chat-item').forEach(el => {
            el.classList.toggle('active', el.dataset.chatId === currentChatId);
        });
    }

    // ==================== CHAT ====================
    async function openChat(chatId) {
        currentChatId = chatId;
        currentChatData = chatListData.find(c => c.id === chatId);
        if (!currentChatData) return;
        const other = getOtherUserFromChat(currentChatData);
        if (!other) return;

        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('chat-header').classList.remove('hidden');
        document.getElementById('messages-container').classList.remove('hidden');
        document.getElementById('input-area').classList.remove('hidden');

        const headerAvatar = document.getElementById('header-avatar');
        headerAvatar.style.background = other.color;
        headerAvatar.innerHTML = other.avatarUrl
            ? `<img src="${other.avatarUrl}" alt="">`
            : getInitials(other.displayName);
        document.getElementById('header-name').textContent = other.displayName;
        updateHeaderStatus();
        updateInputButtons();

        if (isMobile) document.getElementById('sidebar').classList.add('chat-open');
        updateActiveChatItem();

        // Make input interactive immediately
        const msgInput = document.getElementById('message-input');
        msgInput.value = '';
        msgInput.disabled = false;
        if (!isMobile) msgInput.focus();

        try {
            const messages = await api('GET', `/chats/${chatId}/messages`);
            renderMessages(messages);
            wsSend({ type: 'mark_read', chatId });
            loadChatList();
        } catch (err) { showToast('Ошибка загрузки сообщений'); }
    }

    function renderMessages(messages) {
        const container = document.getElementById('messages');
        container.innerHTML = '';
        let lastDate = '';
        messages.forEach(msg => {
            const msgDate = new Date(msg.timestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
            if (msgDate !== lastDate) {
                lastDate = msgDate;
                const sep = document.createElement('div');
                sep.className = 'date-separator';
                sep.innerHTML = `<span>${msgDate}</span>`;
                container.appendChild(sep);
            }
            appendMessageElement(container, msg);
        });
        scrollToBottom();
    }

    function buildMessageContent(msg) {
        const type = msg.msgType || 'text';

        if (type === 'image') {
            return `<img class="message-image" src="${msg.fileUrl}" alt="Фото" loading="lazy" onclick="document.dispatchEvent(new CustomEvent('lightbox',{detail:'${msg.fileUrl}'}))">`;
        }

        if (type === 'file') {
            const size = formatFileSize(msg.fileSize || 0);
            return `<div class="file-message">
                <div class="file-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="white" stroke-width="2"/><path d="M14 2v6h6" stroke="white" stroke-width="2"/></svg></div>
                <div class="file-info">
                    <a class="file-name" href="${msg.fileUrl}" download="${escapeHtml(msg.fileName || 'file')}">${escapeHtml(msg.fileName || 'Файл')}</a>
                    <div class="file-size">${size}</div>
                </div>
            </div>`;
        }

        if (type === 'voice') {
            const dur = msg.duration || 0;
            const bars = generateWaveformBars();
            return `<div class="voice-message" data-src="${msg.fileUrl}" data-duration="${dur}">
                <button class="voice-play-btn" onclick="document.dispatchEvent(new CustomEvent('playvoice',{detail:this.parentElement}))">&#9654;</button>
                <div class="voice-waveform">${bars}</div>
                <span class="voice-duration">${formatDuration(dur)}</span>
            </div>`;
        }

        if (type === 'video_circle') {
            const dur = msg.duration || 0;
            return `<div class="video-circle-msg" onclick="document.dispatchEvent(new CustomEvent('playvideo',{detail:this}))">
                <video src="${msg.fileUrl}" preload="metadata" playsinline loop></video>
                <div class="play-overlay"><svg viewBox="0 0 24 24" fill="none"><polygon points="8,5 19,12 8,19" fill="white"/></svg></div>
                <span class="video-circle-msg-duration">${formatDuration(dur)}</span>
            </div>`;
        }

        // text
        return `<div class="message-text">${formatMessageText(msg.text)}</div>`;
    }

    function appendMessageElement(container, msg) {
        const el = document.createElement('div');
        const isOut = msg.senderId === currentUser.id;
        const type = msg.msgType || 'text';
        el.className = `message ${isOut ? 'outgoing' : 'incoming'}`;
        el.dataset.msgId = msg.id;

        const content = buildMessageContent(msg);
        const needsTextPadding = type === 'text';

        el.innerHTML = `
            <div class="message-bubble${type !== 'text' ? ' media-bubble' : ''}">
                ${content}
                <div class="message-meta">
                    <span class="message-time">${formatTimeShort(msg.timestamp)}</span>
                    ${isOut ? `<span class="message-check">${msg.read ? '\u2713\u2713' : '\u2713'}</span>` : ''}
                </div>
            </div>
        `;
        container.appendChild(el);
    }

    function appendMessage(msg) {
        const container = document.getElementById('messages');
        if (!container) return;
        const msgDate = new Date(msg.timestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        // Find the last date separator correctly
        const allSeps = container.querySelectorAll('.date-separator');
        const lastDateSep = allSeps.length > 0 ? allSeps[allSeps.length - 1] : null;
        const lastDate = lastDateSep ? lastDateSep.textContent.trim() : '';
        if (msgDate !== lastDate) {
            const sep = document.createElement('div');
            sep.className = 'date-separator';
            sep.innerHTML = `<span>${msgDate}</span>`;
            container.appendChild(sep);
        }
        appendMessageElement(container, msg);
    }

    function sendMessage() {
        const input = document.getElementById('message-input');
        const text = input.value.trim();
        if (!text || !currentChatId) return;
        wsSend({ type: 'message', chatId: currentChatId, text });
        input.value = '';
        input.style.height = 'auto';
        updateInputButtons();
    }

    // ==================== FILE ATTACHMENTS ====================
    function toggleAttachMenu() {
        const menu = document.getElementById('attach-menu');
        menu.classList.toggle('hidden');
    }

    function handleFileSelect(inputId, msgType) {
        const input = document.getElementById(inputId);
        input.value = '';
        input.onclick = null;
        input.click();
        input.onchange = async () => {
            const file = input.files[0];
            if (!file || !currentChatId) return;
            // Determine type: if photo input and it's an image
            let type = msgType;
            if (msgType === 'auto') {
                type = file.type.startsWith('image/') ? 'image' : 'file';
            }
            try {
                showToast('Загрузка...');
                await uploadFile(file, currentChatId, type);
            } catch (err) {
                showToast(err.message);
            }
        };
    }

    // ==================== VOICE RECORDING ====================
    async function startVoiceRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
                             MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
            mediaRecorder = new MediaRecorder(stream, { mimeType });
            mediaChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) mediaChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
            };

            mediaRecorder.start();
            recordingStartTime = Date.now();

            // Show recording UI
            document.getElementById('input-normal').classList.add('hidden');
            document.getElementById('input-recording').classList.remove('hidden');

            recordingTimer = setInterval(() => {
                const elapsed = (Date.now() - recordingStartTime) / 1000;
                document.getElementById('recording-time').textContent = formatDuration(elapsed);
            }, 100);

        } catch (err) {
            showToast('Нет доступа к микрофону');
        }
    }

    function cancelVoiceRecording() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        mediaRecorder = null;
        mediaChunks = [];
        clearInterval(recordingTimer);
        document.getElementById('input-recording').classList.add('hidden');
        document.getElementById('input-normal').classList.remove('hidden');
    }

    async function sendVoiceRecording() {
        if (!mediaRecorder || !currentChatId) return;
        const duration = (Date.now() - recordingStartTime) / 1000;

        mediaRecorder.onstop = async () => {
            mediaRecorder.stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(mediaChunks, { type: mediaRecorder.mimeType });
            const ext = mediaRecorder.mimeType.includes('webm') ? '.webm' : '.ogg';
            const file = new File([blob], 'voice' + ext, { type: mediaRecorder.mimeType });

            try {
                await uploadFile(file, currentChatId, 'voice', duration.toFixed(1));
            } catch (err) {
                showToast(err.message);
            }

            mediaRecorder = null;
            mediaChunks = [];
        };

        mediaRecorder.stop();
        clearInterval(recordingTimer);
        document.getElementById('input-recording').classList.add('hidden');
        document.getElementById('input-normal').classList.remove('hidden');
    }

    // ==================== VIDEO CIRCLE RECORDING ====================
    async function openVideoCircleModal() {
        const modal = document.getElementById('video-circle-modal');
        const video = document.getElementById('video-circle-feed');
        const toggleBtn = document.getElementById('btn-toggle-video-circle');
        const sendBtn = document.getElementById('btn-send-video-circle');
        const timerEl = document.getElementById('video-circle-timer');
        const progressEl = document.getElementById('video-circle-progress');

        toggleBtn.classList.remove('recording');
        sendBtn.classList.add('hidden');
        timerEl.textContent = '0:00';
        progressEl.style.strokeDashoffset = '666';

        try {
            videoStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 400, height: 400, facingMode: 'user' },
                audio: true
            });
            video.srcObject = videoStream;
            modal.classList.remove('hidden');
        } catch (err) {
            showToast('Нет доступа к камере');
        }
    }

    function closeVideoCircleModal() {
        const modal = document.getElementById('video-circle-modal');
        const video = document.getElementById('video-circle-feed');
        modal.classList.add('hidden');

        if (videoStream) {
            videoStream.getTracks().forEach(t => t.stop());
            videoStream = null;
        }
        video.srcObject = null;

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        mediaRecorder = null;
        mediaChunks = [];
        clearInterval(recordingTimer);
    }

    function toggleVideoCircleRecording() {
        const toggleBtn = document.getElementById('btn-toggle-video-circle');
        const sendBtn = document.getElementById('btn-send-video-circle');

        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
            // Start recording
            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' :
                             MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
            mediaRecorder = new MediaRecorder(videoStream, { mimeType });
            mediaChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) mediaChunks.push(e.data);
            };

            mediaRecorder.start();
            recordingStartTime = Date.now();
            toggleBtn.classList.add('recording');

            const maxDuration = 60;
            const circumference = 666;
            const progressEl = document.getElementById('video-circle-progress');
            const timerEl = document.getElementById('video-circle-timer');

            recordingTimer = setInterval(() => {
                const elapsed = (Date.now() - recordingStartTime) / 1000;
                timerEl.textContent = formatDuration(elapsed);
                const progress = Math.min(elapsed / maxDuration, 1);
                progressEl.style.strokeDashoffset = circumference * (1 - progress);

                if (elapsed >= maxDuration) {
                    stopVideoCircleRecording();
                }
            }, 100);

        } else {
            stopVideoCircleRecording();
        }
    }

    function stopVideoCircleRecording() {
        const toggleBtn = document.getElementById('btn-toggle-video-circle');
        const sendBtn = document.getElementById('btn-send-video-circle');

        clearInterval(recordingTimer);
        toggleBtn.classList.remove('recording');
        sendBtn.classList.remove('hidden');

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
    }

    async function sendVideoCircle() {
        if (!mediaChunks.length || !currentChatId) { closeVideoCircleModal(); return; }

        const duration = (Date.now() - recordingStartTime) / 1000;
        const blob = new Blob(mediaChunks, { type: mediaRecorder ? mediaRecorder.mimeType : 'video/webm' });
        const file = new File([blob], 'video_circle.webm', { type: 'video/webm' });

        closeVideoCircleModal();

        try {
            showToast('Загрузка кружка...');
            await uploadFile(file, currentChatId, 'video_circle', duration.toFixed(1));
        } catch (err) {
            showToast(err.message);
        }
    }

    // ==================== MEDIA PLAYBACK ====================
    let currentAudio = null;
    let currentAudioEl = null;

    function playVoice(voiceEl) {
        const src = voiceEl.dataset.src;
        const btn = voiceEl.querySelector('.voice-play-btn');
        const bars = voiceEl.querySelectorAll('.voice-bar');
        const durEl = voiceEl.querySelector('.voice-duration');

        if (currentAudio && currentAudioEl === voiceEl) {
            if (currentAudio.paused) {
                currentAudio.play();
                btn.innerHTML = '&#9646;&#9646;';
            } else {
                currentAudio.pause();
                btn.innerHTML = '&#9654;';
            }
            return;
        }

        if (currentAudio) {
            currentAudio.pause();
            if (currentAudioEl) {
                currentAudioEl.querySelector('.voice-play-btn').innerHTML = '&#9654;';
                currentAudioEl.querySelectorAll('.voice-bar').forEach(b => b.classList.remove('played'));
            }
        }

        currentAudio = new Audio(src);
        currentAudioEl = voiceEl;
        btn.innerHTML = '&#9646;&#9646;';

        currentAudio.ontimeupdate = () => {
            const progress = currentAudio.currentTime / currentAudio.duration;
            const playedCount = Math.floor(progress * bars.length);
            bars.forEach((b, i) => b.classList.toggle('played', i < playedCount));
            durEl.textContent = formatDuration(currentAudio.currentTime);
        };

        currentAudio.onended = () => {
            btn.innerHTML = '&#9654;';
            bars.forEach(b => b.classList.remove('played'));
            durEl.textContent = formatDuration(parseFloat(voiceEl.dataset.duration) || 0);
            currentAudio = null;
            currentAudioEl = null;
        };

        currentAudio.play();
    }

    function playVideoCircle(el) {
        const video = el.querySelector('video');
        if (video.paused) {
            video.play();
            el.classList.add('playing');
        } else {
            video.pause();
            el.classList.remove('playing');
        }
    }

    function openLightbox(src) {
        const lb = document.createElement('div');
        lb.className = 'lightbox';
        lb.innerHTML = `<img src="${src}">`;
        lb.addEventListener('click', () => lb.remove());
        document.body.appendChild(lb);
    }

    // ==================== NEW CHAT ====================
    async function showNewChatModal() {
        const modal = document.getElementById('new-chat-modal');
        const userList = document.getElementById('user-list');
        const searchInput = document.getElementById('new-chat-search');

        let allUsers = [];
        try { allUsers = await api('GET', '/users'); }
        catch (err) { showToast('Ошибка загрузки пользователей'); return; }

        const renderUsers = (filter = '') => {
            const filtered = allUsers.filter(u =>
                !filter || u.displayName.toLowerCase().includes(filter.toLowerCase()) ||
                u.username.toLowerCase().includes(filter.toLowerCase())
            );
            userList.innerHTML = '';
            if (filtered.length === 0) {
                userList.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;font-size:14px;">Пользователи не найдены</div>';
                return;
            }
            filtered.forEach(user => {
                const el = document.createElement('div');
                el.className = 'user-item';
                const uAvatarContent = user.avatarUrl
                    ? `<img src="${user.avatarUrl}" alt="">`
                    : getInitials(user.displayName);
                el.innerHTML = `
                    <div class="user-item-avatar" style="background:${user.color}">${uAvatarContent}</div>
                    <div class="user-item-info">
                        <div class="user-item-name">${escapeHtml(user.displayName)}</div>
                        <div class="user-item-username">@${escapeHtml(user.username)}</div>
                    </div>
                `;
                el.addEventListener('click', () => startChat(user.id));
                userList.appendChild(el);
            });
        };

        searchInput.value = '';
        renderUsers();
        const newSearch = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearch, searchInput);
        newSearch.addEventListener('input', () => renderUsers(newSearch.value));
        modal.classList.remove('hidden');
        setTimeout(() => newSearch.focus(), 100);
    }

    async function startChat(otherUserId) {
        try {
            const chat = await api('POST', '/chats', { otherUserId });
            document.getElementById('new-chat-modal').classList.add('hidden');
            await loadChatList();
            openChat(chat.id);
        } catch (err) { showToast(err.message); }
    }

    // ==================== SETTINGS ====================
    function showSettings() {
        closeSlideMenu();
        const modal = document.getElementById('settings-modal');
        updateSettingsAvatar();
        document.getElementById('settings-name').value = currentUser.displayName;
        document.getElementById('settings-bio').value = currentUser.bio || '';
        modal.classList.remove('hidden');
    }

    async function saveSettings() {
        const name = document.getElementById('settings-name').value.trim();
        if (!name) return showToast('Введите имя');
        try {
            const data = await api('PUT', '/profile', {
                displayName: name,
                bio: document.getElementById('settings-bio').value.trim()
            });
            currentUser = data.user;
            localStorage.setItem('vm_user', JSON.stringify(currentUser));
            updateMenuProfile();
            loadChatList();
            document.getElementById('settings-modal').classList.add('hidden');
            showToast('Настройки сохранены');
        } catch (err) {
            showToast(err.message);
        }
    }

    async function uploadAvatar(file) {
        if (!file) return;
        const formData = new FormData();
        formData.append('avatar', file);
        try {
            showToast('Загрузка фото...');
            const res = await fetch(API_BASE + '/profile/avatar', {
                method: 'POST',
                headers: { 'Authorization': authToken },
                body: formData
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
            currentUser = data.user;
            localStorage.setItem('vm_user', JSON.stringify(currentUser));
            updateMenuProfile();
            updateSettingsAvatar();
            loadChatList();
            showToast('Фото обновлено');
        } catch (err) {
            showToast(err.message);
        }
    }

    function updateSettingsAvatar() {
        const el = document.getElementById('settings-avatar');
        el.style.background = currentUser.color;
        if (currentUser.avatarUrl) {
            el.innerHTML = `<img src="${currentUser.avatarUrl}" alt="">`;
        } else {
            el.textContent = getInitials(currentUser.displayName);
        }
    }

    // ==================== SLIDE MENU ====================
    function openSlideMenu() {
        const menu = document.getElementById('slide-menu');
        const overlay = document.getElementById('slide-menu-overlay');
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('show'), 10);
        menu.classList.add('open');
    }

    function closeSlideMenu() {
        const menu = document.getElementById('slide-menu');
        const overlay = document.getElementById('slide-menu-overlay');
        overlay.classList.remove('show');
        menu.classList.remove('open');
        setTimeout(() => overlay.classList.add('hidden'), 300);
    }

    function updateMenuProfile() {
        if (!currentUser) return;
        const menuAvatar = document.getElementById('menu-avatar');
        menuAvatar.style.background = currentUser.color;
        menuAvatar.innerHTML = currentUser.avatarUrl
            ? `<img src="${currentUser.avatarUrl}" alt="">`
            : getInitials(currentUser.displayName);
        document.getElementById('menu-name').textContent = currentUser.displayName;
        document.getElementById('menu-username').textContent = '@' + currentUser.username;
    }

    // ==================== DARK MODE ====================
    function toggleDarkMode() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        document.documentElement.setAttribute('data-theme', isDark ? '' : 'dark');
        localStorage.setItem('vm_theme', isDark ? 'light' : 'dark');
        closeSlideMenu();
    }

    function loadTheme() {
        const theme = localStorage.getItem('vm_theme');
        if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    }

    // ==================== EMOJI PICKER ====================
    const emojiCategories = {
        frequent: { label: 'Часто используемые', emojis: [] },
        smileys: { label: 'Смайлы и эмоции', emojis: [
            '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙',
            '🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒',
            '🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','🥱','😤','😡','🤬',
            '😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾',
            '🫠','🫢','🫣','🫤','🥹','🫶','🫰','🫵','🫱','🫲','🫳','🫴','🫷','🫸'
        ]},
        people: { label: 'Люди и жесты', emojis: [
            '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉',
            '👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏',
            '💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄',
            '👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇',
            '🤦','🤷','👮','🕵️','💂','🥷','👷','🫅','🤴','👸','👳','👲','🧕','🤵','👰','🤰','🫄','🤱','👼','🎅',
            '🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','🧌','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','👯'
        ]},
        animals: { label: 'Животные и природа', emojis: [
            '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊',
            '🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌',
            '🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡',
            '🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬',
            '🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐈‍⬛','🪶','🐓','🦃','🦤','🦚',
            '🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔',
            '🌵','🎄','🌲','🌳','🌴','🪵','🌱','🌿','☘️','🍀','🎍','🪴','🎋','🍃','🍂','🍁','🪺','🪹',
            '🍄','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝','🌛','🌜','🌚','🌕','🌖','🌗','🌘','🌑',
            '🌒','🌓','🌔','🌙','🌎','🌍','🌏','🪐','💫','⭐','🌟','✨','⚡','☄️','💥','🔥','🌪️','🌈','☀️','🌤️',
            '⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','💧','💦','🫧','☔','☂️','🌊'
        ]},
        food: { label: 'Еда и напитки', emojis: [
            '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑',
            '🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🫘','🥐','🥯','🍞','🥖','🥨','🧀','🥚',
            '🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔',
            '🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢',
            '🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯',
            '🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾','🧊','🥄','🍴','🍽️','🥢'
        ]},
        travel: { label: 'Путешествия и места', emojis: [
            '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','🚲','🛴','🛹',
            '🛼','🚁','🛸','✈️','🛩️','🚀','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','🚂','🚃','🚄','🚅','🚆','🚇','🚈',
            '🚉','🚊','🚝','🚞','🚋','🚍','🚏','🏗️','🌁','🗼','🏭','⛲','🎠','🎡','🎢','💈','🎪','🗽','🗿','🏰',
            '🏯','🏟️','🎑','🏖️','🏝️','🏜️','🌋','⛰️','🏔️','🗻','🏕️','⛺','🛖','🏠','🏡','🏘️','🏚️','🏗️','🏢','🏬',
            '🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏩','💒','🏛️','⛪','🕌','🕍','🛕','🕋','⛩️','🗾','🎏','🎐','🏮'
        ]},
        objects: { label: 'Предметы', emojis: [
            '⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️',
            '🎬','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','📡','🔋','🔌','💡','🔦','🕯️','🧯','🛢️',
            '💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🪜','🧰','🪛','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩',
            '⚙️','🪤','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','🪬',
            '💈','⚗️','🔭','🔬','🕳️','🩹','🩺','🩻','🩼','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧺',
            '🧻','🚽','🪣','🧼','🫧','🪥','🧽','🧴','🛎️','🔑','🗝️','🚪','🪑','🛋️','🛏️','🛌','🧸','🪆','🖼️','🪞',
            '📦','📫','📬','📭','📮','🏷️','📪','✉️','📧','📨','📩','📤','📥','📜','📃','📄','📑','🧾','📊','📈','📉',
            '📎','🖇️','📏','📐','✂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐','📌','📍','✏️','🖊️','🖋️','✒️','📝','📁','📂','📅','📆','📇'
        ]},
        symbols: { label: 'Символы', emojis: [
            '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝',
            '❤️‍🔥','❤️‍🩹','💟','☮️','✝️','☪️','🕉️','☸️','🪯','✡️','🔯','🕎','☯️','☦️','🛐','⛎',
            '♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚',
            '🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌',
            '⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️',
            '⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀',
            '🆒','🆓','🆕','🆖','🆗','🆙','🆚','🎵','🎶','〰️','➰','✔️','☑️','🔘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔸','🔹','🔶','🔷','▪️','▫️','◾','◽','◼️','◻️','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫'
        ]},
        flags: { label: 'Флаги', emojis: [
            '🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️',
            '🇷🇺','🇺🇦','🇧🇾','🇰🇿','🇺🇸','🇬🇧','🇩🇪','🇫🇷','🇮🇹','🇪🇸','🇵🇹','🇧🇷','🇯🇵','🇰🇷','🇨🇳','🇮🇳',
            '🇹🇷','🇦🇪','🇸🇦','🇮🇱','🇦🇺','🇨🇦','🇲🇽','🇦🇷','🇨🇱','🇨🇴','🇵🇪','🇻🇪','🇪🇬','🇿🇦','🇳🇬','🇰🇪',
            '🇹🇭','🇻🇳','🇮🇩','🇵🇭','🇲🇾','🇸🇬','🇳🇿','🇫🇮','🇸🇪','🇳🇴','🇩🇰','🇮🇪','🇳🇱','🇧🇪','🇨🇭','🇦🇹',
            '🇵🇱','🇨🇿','🇷🇴','🇭🇺','🇬🇷','🇭🇷','🇷🇸','🇧🇬','🇬🇪','🇦🇲','🇦🇿','🇺🇿','🇰🇬','🇹🇯','🇹🇲','🇲🇩'
        ]}
    };

    let frequentEmojis = JSON.parse(localStorage.getItem('vm_frequent_emoji') || '[]');
    let currentEmojiCat = 'frequent';

    function initEmojiPicker() {
        emojiCategories.frequent.emojis = frequentEmojis.slice(0, 32);
        renderEmojiCategory(currentEmojiCat);

        // Tab clicks
        document.querySelectorAll('.emoji-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                const cat = tab.dataset.cat;
                currentEmojiCat = cat;
                document.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderEmojiCategory(cat);
            });
        });

        // Search
        document.getElementById('emoji-search').addEventListener('input', (e) => {
            const q = e.target.value.trim().toLowerCase();
            if (!q) { renderEmojiCategory(currentEmojiCat); return; }
            // Search all categories
            const grid = document.getElementById('emoji-grid');
            grid.innerHTML = '';
            Object.values(emojiCategories).forEach(cat => {
                cat.emojis.forEach(emoji => {
                    if (emoji.includes(q)) addEmojiButton(grid, emoji);
                });
            });
            if (!grid.children.length) {
                grid.innerHTML = '<div class="emoji-cat-label">Ничего не найдено</div>';
            }
        });
    }

    function renderEmojiCategory(catKey) {
        const grid = document.getElementById('emoji-grid');
        grid.innerHTML = '';

        if (catKey === 'frequent') {
            if (frequentEmojis.length === 0) {
                grid.innerHTML = '<div class="emoji-cat-label">Начните использовать эмодзи — они появятся здесь</div>';
                return;
            }
            const label = document.createElement('div');
            label.className = 'emoji-cat-label';
            label.textContent = 'Часто используемые';
            grid.appendChild(label);
            frequentEmojis.slice(0, 32).forEach(e => addEmojiButton(grid, e));
            return;
        }

        const cat = emojiCategories[catKey];
        if (!cat) return;
        const label = document.createElement('div');
        label.className = 'emoji-cat-label';
        label.textContent = cat.label;
        grid.appendChild(label);
        cat.emojis.forEach(e => addEmojiButton(grid, e));
        grid.scrollTop = 0;
    }

    function addEmojiButton(grid, emoji) {
        const btn = document.createElement('button');
        btn.textContent = emoji;
        btn.addEventListener('click', () => {
            const input = document.getElementById('message-input');
            input.value += emoji;
            input.focus();
            document.getElementById('emoji-picker').classList.add('hidden');
            updateInputButtons();
            trackFrequentEmoji(emoji);
        });
        grid.appendChild(btn);
    }

    function trackFrequentEmoji(emoji) {
        frequentEmojis = frequentEmojis.filter(e => e !== emoji);
        frequentEmojis.unshift(emoji);
        if (frequentEmojis.length > 50) frequentEmojis = frequentEmojis.slice(0, 50);
        localStorage.setItem('vm_frequent_emoji', JSON.stringify(frequentEmojis));
        emojiCategories.frequent.emojis = frequentEmojis.slice(0, 32);
    }

    // ==================== HELPERS ====================
    function getInitials(name) {
        return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatMessageText(text) {
        if (!text) return '';
        let escaped = escapeHtml(text);
        escaped = escaped.replace(/\*(.+?)\*/g, '<b>$1</b>');
        escaped = escaped.replace(/_(.+?)_/g, '<i>$1</i>');
        escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:var(--accent)">$1</a>');
        escaped = escaped.replace(/\n/g, '<br>');
        return escaped;
    }

    function formatTime(ts) {
        const date = new Date(ts);
        const now = new Date();
        const diff = now - date;
        const day = 86400000;
        if (diff < day && date.getDate() === now.getDate()) {
            return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        }
        if (diff < day * 2 && date.getDate() === now.getDate() - 1) return 'Вчера';
        if (diff < day * 7) return date.toLocaleDateString('ru-RU', { weekday: 'short' });
        return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
    }

    function formatTimeShort(ts) {
        return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }

    function formatDuration(sec) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' Б';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
        return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
    }

    function generateWaveformBars() {
        let html = '';
        for (let i = 0; i < 32; i++) {
            const h = 4 + Math.floor(Math.random() * 22);
            html += `<div class="voice-bar" style="height:${h}px"></div>`;
        }
        return html;
    }

    function scrollToBottom() {
        const container = document.getElementById('messages-container');
        if (container) setTimeout(() => container.scrollTop = container.scrollHeight, 10);
    }

    function showToast(text) {
        const toast = document.getElementById('toast');
        toast.textContent = text;
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 2500);
    }

    function updateInputButtons() {
        const input = document.getElementById('message-input');
        const sendBtn = document.getElementById('btn-send');
        const micBtn = document.getElementById('btn-mic');
        const vcBtn = document.getElementById('btn-video-circle');
        const hasText = input && input.value.trim().length > 0;
        if (sendBtn && micBtn && vcBtn) {
            if (hasText) {
                sendBtn.classList.remove('hidden');
                micBtn.classList.add('hidden');
                vcBtn.classList.add('hidden');
            } else {
                sendBtn.classList.add('hidden');
                micBtn.classList.remove('hidden');
                vcBtn.classList.remove('hidden');
            }
        }
    }

    // ==================== EVENT LISTENERS ====================
    function init() {
        loadTheme();
        initEmojiPicker();

        // Auth
        document.getElementById('btn-login').addEventListener('click', () => {
            login(document.getElementById('login-username').value, document.getElementById('login-password').value);
        });
        document.getElementById('btn-register').addEventListener('click', () => {
            register(
                document.getElementById('reg-displayname').value,
                document.getElementById('reg-username').value,
                document.getElementById('reg-password').value
            );
        });
        document.getElementById('show-register').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('login-form').classList.add('hidden');
            document.getElementById('register-form').classList.remove('hidden');
        });
        document.getElementById('show-login').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('register-form').classList.add('hidden');
            document.getElementById('login-form').classList.remove('hidden');
        });

        ['login-username', 'login-password'].forEach(id => {
            document.getElementById(id).addEventListener('keydown', (e) => {
                if (e.key === 'Enter') document.getElementById('btn-login').click();
            });
        });
        ['reg-displayname', 'reg-username', 'reg-password'].forEach(id => {
            document.getElementById(id).addEventListener('keydown', (e) => {
                if (e.key === 'Enter') document.getElementById('btn-register').click();
            });
        });

        // Slide menu
        document.getElementById('btn-menu').addEventListener('click', openSlideMenu);
        document.getElementById('slide-menu-overlay').addEventListener('click', closeSlideMenu);

        // Menu items
        document.getElementById('btn-settings').addEventListener('click', showSettings);
        document.getElementById('btn-darkmode').addEventListener('click', toggleDarkMode);
        document.getElementById('btn-logout').addEventListener('click', logout);
        document.getElementById('btn-saved').addEventListener('click', () => { closeSlideMenu(); showToast('Избранное пока в разработке'); });
        document.getElementById('btn-contacts').addEventListener('click', () => { closeSlideMenu(); showNewChatModal(); });
        document.getElementById('btn-new-group').addEventListener('click', () => { closeSlideMenu(); showToast('Группы пока в разработке'); });

        // New chat
        document.getElementById('btn-new-chat').addEventListener('click', showNewChatModal);
        document.getElementById('close-new-chat').addEventListener('click', () => {
            document.getElementById('new-chat-modal').classList.add('hidden');
        });

        // Settings
        document.getElementById('close-settings').addEventListener('click', () => {
            document.getElementById('settings-modal').classList.add('hidden');
        });
        document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
        document.getElementById('avatar-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) uploadAvatar(file);
        });

        // Send message
        document.getElementById('btn-send').addEventListener('click', sendMessage);
        document.getElementById('message-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });

        // Input typing + resize + button toggle
        document.getElementById('message-input').addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            updateInputButtons();
            if (currentChatId) {
                if (!typingTimeout) {
                    wsSend({ type: 'typing', chatId: currentChatId });
                    typingTimeout = setTimeout(() => { typingTimeout = null; }, 2000);
                }
            }
        });

        // Attach button & menu
        document.getElementById('btn-attach').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleAttachMenu();
        });

        document.getElementById('attach-photo').addEventListener('click', () => {
            document.getElementById('attach-menu').classList.add('hidden');
            handleFileSelect('file-input-photo', 'auto');
        });
        document.getElementById('attach-file').addEventListener('click', () => {
            document.getElementById('attach-menu').classList.add('hidden');
            handleFileSelect('file-input-file', 'file');
        });
        // Video circle button (direct, like Telegram)
        document.getElementById('btn-video-circle').addEventListener('click', () => {
            openVideoCircleModal();
        });

        // Mic button
        document.getElementById('btn-mic').addEventListener('click', startVoiceRecording);
        document.getElementById('btn-cancel-voice').addEventListener('click', cancelVoiceRecording);
        document.getElementById('btn-send-voice').addEventListener('click', sendVoiceRecording);

        // Video circle modal
        document.getElementById('btn-cancel-video-circle').addEventListener('click', closeVideoCircleModal);
        document.getElementById('btn-toggle-video-circle').addEventListener('click', toggleVideoCircleRecording);
        document.getElementById('btn-send-video-circle').addEventListener('click', sendVideoCircle);

        // Close attach menu on outside click
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('attach-menu');
            const btn = document.getElementById('btn-attach');
            if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                menu.classList.add('hidden');
            }
        });

        // Search
        document.getElementById('search-input').addEventListener('input', (e) => { renderChatList(e.target.value); });

        // Back button (mobile)
        document.getElementById('btn-back').addEventListener('click', showEmptyState);

        // Emoji
        document.getElementById('btn-emoji').addEventListener('click', () => {
            document.getElementById('emoji-picker').classList.toggle('hidden');
        });
        document.addEventListener('click', (e) => {
            const picker = document.getElementById('emoji-picker');
            const btn = document.getElementById('btn-emoji');
            if (!picker.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                picker.classList.add('hidden');
            }
        });

        // Close modals on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) overlay.classList.add('hidden');
            });
        });

        // Custom events for media playback
        document.addEventListener('lightbox', (e) => openLightbox(e.detail));
        document.addEventListener('playvoice', (e) => playVoice(e.detail));
        document.addEventListener('playvideo', (e) => playVideoCircle(e.detail));

        // Responsive
        window.addEventListener('resize', () => { isMobile = window.innerWidth <= 768; });

        // Mobile keyboard handling via visualViewport
        if (isMobile && window.visualViewport) {
            const vv = window.visualViewport;
            let initialHeight = vv.height;

            vv.addEventListener('resize', () => {
                const keyboardOpen = vv.height < initialHeight * 0.85;
                document.body.classList.toggle('keyboard-open', keyboardOpen);

                // Adjust app height to visible viewport
                const appLayout = document.querySelector('.app-layout');
                if (appLayout) {
                    appLayout.style.height = vv.height + 'px';
                }

                // Scroll to bottom when keyboard opens in chat
                if (keyboardOpen && currentChatId) {
                    const mc = document.getElementById('messages-container');
                    if (mc) {
                        setTimeout(() => { mc.scrollTop = mc.scrollHeight; }, 50);
                    }
                }
            });

            vv.addEventListener('scroll', () => {
                // Keep input area pinned on iOS
                const inputArea = document.getElementById('input-area');
                if (inputArea && !inputArea.classList.contains('hidden')) {
                    document.documentElement.scrollTop = 0;
                    document.body.scrollTop = 0;
                }
            });

            // Update initial height on orientation change
            window.addEventListener('orientationchange', () => {
                setTimeout(() => { initialHeight = vv.height; }, 300);
            });
        }

        // Prevent pull-to-refresh on mobile
        document.addEventListener('touchmove', (e) => {
            if (e.target.closest('.messages-container, .chat-list, .modal-body, .slide-menu-nav, .emoji-picker')) return;
            if (e.touches.length > 1) return;
            e.preventDefault();
        }, { passive: false });

        checkSession();
    }

    document.addEventListener('DOMContentLoaded', init);

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
})();
