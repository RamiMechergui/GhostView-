const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const TOP = 78;
const BOTTOM = 22;
const DB_PATH = path.join(app.getPath('userData'), 'ghostview.db');

app.commandLine.appendSwitch('disable-features', 'MediaRouter,ChromeWhatsNewUI');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-sync');

let mainWindow;
let tabs = [];
let activeId = null;
let idCounter = 0;
let currentUser = null;
let currentWorkspace = null;
let autoSaveInterval = null;
let idleTimeout = null;
const IDLE_TIMEOUT_MS = 300000;
let panelOpen = false;
const PANEL_WIDTH = 400;

let db;

// ── Database Initialization ──

function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const jsonFile = path.join(app.getPath('userData'), 'ghostview-data.json');
  const hasJson = fs.existsSync(jsonFile);

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      pseudo TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      salt TEXT NOT NULL,
      created INTEGER NOT NULL,
      photo TEXT,
      active_workspace TEXT DEFAULT 'default'
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT NOT NULL,
      user_pseudo TEXT NOT NULL,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (id, user_pseudo)
    );
    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      timestamp INTEGER NOT NULL
    );
  `);

  // Migrate from JSON if exists
  if (hasJson) {
    try {
      const json = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
      if (json.users) {
        const insUser = db.prepare('INSERT OR IGNORE INTO users (pseudo, password, salt, created, photo, active_workspace) VALUES (?, ?, ?, ?, ?, ?)');
        const insWS = db.prepare('INSERT OR IGNORE INTO workspaces (id, user_pseudo, name, created) VALUES (?, ?, ?, ?)');
        const insTab = db.prepare('INSERT INTO tabs (workspace_id, user_pseudo, url, title) VALUES (?, ?, ?, ?)');
        const insHist = db.prepare('INSERT INTO history (workspace_id, user_pseudo, url, title, timestamp) VALUES (?, ?, ?, ?, ?)');
        const insBm = db.prepare('INSERT INTO bookmarks (workspace_id, user_pseudo, url, title, timestamp) VALUES (?, ?, ?, ?, ?)');

        const tx = db.transaction(() => {
          for (const [key, u] of Object.entries(json.users)) {
            insUser.run(key, u.password, u.salt, u.created || Date.now(), u.photo || null, u.activeWorkspace || 'default');
            const wss = u.workspaces || { 'default': { name: 'Default', tabs: u.tabs || [], history: u.history || [], created: u.created || Date.now() } };
            for (const [wsId, ws] of Object.entries(wss)) {
              insWS.run(wsId, key, ws.name, ws.created);
              if (ws.tabs) ws.tabs.forEach(t => insTab.run(wsId, key, t.url || '', t.title || ''));
              if (ws.history) ws.history.forEach(h => insHist.run(wsId, key, h.url, h.title || '', h.timestamp));
              if (ws.bookmarks) ws.bookmarks.forEach(b => insBm.run(wsId, key, b.url, b.title || '', b.timestamp));
            }
          }
        });
        tx();
      }
      fs.renameSync(jsonFile, jsonFile + '.bak');
    } catch(e) { console.error('Migration error:', e); }
  }
}

// ── DB Helper Functions ──

function getUser(pseudo) {
  return db.prepare('SELECT * FROM users WHERE pseudo = ?').get(pseudo.toLowerCase());
}

function getWorkspaces(pseudo) {
  return db.prepare('SELECT * FROM workspaces WHERE user_pseudo = ?').all(pseudo);
}

function getWorkspace(pseudo, wsId) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_pseudo = ?').get(wsId, pseudo);
}

function getTabs(pseudo, wsId) {
  return db.prepare('SELECT url, title FROM tabs WHERE user_pseudo = ? AND workspace_id = ?').all(pseudo, wsId);
}

function saveTabs(pseudo, wsId, tabList) {
  const del = db.prepare('DELETE FROM tabs WHERE user_pseudo = ? AND workspace_id = ?');
  const ins = db.prepare('INSERT INTO tabs (user_pseudo, workspace_id, url, title) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(pseudo, wsId);
    for (const t of tabList) ins.run(pseudo, wsId, t.url, t.title);
  });
  tx();
}

function getHistory(pseudo, wsId) {
  return db.prepare('SELECT url, title, timestamp FROM history WHERE user_pseudo = ? AND workspace_id = ? ORDER BY timestamp DESC LIMIT 200').all(pseudo, wsId);
}

function getBookmarks(pseudo, wsId) {
  return db.prepare('SELECT url, title, timestamp FROM bookmarks WHERE user_pseudo = ? AND workspace_id = ? ORDER BY timestamp DESC').all(pseudo, wsId);
}

function ensureDefaultWorkspace(pseudo) {
  const existing = getWorkspace(pseudo, 'default');
  if (!existing) {
    db.prepare('INSERT OR IGNORE INTO workspaces (id, user_pseudo, name, created) VALUES (?, ?, ?, ?)').run('default', pseudo, 'Default', Date.now());
  }
}

// ── Auth ──

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return computed === hash;
}

function userExists(pseudo) {
  return !!getUser(pseudo);
}

function registerUser(pseudo, password) {
  const key = pseudo.toLowerCase();
  if (userExists(key)) return false;
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (pseudo, password, salt, created, photo, active_workspace) VALUES (?, ?, ?, ?, ?, ?)').run(key, hash, salt, Date.now(), null, 'default');
  ensureDefaultWorkspace(key);
  return true;
}

function loginUser(pseudo, password) {
  const key = pseudo.toLowerCase();
  const user = getUser(key);
  if (!user) return false;
  if (!verifyPassword(password, user.salt, user.password)) return false;
  currentUser = key;
  ensureDefaultWorkspace(key);
  resetIdleTimer();
  return true;
}

// ── Icon / Menu ──

function findIcon() {
  const exts = ['.png', '.ico', '.jpg', '.jpeg'];
  const dirs = [__dirname, path.join(__dirname, 'assets')];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, 'logo' + e);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function buildMenu() {
  if (!currentUser) { Menu.setApplicationMenu(null); return; }
  const user = getUser(currentUser);
  if (!user) { Menu.setApplicationMenu(null); return; }
  const wss = getWorkspaces(currentUser);
  if (!wss.length) { Menu.setApplicationMenu(null); return; }

  const ghostMenu = {
    label: 'GhostView', submenu: [
      {
        label: 'Return to Workspaces',
        click: () => {
          saveUserTabs();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-workspaces');
        },
      },
      {
        label: 'Return to Login',
        click: () => {
          saveUserTabs();
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-login');
        },
      },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ],
  };

  const wsMenu = { label: 'Workspaces', submenu: [] };
  const active = currentWorkspace || user.active_workspace || 'default';
  wss.forEach(w => {
    wsMenu.submenu.push({
      label: w.name,
      type: 'checkbox',
      checked: w.id === active,
      click: () => { if (w.id !== active) switchWorkspace(w.id); },
    });
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([ghostMenu, wsMenu]));
}

// ── Window ──

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 600, minHeight: 400,
    title: 'GhostView',
    backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  mainWindow.loadFile('login.html');
  mainWindow.webContents.on('context-menu', (e, params) => {
    const template = [];
    if (params.editFlags.canCut && params.selectionText) template.push({ label: 'Cut', role: 'cut' });
    if (params.editFlags.canCopy && params.selectionText) template.push({ label: 'Copy', role: 'copy' });
    if (params.editFlags.canPaste) template.push({ label: 'Paste', role: 'paste' });
    if (template.length > 0) template.push({ type: 'separator' });
    template.push({ label: 'Select All', role: 'selectAll' });
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });
}

// ── Browser Tab Management ──

function contentBounds() {
  const b = mainWindow.getBounds();
  const pw = panelOpen ? PANEL_WIDTH : 0;
  return { x: 0, y: TOP, width: b.width - pw, height: b.height - TOP - BOTTOM };
}

function addTab(url, partition) {
  const id = idCounter++;
  const wsPartition = partition || (currentWorkspace ? 'persist:ws_' + currentWorkspace : undefined);
  const view = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, partition: wsPartition },
  });

  const ses = view.webContents.session;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));

  view.setBounds(contentBounds());
  view.webContents.loadURL(url);

  const emit = (event, extra) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(event, { id, title: view.webContents.getTitle(), url: view.webContents.getURL(), ...extra });
    }
  };

  function emitNavState() {
    emit('nav-state', { canGoBack: view.webContents.canGoBack(), canGoForward: view.webContents.canGoForward() });
  }

  view.webContents.on('page-title-updated', (e, t) => {
    emit('tab-updated', { title: t });
    saveUserTabs();
  });
  view.webContents.on('did-navigate', (e, u) => {
    emit('tab-updated', { url: u });
    emitNavState();
    addHistory(u, view.webContents.getTitle());
    saveUserTabs();
  });
  view.webContents.on('did-navigate-in-page', (e, u) => {
    if (e.isMainFrame) {
      emit('tab-updated', { url: u });
      emitNavState();
      addHistory(u, view.webContents.getTitle());
      saveUserTabs();
    }
  });
  view.webContents.on('did-start-loading', () => emit('tab-loading', { loading: true }));
  view.webContents.on('did-stop-loading', () => {
    emit('tab-loading', { loading: false });
    emitNavState();
  });
  view.webContents.on('update-target-url', (e, u) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-url', u || '');
  });
  setupContextMenu(view.webContents);

  tabs.push({ id, view, url, title: '' });
  showTab(id);
  broadcastTabs();
  saveUserTabs();
  return id;
}

function addHistory(url, title) {
  if (!currentUser || !currentWorkspace || !url || url === 'about:blank') return;
  db.prepare('INSERT INTO history (user_pseudo, workspace_id, url, title, timestamp) VALUES (?, ?, ?, ?, ?)').run(currentUser, currentWorkspace, url, title || url, Date.now());
}

function saveUserTabs() {
  if (!currentUser || !currentWorkspace) return;
  if (tabs.length === 0) return;
  saveTabs(currentUser, currentWorkspace, tabs.map(t => ({
    url: t.view.webContents.getURL(),
    title: t.view.webContents.getTitle(),
  })));
}

function resetIdleTimer() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    if (!currentUser) return;
    saveUserTabs();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('return-to-login');
    }
  }, IDLE_TIMEOUT_MS);
}

function showTab(id) {
  tabs.forEach(t => {
    try { mainWindow.contentView.removeChildView(t.view); } catch(e) {}
  });
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    tab.view.setBounds(contentBounds());
    mainWindow.contentView.addChildView(tab.view);
    activeId = id;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tab-activated', { id, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() });
    }
  }
}

function closeTab(id) {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  try { mainWindow.contentView.removeChildView(tab.view); } catch(e) {}
  tab.view.webContents.close();
  tabs.splice(idx, 1);
  if (activeId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    showTab(next.id);
  }
  broadcastTabs();
  saveUserTabs();
}

function broadcastTabs() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tabs-list', tabs.map(t => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })));
  }
}

function activeTab() { return tabs.find(t => t.id === activeId); }

function destroyAllTabs() {
  tabs.forEach(t => {
    try { mainWindow.contentView.removeChildView(t.view); } catch(e) {}
    t.view.webContents.close();
  });
  tabs = [];
  activeId = null;
  idCounter = 0;
}

function openBrowser(workspaceId) {
  const user = getUser(currentUser);
  if (!user) return;
  ensureDefaultWorkspace(currentUser);
  currentWorkspace = workspaceId || user.active_workspace || 'default';
  db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(currentWorkspace, currentUser);

  mainWindow.loadFile('controls.html');
  buildMenu();
  const savedTabs = getTabs(currentUser, currentWorkspace);
  if (savedTabs.length > 0) {
    savedTabs.forEach(t => addTab(t.url));
  } else {
    addTab('https://www.google.com');
  }
  resetIdleTimer();
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(saveUserTabs, 30000);
}

async function switchWorkspace(workspaceId) {
  saveUserTabs();
  destroyAllTabs();

  const user = getUser(currentUser);
  if (!user) return;
  currentWorkspace = workspaceId;
  db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(workspaceId, currentUser);

  const savedTabs = getTabs(currentUser, workspaceId);
  if (savedTabs.length > 0) {
    savedTabs.forEach(t => addTab(t.url));
  } else {
    addTab('https://www.google.com');
  }
  resetIdleTimer();
  broadcastTabs();
  buildMenu();

  const ws = getWorkspace(currentUser, workspaceId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('workspace-switched', { id: workspaceId, name: ws ? ws.name : '' });
  }
}

// ── Context Menu ──

function setupContextMenu(wc) {
  wc.on('context-menu', (e, params) => {
    const template = [];
    if (params.linkURL) {
      template.push({ label: 'Open Link in New Tab', click: () => addTab(params.linkURL) });
      template.push({ label: 'Open Link in New Window', click: () => {
        const { shell } = require('electron');
        shell.openExternal(params.linkURL);
      }});
      template.push({ label: 'Copy Link Address', click: () => {
        const { clipboard } = require('electron');
        clipboard.writeText(params.linkURL);
      }});
      template.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      template.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
      template.push({ label: 'Copy Image Address', click: () => {
        const { clipboard } = require('electron');
        clipboard.writeText(params.srcURL);
      }});
      template.push({ type: 'separator' });
    }
    if (params.editFlags.canCut && params.selectionText) template.push({ label: 'Cut', role: 'cut' });
    if (params.editFlags.canCopy && params.selectionText) template.push({ label: 'Copy', role: 'copy' });
    if (params.editFlags.canPaste) template.push({ label: 'Paste', role: 'paste' });
    if (params.editFlags.canSelectAll) template.push({ label: 'Select All', role: 'selectAll' });
    if (params.selectionText) {
      template.push({ type: 'separator' });
      template.push({ label: 'Search Google for "' + params.selectionText.substring(0, 30) + '"', click: () => {
        addTab('https://www.google.com/search?q=' + encodeURIComponent(params.selectionText));
      }});
    }
    if (template.length > 0) template.push({ type: 'separator' });
    template.push({ label: 'Reload', role: 'reload' });
    if (!wc.isDevToolsOpened()) template.push({ label: 'Inspect Element', role: 'toggleDevTools' });
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });
}

// ── Settings Window ──

let settingsWindow = null;

ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  const iconPath = findIcon();
  settingsWindow = new BrowserWindow({
    width: 400, height: 580,
    parent: mainWindow, modal: true,
    title: 'Settings - GhostView',
    backgroundColor: '#0f0f1a',
    icon: iconPath || undefined,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
});

app.whenReady().then(() => { initDB(); createWindow(); });

// ── Auth IPC ──

ipcMain.handle('register', (e, pseudo, password) => {
  if (!pseudo || !password || pseudo.length < 2 || password.length < 3) {
    return { ok: false, error: 'Pseudonym (min 2 chars) and password (min 3 chars) required.' };
  }
  if (userExists(pseudo)) return { ok: false, error: 'User already exists.' };
  registerUser(pseudo, password);
  return { ok: true };
});

ipcMain.handle('login', (e, pseudo, password) => {
  if (!pseudo || !password) return { ok: false, error: 'Enter pseudonym and password.' };
  if (!loginUser(pseudo, password)) return { ok: false, error: 'Invalid credentials.' };
  return { ok: true };
});

ipcMain.handle('logout', () => {
  saveUserTabs();
  tabs.forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  tabs = [];
  currentUser = null;
  currentWorkspace = null;
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.handle('get-user', () => {
  if (!currentUser) return null;
  const user = getUser(currentUser);
  return user ? { pseudo: user.pseudo, photo: user.photo || null } : null;
});

ipcMain.handle('change-password', (e, oldPw, newPw) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const user = getUser(currentUser);
  if (!user) return { ok: false, error: 'User not found.' };
  if (!verifyPassword(oldPw, user.salt, user.password)) return { ok: false, error: 'Current password is incorrect.' };
  if (!newPw || newPw.length < 3) return { ok: false, error: 'New password must be at least 3 characters.' };
  const { salt, hash } = hashPassword(newPw);
  db.prepare('UPDATE users SET password = ?, salt = ? WHERE pseudo = ?').run(hash, salt, currentUser);
  return { ok: true };
});

ipcMain.handle('upload-photo', (e, base64) => {
  if (!currentUser) return { ok: false };
  db.prepare('UPDATE users SET photo = ? WHERE pseudo = ?').run(base64, currentUser);
  return { ok: true };
});

ipcMain.handle('verify-password', (e, password) => {
  if (!currentUser) return false;
  const user = getUser(currentUser);
  return user ? verifyPassword(password, user.salt, user.password) : false;
});

ipcMain.handle('login-guest', async () => {
  saveUserTabs();
  tabs.forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  tabs = [];
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  if (db) { try { db.close(); } catch(e) {} }
  try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch(e) {}
  const ses = session.defaultSession;
  await ses.clearCache();
  await ses.clearStorageData();
  await ses.clearAuthCache();
  initDB();
  const guestPseudo = 'Guest_' + Date.now().toString(36);
  const key = guestPseudo.toLowerCase();
  const { salt, hash } = hashPassword('guest');
  db.prepare('INSERT INTO users (pseudo, password, salt, created, photo, active_workspace) VALUES (?,?,?,?,?,?)').run(key, hash, salt, Date.now(), null, 'default');
  db.prepare('INSERT INTO workspaces (id, user_pseudo, name, created) VALUES (?,?,?,?)').run('default', key, 'Default', Date.now());
  currentUser = key;
  currentWorkspace = 'default';
  resetIdleTimer();
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.handle('get-history', () => {
  if (!currentUser || !currentWorkspace) return [];
  return getHistory(currentUser, currentWorkspace);
});

// ── Bookmarks IPC ──

ipcMain.handle('get-bookmarks', () => {
  if (!currentUser || !currentWorkspace) return [];
  return getBookmarks(currentUser, currentWorkspace);
});

ipcMain.handle('add-bookmark', (e, url, title) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  const existing = db.prepare('SELECT id FROM bookmarks WHERE user_pseudo = ? AND workspace_id = ? AND url = ?').get(currentUser, currentWorkspace, url);
  if (existing) return { ok: false, error: 'Already bookmarked.' };
  db.prepare('INSERT INTO bookmarks (user_pseudo, workspace_id, url, title, timestamp) VALUES (?, ?, ?, ?, ?)').run(currentUser, currentWorkspace, url, title || url, Date.now());
  return { ok: true };
});

ipcMain.handle('remove-bookmark', (e, url) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  db.prepare('DELETE FROM bookmarks WHERE user_pseudo = ? AND workspace_id = ? AND url = ?').run(currentUser, currentWorkspace, url);
  return { ok: true };
});

ipcMain.handle('is-bookmarked', (e, url) => {
  if (!currentUser || !currentWorkspace) return false;
  const bm = db.prepare('SELECT id FROM bookmarks WHERE user_pseudo = ? AND workspace_id = ? AND url = ?').get(currentUser, currentWorkspace, url);
  return !!bm;
});

// ── Workspace IPC ──

ipcMain.handle('get-workspaces', () => {
  if (!currentUser) return [];
  ensureDefaultWorkspace(currentUser);
  const wss = getWorkspaces(currentUser);
  return wss.map(w => ({
    id: w.id, name: w.name, created: w.created,
    tabCount: getTabs(currentUser, w.id).length,
  }));
});

ipcMain.handle('get-active-workspace', () => {
  if (!currentUser) return null;
  const user = getUser(currentUser);
  if (!user) return null;
  const id = user.active_workspace || 'default';
  const ws = getWorkspace(currentUser, id);
  return { id, name: ws ? ws.name : 'Default' };
});

ipcMain.handle('create-workspace', (e, name) => {
  if (!currentUser) return { ok: false, error: 'Not logged in.' };
  const id = 'ws_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  db.prepare('INSERT INTO workspaces (id, user_pseudo, name, created) VALUES (?, ?, ?, ?)').run(id, currentUser, name, Date.now());
  return { ok: true, id };
});

ipcMain.handle('rename-workspace', (e, id, name) => {
  if (!currentUser) return { ok: false };
  const ws = getWorkspace(currentUser, id);
  if (!ws) return { ok: false };
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ? AND user_pseudo = ?').run(name, id, currentUser);
  return { ok: true };
});

ipcMain.handle('delete-workspace', (e, id) => {
  if (!currentUser) return { ok: false };
  const wss = getWorkspaces(currentUser);
  if (wss.length <= 1) return { ok: false, error: 'Cannot delete the last workspace.' };
  const ws = getWorkspace(currentUser, id);
  if (!ws) return { ok: false };
  db.prepare('DELETE FROM tabs WHERE user_pseudo = ? AND workspace_id = ?').run(currentUser, id);
  db.prepare('DELETE FROM history WHERE user_pseudo = ? AND workspace_id = ?').run(currentUser, id);
  db.prepare('DELETE FROM bookmarks WHERE user_pseudo = ? AND workspace_id = ?').run(currentUser, id);
  db.prepare('DELETE FROM workspaces WHERE id = ? AND user_pseudo = ?').run(id, currentUser);
  const user = getUser(currentUser);
  if (user && user.active_workspace === id) {
    const remaining = getWorkspaces(currentUser);
    const nextId = remaining.length > 0 ? remaining[0].id : 'default';
    db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(nextId, currentUser);
    currentWorkspace = nextId;
  }
  return { ok: true };
});

ipcMain.handle('select-workspace', (e, id) => {
  if (!currentUser) return { ok: false };
  const ws = getWorkspace(currentUser, id);
  if (!ws) return { ok: false };
  openBrowser(id);
  return { ok: true };
});

ipcMain.handle('switch-workspace', async (e, id) => {
  if (!currentUser) return { ok: false };
  const ws = getWorkspace(currentUser, id);
  if (!ws) return { ok: false };
  await switchWorkspace(id);
  return { ok: true };
});

// ── Browser IPC ──

ipcMain.handle('cleanup-tabs', () => {
  saveUserTabs();
  tabs.forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  tabs = [];
  activeId = null;
  idCounter = 0;
  currentWorkspace = null;
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.on('clear-menu', () => Menu.setApplicationMenu(null));

ipcMain.on('enter-browser', () => {
  const user = getUser(currentUser);
  if (!user) return;
  ensureDefaultWorkspace(currentUser);
  Menu.setApplicationMenu(null);
  mainWindow.loadFile('workspace.html');
});

ipcMain.on('navigate', (e, url) => { const t = activeTab(); if (t) t.view.webContents.loadURL(url); });
ipcMain.on('navigate-new-tab', (e, url) => addTab(url || 'https://www.google.com'));
ipcMain.on('new-tab', (e, u) => addTab(u || 'https://www.google.com'));
ipcMain.on('close-tab', (e, id) => closeTab(id));
ipcMain.on('activate-tab', (e, id) => showTab(id));
ipcMain.on('go-back', () => { const t = activeTab(); if (t) t.view.webContents.goBack(); });
ipcMain.on('go-forward', () => { const t = activeTab(); if (t) t.view.webContents.goForward(); });
ipcMain.on('reload', () => { const t = activeTab(); if (t) t.view.webContents.reload(); });
ipcMain.on('stop', () => { const t = activeTab(); if (t) t.view.webContents.stop(); });
ipcMain.on('resize-content', () => { const t = activeTab(); if (t) t.view.setBounds(contentBounds()); });
ipcMain.on('panel-toggle', (e, open) => { panelOpen = open; const t = activeTab(); if (t) t.view.setBounds(contentBounds()); });
ipcMain.on('open-history', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-history'); });
ipcMain.handle('get-tabs', () => tabs.map(t => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })));

// ── Zoom ──

ipcMain.on('zoom-in', () => { const t = activeTab(); if (t) { const l = t.view.webContents.getZoomLevel(); t.view.webContents.setZoomLevel(l + 0.5); }});
ipcMain.on('zoom-out', () => { const t = activeTab(); if (t) { const l = t.view.webContents.getZoomLevel(); t.view.webContents.setZoomLevel(l - 0.5); }});
ipcMain.on('zoom-reset', () => { const t = activeTab(); if (t) t.view.webContents.setZoomLevel(0); });

// ── Find in Page ──

ipcMain.on('find-start', (e, text) => { const t = activeTab(); if (t && text) t.view.webContents.findInPage(text); });
ipcMain.on('find-next', (e, text) => { const t = activeTab(); if (t && text) t.view.webContents.findInPage(text, { findNext: true }); });
ipcMain.on('find-stop', () => { const t = activeTab(); if (t) t.view.webContents.stopFindInPage('clearSelection'); });

// ── Fullscreen ──

ipcMain.on('toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ── Home ──

ipcMain.on('go-home', () => {
  const t = activeTab();
  if (t) t.view.webContents.loadURL('https://www.google.com');
});

ipcMain.on('reset-idle', () => { if (currentUser) resetIdleTimer(); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async () => {
  saveUserTabs();
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData();
  if (currentWorkspace) {
    try {
      const ws = session.fromPartition('persist:ws_' + currentWorkspace);
      await ws.clearCache();
      await ws.clearStorageData();
    } catch(e) {}
  }
});
