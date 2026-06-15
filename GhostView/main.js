const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, dialog, shell, clipboard } = require('electron');
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
app.commandLine.appendSwitch('disable-features', 'msWebOOUI');
app.setAsDefaultProtocolClient('ghostview');

let mainWindow;
let workspaceTabs = {};
let activeIdPerWorkspace = {};
let idCounter = 0;
let currentUser = null;
let currentWorkspace = null;
let autoSaveInterval = null;
let idleTimeout = null;
const IDLE_TIMEOUT_MS = 300000;
let panelOpen = false;
const PANEL_WIDTH = 400;
let zoomLevel = 0;
let downloadsWindow = null;
let splitMode = false;
let splitLeft = null;
let splitRight = null;
let db;

function currentTabs() {
  return currentWorkspace ? (workspaceTabs[currentWorkspace] || []) : [];
}

function setCurrentTabs(arr) {
  if (currentWorkspace) workspaceTabs[currentWorkspace] = arr;
}

function getActiveId(wsId) { return activeIdPerWorkspace[wsId] || null; }
function setActiveId(wsId, id) { activeIdPerWorkspace[wsId] = id; }

function getActiveTab(wsId) {
  const tabs = workspaceTabs[wsId];
  if (!tabs) return null;
  const id = getActiveId(wsId);
  return tabs.find(t => t.id === id) || (tabs.length > 0 ? tabs[0] : null);
}

function syncViews() {
  Object.values(workspaceTabs).forEach(tabs => {
    tabs.forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isFS = mainWindow.isFullScreen();
  const b = mainWindow.getBounds();
  const pw = (panelOpen && !isFS) ? PANEL_WIDTH : 0;
  const top = TOP;
  const h = b.height - top - (isFS ? 0 : BOTTOM);
  if (splitMode && splitLeft && splitRight) {
    const halfW = Math.floor((b.width - pw) / 2);
    const gap = 3;
    const lt = getActiveTab(splitLeft);
    if (lt) { lt.view.setBounds({ x:0, y:top, width:halfW - gap, height:h }); mainWindow.contentView.addChildView(lt.view); }
    const rt = getActiveTab(splitRight);
    if (rt) { rt.view.setBounds({ x:halfW + gap, y:top, width:b.width - pw - halfW - gap, height:h }); mainWindow.contentView.addChildView(rt.view); }
  } else if (currentWorkspace) {
    const t = getActiveTab(currentWorkspace);
    if (t) { t.view.setBounds({ x:0, y:top, width:b.width-pw, height:h }); mainWindow.contentView.addChildView(t.view); }
  }
}

// ── Database ──

function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jsonFile = path.join(app.getPath('userData'), 'ghostview-data.json');
  const hasJson = fs.existsSync(jsonFile);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      pseudo TEXT PRIMARY KEY, password TEXT NOT NULL, salt TEXT NOT NULL,
      created INTEGER NOT NULL, photo TEXT, active_workspace TEXT DEFAULT 'default'
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT NOT NULL, user_pseudo TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY (id, user_pseudo)
    );
    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL, title TEXT DEFAULT '', timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_pseudo TEXT NOT NULL,
      url TEXT NOT NULL, title TEXT DEFAULT '', timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_pseudo TEXT NOT NULL,
      filename TEXT NOT NULL, url TEXT, save_path TEXT, total_bytes INTEGER DEFAULT 0,
      received_bytes INTEGER DEFAULT 0, start_time INTEGER NOT NULL,
      done INTEGER DEFAULT 0, success INTEGER DEFAULT 0, canceled INTEGER DEFAULT 0
    );
  `);
  if (hasJson) {
    try {
      const json = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
      if (json.users) {
        const insUser = db.prepare('INSERT OR IGNORE INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)');
        const insWS = db.prepare('INSERT OR IGNORE INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)');
        const insTab = db.prepare('INSERT INTO tabs (workspace_id,user_pseudo,url,title) VALUES (?,?,?,?)');
        const insHist = db.prepare('INSERT INTO history (workspace_id,user_pseudo,url,title,timestamp) VALUES (?,?,?,?,?)');
        const insBm = db.prepare('INSERT INTO bookmarks (workspace_id,user_pseudo,url,title,timestamp) VALUES (?,?,?,?,?)');
        const tx = db.transaction(() => {
          for (const [key, u] of Object.entries(json.users)) {
            insUser.run(key, u.password, u.salt, u.created||Date.now(), u.photo||null, u.activeWorkspace||'default');
            const wss = u.workspaces || { 'default': { name:'Default', tabs:u.tabs||[], history:u.history||[], created:u.created||Date.now() } };
            for (const [wsId, ws] of Object.entries(wss)) {
              insWS.run(wsId, key, ws.name, ws.created);
              if (ws.tabs) ws.tabs.forEach(t => insTab.run(wsId, key, t.url||'', t.title||''));
              if (ws.history) ws.history.forEach(h => insHist.run(wsId, key, h.url, h.title||'', h.timestamp));
              if (ws.bookmarks) ws.bookmarks.forEach(b => insBm.run(wsId, key, b.url, b.title||'', b.timestamp));
            }
          }
        });
        tx();
      }
      fs.renameSync(jsonFile, jsonFile + '.bak');
    } catch(e) { console.error('Migration error:', e); }
  }
}

function getUser(p) { return db.prepare('SELECT * FROM users WHERE pseudo=?').get(p.toLowerCase()); }
function getWorkspaces(p) { return db.prepare('SELECT * FROM workspaces WHERE user_pseudo=?').all(p); }
function getWorkspace(p, id) { return db.prepare('SELECT * FROM workspaces WHERE id=? AND user_pseudo=?').get(id, p); }
function getTabsDb(p, wsId) { return db.prepare('SELECT url, title FROM tabs WHERE user_pseudo=? AND workspace_id=?').all(p, wsId); }
function saveTabsDb(p, wsId, list) {
  const del = db.prepare('DELETE FROM tabs WHERE user_pseudo=? AND workspace_id=?');
  const ins = db.prepare('INSERT INTO tabs (user_pseudo,workspace_id,url,title) VALUES (?,?,?,?)');
  db.transaction(() => { del.run(p, wsId); list.forEach(t => ins.run(p, wsId, t.url, t.title)); })();
}
function getHistDb(p, wsId) { return db.prepare('SELECT url,title,timestamp FROM history WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC LIMIT 200').all(p, wsId); }
function getBmDb(p, wsId) { return db.prepare('SELECT url,title,timestamp FROM bookmarks WHERE user_pseudo=? AND workspace_id=? ORDER BY timestamp DESC').all(p, wsId); }
function ensureDefaultWs(p) { if (!getWorkspace(p, 'default')) db.prepare('INSERT OR IGNORE INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)').run('default', p, 'Default', Date.now()); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex') };
}
function verifyPassword(password, salt, hash) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex') === hash;
}
function userExists(p) { return !!getUser(p); }
function registerUser(pseudo, password) {
  const key = pseudo.toLowerCase();
  if (userExists(key)) return false;
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)').run(key, hash, salt, Date.now(), null, 'default');
  ensureDefaultWs(key);
  return true;
}
function loginUser(pseudo, password) {
  const key = pseudo.toLowerCase();
  const user = getUser(key);
  if (!user || !verifyPassword(password, user.salt, user.password)) return false;
  currentUser = key;
  ensureDefaultWs(key);
  resetIdleTimer();
  return true;
}

// ── Icon / Menu ──

function findIcon() {
  const exts = ['.png','.ico','.jpg','.jpeg'];
  const dirs = [__dirname, path.join(__dirname, 'assets')];
  for (const d of dirs) for (const e of exts) { const p = path.join(d, 'logo'+e); if (fs.existsSync(p)) return p; }
  return null;
}

function buildMenu() {
  if (!currentUser) { Menu.setApplicationMenu(null); return; }
  const user = getUser(currentUser);
  if (!user) { Menu.setApplicationMenu(null); return; }
  const wss = getWorkspaces(currentUser);
  if (!wss.length) { Menu.setApplicationMenu(null); return; }
  const active = currentWorkspace || user.active_workspace || 'default';

  const splitItems = [];
  if (splitMode) {
    splitItems.push({ label: 'Exit Split View', click: () => exitSplitMode() });
  } else {
    const others = wss.filter(w => w.id !== active);
    if (others.length > 0) {
      splitItems.push({ label: 'Split with:', enabled: false });
      others.forEach(w => {
        splitItems.push({ label: w.name, click: () => enterSplitMode(w.id) });
      });
    } else {
      splitItems.push({ label: 'Need 2+ workspaces', enabled: false });
    }
  }

  const ghostMenu = {
    label: 'AEGIS', submenu: [
      { label: 'Return to Workspaces', click: () => { saveUserTabsPersist(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-workspaces'); } },
      { label: 'Return to Login', click: () => { saveUserTabsPersist(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-login'); } },
      { type: 'separator' },
      { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => toggleDownloads() },
      { type: 'separator' },
      { label: 'Split', submenu: splitItems },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ],
  };
  const wsMenu = { label: 'Workspaces', submenu: [] };
  wss.forEach(w => {
    wsMenu.submenu.push({
      label: w.name, type: 'checkbox', checked: w.id === active,
      click: () => { if (w.id !== active) switchWorkspace(w.id); },
    });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([ghostMenu, wsMenu]));
}

// ── Window ──

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 600, minHeight: 400, fullscreen: true,
    title: 'AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
      webviewTag: false,
    },
  });
  mainWindow.loadFile('login.html');
  mainWindow.webContents.on('context-menu', (e, params) => {
    const t = [];
    if (params.editFlags.canCut && params.selectionText) t.push({ label:'Cut', role:'cut' });
    if (params.editFlags.canCopy && params.selectionText) t.push({ label:'Copy', role:'copy' });
    if (params.editFlags.canPaste) t.push({ label:'Paste', role:'paste' });
    if (t.length) t.push({ type:'separator' });
    t.push({ label:'Select All', role:'selectAll' });
    Menu.buildFromTemplate(t).popup({ window: mainWindow });
  });
  mainWindow.on('enter-full-screen', () => { if (!mainWindow.isDestroyed()) { mainWindow.webContents.send('fs-change', true); syncViews(); } });
  mainWindow.on('leave-full-screen', () => { if (!mainWindow.isDestroyed()) { mainWindow.webContents.send('fs-change', false); syncViews(); } });
  setupF11Handler(mainWindow.webContents);
}

// ── Tab Management ──

function contentBounds() {
  const b = mainWindow.getBounds();
  const pw = panelOpen ? PANEL_WIDTH : 0;
  return { x: 0, y: TOP, width: b.width - pw, height: b.height - TOP - BOTTOM };
}

function addTab(url, partition) {
  const tabs = currentTabs();
  const id = idCounter++;
  const wsPartition = partition || (currentWorkspace ? 'persist:ws_' + currentWorkspace : undefined);
  const view = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, partition: wsPartition, disableHtmlFullscreenWindowResize: false },
  });

  const ses = view.webContents.session;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  ses.on('will-download', (e, item) => handleDownload(item));

  view.setBounds(contentBounds());
  view.webContents.loadURL(url);
  setupF11Handler(view.webContents);

  const emit = (event, extra) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, { id, title: view.webContents.getTitle(), url: view.webContents.getURL(), ...extra });
  };
  function emitNav() { emit('nav-state', { canGoBack: view.webContents.canGoBack(), canGoForward: view.webContents.canGoForward() }); }

  view.webContents.on('page-title-updated', (e, t) => { emit('tab-updated', { title: t }); saveUserTabsPersist(); });
  view.webContents.on('did-navigate', (e, u) => { emit('tab-updated', { url: u }); emitNav(); addHistory(u, view.webContents.getTitle()); saveUserTabsPersist(); });
  view.webContents.on('did-navigate-in-page', (e, u) => { if (e.isMainFrame) { emit('tab-updated', { url: u }); emitNav(); addHistory(u, view.webContents.getTitle()); saveUserTabsPersist(); } });
  view.webContents.on('did-start-loading', () => emit('tab-loading', { loading: true }));
  view.webContents.on('did-stop-loading', () => { emit('tab-loading', { loading: false }); emitNav(); });
  view.webContents.on('update-target-url', (e, u) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-url', u || ''); });

  // YouTube fullscreen support
  view.webContents.on('enter-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', true);
      view.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: mainWindow.getBounds().height });
    }
  });
  view.webContents.on('leave-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', false);
      syncViews();
    }
  });

  // Open links in new tab instead of new window
  view.webContents.setWindowOpenHandler(({ url }) => {
    addTab(url);
    return { action: 'deny' };
  });

  setupContextMenu(view.webContents);

  tabs.push({ id, view, url, title: '' });
  setCurrentTabs(tabs);
  setActiveId(currentWorkspace, id);
  syncViews();
  broadcastTabs();
  saveUserTabsPersist();
  return id;
}

function addHistory(url, title) {
  if (!currentUser || !currentWorkspace || !url || url === 'about:blank') return;
  db.prepare('INSERT INTO history (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)').run(currentUser, currentWorkspace, url, title||url, Date.now());
}

function saveUserTabsPersist() {
  const tabs = currentTabs();
  if (!currentUser || !currentWorkspace || !tabs.length) return;
  saveTabsDb(currentUser, currentWorkspace, tabs.map(t => ({ url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })));
}

function resetIdleTimer() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    if (!currentUser) return;
    saveUserTabsPersist();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('return-to-login');
  }, IDLE_TIMEOUT_MS);
}

function showTab(id) {
  setActiveId(currentWorkspace, id);
  syncViews();
  const tab = getActiveTab(currentWorkspace);
  if (tab && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tab-activated', { id, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() });
}

function closeTab(id) {
  const tabs = currentTabs();
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  try { mainWindow.contentView.removeChildView(tab.view); } catch(e) {}
  tab.view.webContents.close();
  tabs.splice(idx, 1);
  setCurrentTabs(tabs);
  if (getActiveId(currentWorkspace) === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    setActiveId(currentWorkspace, next.id);
  }
  syncViews();
  broadcastTabs();
  saveUserTabsPersist();
}

function broadcastTabs() {
  const tabs = currentTabs();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tabs-list', tabs.map(t => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })));
}

function activeTab() { return getActiveTab(currentWorkspace); }

function hideAllViews() {
  Object.values(workspaceTabs).forEach(tabs => {
    tabs.forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  });
}

function showActiveView() { syncViews(); }

function openBrowser(workspaceId) {
  const user = getUser(currentUser);
  if (!user) return;
  ensureDefaultWs(currentUser);
  currentWorkspace = workspaceId || user.active_workspace || 'default';
  db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(currentWorkspace, currentUser);

  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('fs-change', mainWindow.isFullScreen());
  });
  mainWindow.loadFile('controls.html');
  buildMenu();

  if (!workspaceTabs[currentWorkspace]) {
    const savedTabs = getTabsDb(currentUser, currentWorkspace);
    workspaceTabs[currentWorkspace] = [];
    if (savedTabs.length > 0) savedTabs.forEach(t => addTab(t.url));
    else addTab('https://www.google.com');
  } else {
    syncViews();
    broadcastTabs();
  }
  resetIdleTimer();
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(saveUserTabsPersist, 30000);
}

async function switchWorkspace(workspaceId) {
  if (splitMode) { splitMode = false; splitLeft = null; splitRight = null; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: false }); }
  const prevWs = currentWorkspace;
  saveUserTabsPersist();
  hideAllViews();
  const user = getUser(currentUser);
  if (!user) return;
  currentWorkspace = workspaceId;
  db.prepare('UPDATE users SET active_workspace = ? WHERE pseudo = ?').run(workspaceId, currentUser);

  if (!workspaceTabs[workspaceId]) {
    const savedTabs = getTabsDb(currentUser, workspaceId);
    workspaceTabs[workspaceId] = [];
    if (savedTabs.length > 0) savedTabs.forEach(t => addTab(t.url));
    else addTab('https://www.google.com');
  } else {
    const tabs = workspaceTabs[workspaceId];
    if (!tabs.find(t => t.id === getActiveId(workspaceId))) {
      setActiveId(workspaceId, tabs.length > 0 ? tabs[0].id : null);
    }
    syncViews();
    broadcastTabs();
  }
  resetIdleTimer();
  buildMenu();
  const ws = getWorkspace(currentUser, workspaceId);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace-switched', { id: workspaceId, name: ws ? ws.name : '' });
}

function destroyAllTabsForUser() {
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => {
      try { mainWindow.contentView.removeChildView(t.view); } catch(e) {}
      t.view.webContents.close();
    });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  idCounter = 0;
  splitMode = false;
  splitLeft = null;
  splitRight = null;
}

// ── Context Menu ──

function setupContextMenu(wc) {
  wc.on('context-menu', (e, params) => {
    const template = [];
    if (params.linkURL) {
      template.push({ label: 'Open Link in New Tab', click: () => addTab(params.linkURL) });
      template.push({ label: 'Open Link in New Window', click: () => shell.openExternal(params.linkURL) });
      template.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
      template.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      template.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
      template.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
      template.push({ type: 'separator' });
    }
    if (params.editFlags.canCut && params.selectionText) template.push({ label:'Cut', role:'cut' });
    if (params.editFlags.canCopy && params.selectionText) template.push({ label:'Copy', role:'copy' });
    if (params.editFlags.canPaste) template.push({ label:'Paste', role:'paste' });
    if (params.editFlags.canSelectAll) template.push({ label:'Select All', role:'selectAll' });
    if (params.selectionText) {
      template.push({ type: 'separator' });
      template.push({ label: 'Search Google for "' + params.selectionText.substring(0, 30) + '"', click: () => addTab('https://www.google.com/search?q=' + encodeURIComponent(params.selectionText)) });
    }
    if (template.length) template.push({ type: 'separator' });
    template.push({ label:'Reload', role:'reload' });
    if (!wc.isDevToolsOpened()) template.push({ label:'Inspect Element', role:'toggleDevTools' });
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
}

// ── Downloads ──

let downloadsList = [];
let downloadIdCounter = 0;

function handleDownload(item) {
  const name = item.getFilename();
  const total = item.getTotalBytes();
  const url = item.getURL();
  const dlId = downloadIdCounter++;
  downloadsList.push({ id: dlId, name, total, received: 0, speed: 0, start: Date.now(), done: false, success: false, canceled: false, url, savePath: '' });

  const entry = downloadsList[downloadsList.length - 1];

  item.on('updated', (e, state) => {
    const received = item.getReceivedBytes();
    entry.received = received;
    entry.speed = item.getCurrentBytesPerSecond();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', {
      id: dlId, name, total, received, speed: entry.speed, start: entry.start, done: false,
    });
  });

  item.on('done', (e, state) => {
    const completed = state === 'completed';
    entry.done = true;
    entry.success = completed;
    entry.savePath = item.getSavePath();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', {
      id: dlId, name, total, received: total, speed: 0, start: entry.start, done: true, success: completed,
    });
    if (currentUser) {
      db.prepare('INSERT INTO downloads (user_pseudo,filename,url,save_path,total_bytes,received_bytes,start_time,done,success,canceled) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        currentUser, name, url, entry.savePath || '', total, completed ? total : entry.received, entry.start, completed ? 1 : 0, completed ? 1 : 0, state === 'cancelled' ? 1 : 0
      );
    }
  });

  item.setSaveDialogPath(path.join(app.getPath('downloads'), name));
  item.saveDialog().then(r => { if (r.canceled) item.cancel(); });
}

ipcMain.handle('get-downloads', () => downloadsList.map(d => ({
  id: d.id, name: d.name, total: d.total, received: d.received, speed: d.speed,
  start: d.start, done: d.done, success: d.success, canceled: d.canceled, url: d.url,
})));

ipcMain.handle('get-downloads-history', () => {
  if (!currentUser) return [];
  return db.prepare('SELECT * FROM downloads WHERE user_pseudo=? ORDER BY start_time DESC LIMIT 100').all(currentUser);
});

function toggleDownloads() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('toggle-downloads');
}

ipcMain.handle('open-download-folder', (e, savePath) => {
  if (savePath) { try { shell.showItemInFolder(savePath); } catch(e) {} }
});

// ── Settings Window ──

let settingsWindow = null;
ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 400, height: 580, parent: mainWindow, modal: true,
    title: 'Settings - AEGIS', backgroundColor: '#0f0f1a',
    icon: findIcon() || undefined, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,
    },
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
});

app.whenReady().then(() => { initDB(); createWindow(); });

// ── Auth IPC ──

ipcMain.handle('register', (e, pseudo, password) => {
  if (!pseudo || !password || pseudo.length < 2 || password.length < 3) return { ok: false, error: 'Pseudonym (min 2 chars) and password (min 3 chars) required.' };
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
  saveUserTabsPersist();
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  currentUser = null;
  currentWorkspace = null;
  idCounter = 0;
  splitMode = false; splitLeft = null; splitRight = null;
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
  db.prepare('UPDATE users SET password=?,salt=? WHERE pseudo=?').run(hash, salt, currentUser);
  return { ok: true };
});

ipcMain.handle('upload-photo', (e, base64) => {
  if (!currentUser) return { ok: false };
  db.prepare('UPDATE users SET photo=? WHERE pseudo=?').run(base64, currentUser);
  return { ok: true };
});

ipcMain.handle('verify-password', (e, password) => {
  if (!currentUser) return false;
  const user = getUser(currentUser);
  return user ? verifyPassword(password, user.salt, user.password) : false;
});

ipcMain.handle('login-guest', async () => {
  saveUserTabsPersist();
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} t.view.webContents.close(); });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  idCounter = 0;
  splitMode = false; splitLeft = null; splitRight = null;
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  if (db) { try { db.close(); } catch(e) {} }
  try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch(e) {}
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearAuthCache();
  initDB();
  const guestPseudo = 'Guest_' + Date.now().toString(36);
  const key = guestPseudo.toLowerCase();
  const { salt, hash } = hashPassword('guest');
  db.prepare('INSERT INTO users (pseudo,password,salt,created,photo,active_workspace) VALUES (?,?,?,?,?,?)').run(key, hash, salt, Date.now(), null, 'default');
  db.prepare('INSERT INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)').run('default', key, 'Default', Date.now());
  currentUser = key;
  currentWorkspace = 'default';
  resetIdleTimer();
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.handle('get-history', () => {
  if (!currentUser || !currentWorkspace) return [];
  return getHistDb(currentUser, currentWorkspace);
});

// ── Bookmarks IPC ──

ipcMain.handle('get-bookmarks', () => {
  if (!currentUser || !currentWorkspace) return [];
  return getBmDb(currentUser, currentWorkspace);
});

ipcMain.handle('add-bookmark', (e, url, title) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  if (db.prepare('SELECT id FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?').get(currentUser, currentWorkspace, url)) return { ok: false, error: 'Already bookmarked.' };
  db.prepare('INSERT INTO bookmarks (user_pseudo,workspace_id,url,title,timestamp) VALUES (?,?,?,?,?)').run(currentUser, currentWorkspace, url, title||url, Date.now());
  return { ok: true };
});

ipcMain.handle('remove-bookmark', (e, url) => {
  if (!currentUser || !currentWorkspace) return { ok: false };
  db.prepare('DELETE FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?').run(currentUser, currentWorkspace, url);
  return { ok: true };
});

ipcMain.handle('is-bookmarked', (e, url) => {
  if (!currentUser || !currentWorkspace) return false;
  return !!db.prepare('SELECT id FROM bookmarks WHERE user_pseudo=? AND workspace_id=? AND url=?').get(currentUser, currentWorkspace, url);
});

// ── Workspace IPC ──

ipcMain.handle('get-workspaces', () => {
  if (!currentUser) return [];
  ensureDefaultWs(currentUser);
  return getWorkspaces(currentUser).map(w => ({ id: w.id, name: w.name, created: w.created, tabCount: getTabsDb(currentUser, w.id).length }));
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
  db.prepare('INSERT INTO workspaces (id,user_pseudo,name,created) VALUES (?,?,?,?)').run(id, currentUser, name, Date.now());
  return { ok: true, id };
});

ipcMain.handle('rename-workspace', (e, id, name) => {
  if (!currentUser) return { ok: false };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  db.prepare('UPDATE workspaces SET name=? WHERE id=? AND user_pseudo=?').run(name, id, currentUser);
  return { ok: true };
});

ipcMain.handle('delete-workspace', (e, id) => {
  if (!currentUser) return { ok: false };
  const wss = getWorkspaces(currentUser);
  if (wss.length <= 1) return { ok: false, error: 'Cannot delete the last workspace.' };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  if (workspaceTabs[id]) {
    workspaceTabs[id].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} t.view.webContents.close(); });
    delete workspaceTabs[id];
  }
  db.prepare('DELETE FROM tabs WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
  db.prepare('DELETE FROM history WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
  db.prepare('DELETE FROM bookmarks WHERE user_pseudo=? AND workspace_id=?').run(currentUser, id);
  db.prepare('DELETE FROM workspaces WHERE id=? AND user_pseudo=?').run(id, currentUser);
  const user = getUser(currentUser);
  if (user && user.active_workspace === id) {
    const remaining = getWorkspaces(currentUser);
    const nextId = remaining.length ? remaining[0].id : 'default';
    db.prepare('UPDATE users SET active_workspace=? WHERE pseudo=?').run(nextId, currentUser);
    if (currentWorkspace === id) currentWorkspace = nextId;
  }
  return { ok: true };
});

ipcMain.handle('select-workspace', (e, id) => {
  if (!currentUser) return { ok: false };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  openBrowser(id);
  return { ok: true };
});

ipcMain.handle('switch-workspace', async (e, id) => {
  if (!currentUser) return { ok: false };
  if (!getWorkspace(currentUser, id)) return { ok: false };
  await switchWorkspace(id);
  return { ok: true };
});

// ── Split View ──

function enterSplitMode(rightWsId) {
  if (!currentUser || !currentWorkspace) return false;
  if (splitMode) return false;
  if (rightWsId === currentWorkspace) return false;
  if (!getWorkspace(currentUser, rightWsId)) return false;
  if (!workspaceTabs[rightWsId]) {
    const savedTabs = getTabsDb(currentUser, rightWsId);
    workspaceTabs[rightWsId] = [];
    savedTabs.forEach(t => addTabToSplit(t.url, rightWsId));
    if (workspaceTabs[rightWsId].length === 0) addTabToSplit('https://www.google.com', rightWsId);
    if (!getActiveId(rightWsId)) setActiveId(rightWsId, workspaceTabs[rightWsId][0]?.id);
  }
  splitMode = true;
  splitLeft = currentWorkspace;
  splitRight = rightWsId;
  syncViews();
  buildMenu();
  const lWs = getWorkspace(currentUser, splitLeft);
  const rWs = getWorkspace(currentUser, splitRight);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: true, left: splitLeft, right: splitRight, leftName: lWs ? lWs.name : 'Left', rightName: rWs ? rWs.name : 'Right', focused: 'left' });
  return true;
}

function exitSplitMode() {
  if (!splitMode) return false;
  splitMode = false;
  currentWorkspace = splitLeft;
  splitLeft = null;
  splitRight = null;
  syncViews();
  broadcastTabs();
  buildMenu();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: false });
  return true;
}

ipcMain.handle('enter-split', (e, rightWsId) => ({ ok: enterSplitMode(rightWsId) }));

ipcMain.handle('exit-split', () => ({ ok: exitSplitMode() }));

ipcMain.handle('focus-split-pane', (e, side) => {
  if (!splitMode) return;
  if (side === 'left' && splitLeft) currentWorkspace = splitLeft;
  else if (side === 'right' && splitRight) currentWorkspace = splitRight;
  broadcastTabs();
  const lWs = getWorkspace(currentUser, splitLeft);
  const rWs = getWorkspace(currentUser, splitRight);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('split-changed', { active: true, left: splitLeft, right: splitRight, leftName: lWs ? lWs.name : 'Left', rightName: rWs ? rWs.name : 'Right', focused: side });
});

function addTabToSplit(url, wsId) {
  const tabs = workspaceTabs[wsId] || [];
  const id = idCounter++;
  const view = new WebContentsView({
    webPreferences: { sandbox: true, spellcheck: false, partition: 'persist:ws_' + wsId, disableHtmlFullscreenWindowResize: false },
  });
  const ses = view.webContents.session;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  ses.on('will-download', (e, item) => handleDownload(item));
  view.setBounds({ x:0, y:TOP, width:100, height:100 });
  view.webContents.loadURL(url);
  setupF11Handler(view.webContents);
  const emit = (event, extra) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, { id, title: view.webContents.getTitle(), url: view.webContents.getURL(), ...extra });
  };
  function emitNav() { emit('nav-state', { canGoBack: view.webContents.canGoBack(), canGoForward: view.webContents.canGoForward() }); }
  view.webContents.on('page-title-updated', (e, t) => { emit('tab-updated', { title: t }); saveUserTabsPersist(); });
  view.webContents.on('did-navigate', (e, u) => { emit('tab-updated', { url: u }); emitNav(); addHistory(u, view.webContents.getTitle()); saveUserTabsPersist(); });
  view.webContents.on('did-navigate-in-page', (e, u) => { if (e.isMainFrame) { emit('tab-updated', { url: u }); emitNav(); addHistory(u, view.webContents.getTitle()); saveUserTabsPersist(); } });
  view.webContents.on('did-start-loading', () => emit('tab-loading', { loading: true }));
  view.webContents.on('did-stop-loading', () => { emit('tab-loading', { loading: false }); emitNav(); });
  view.webContents.on('update-target-url', (e, u) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-url', u || ''); });
  view.webContents.on('enter-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', true);
      view.setBounds({ x: 0, y: 0, width: mainWindow.getBounds().width, height: mainWindow.getBounds().height });
    }
  });
  view.webContents.on('leave-html-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('html-fullscreen', false);
      syncViews();
    }
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (splitMode && currentWorkspace === wsId) addTab(url);
    else addTab(url);
    return { action: 'deny' };
  });
  setupContextMenu(view.webContents);
  tabs.push({ id, view, url, title: '' });
  workspaceTabs[wsId] = tabs;
  setActiveId(wsId, id);
  return id;
}

// ── Browser IPC ──

ipcMain.handle('cleanup-tabs', () => {
  saveUserTabsPersist();
  Object.keys(workspaceTabs).forEach(wsId => {
    workspaceTabs[wsId].forEach(t => { try { mainWindow.contentView.removeChildView(t.view); } catch(e) {} });
  });
  workspaceTabs = {};
  activeIdPerWorkspace = {};
  idCounter = 0;
  currentWorkspace = null;
  splitMode = false; splitLeft = null; splitRight = null;
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  Menu.setApplicationMenu(null);
  return { ok: true };
});

ipcMain.on('clear-menu', () => Menu.setApplicationMenu(null));

ipcMain.on('enter-browser', () => {
  if (!getUser(currentUser)) return;
  ensureDefaultWs(currentUser);
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
ipcMain.on('resize-content', () => syncViews());
ipcMain.on('panel-toggle', (e, open) => { panelOpen = open; syncViews(); });
ipcMain.on('open-history', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('show-history'); });
ipcMain.handle('get-tabs', () => currentTabs().map(t => ({ id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })));

// ── Zoom (global) ──

ipcMain.on('zoom-in', () => {
  zoomLevel = Math.min(zoomLevel + 0.5, 5);
  currentTabs().forEach(t => t.view.webContents.setZoomLevel(zoomLevel));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zoom-changed', zoomLevel);
});
ipcMain.on('zoom-out', () => {
  zoomLevel = Math.max(zoomLevel - 0.5, -5);
  currentTabs().forEach(t => t.view.webContents.setZoomLevel(zoomLevel));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zoom-changed', zoomLevel);
});
ipcMain.on('zoom-reset', () => {
  zoomLevel = 0;
  currentTabs().forEach(t => t.view.webContents.setZoomLevel(0));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zoom-changed', 0);
});

// ── Find in Page ──

ipcMain.on('find-start', (e, text) => { const t = activeTab(); if (t && text) t.view.webContents.findInPage(text); });
ipcMain.on('find-next', (e, text) => { const t = activeTab(); if (t && text) t.view.webContents.findInPage(text, { findNext: true }); });
ipcMain.on('find-stop', () => { const t = activeTab(); if (t) t.view.webContents.stopFindInPage('clearSelection'); });

// ── Fullscreen ──

function setupF11Handler(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });
}

ipcMain.on('toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ── Home ──

ipcMain.on('go-home', () => { const t = activeTab(); if (t) t.view.webContents.loadURL('https://www.google.com'); });

// ── Idle ──

ipcMain.on('reset-idle', () => { if (currentUser) resetIdleTimer(); });

// ── Lifecycle ──

ipcMain.on('quit-app', () => app.quit());

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async () => {
  saveUserTabsPersist();
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData();
    if (currentWorkspace) {
      try { const ws = session.fromPartition('persist:ws_' + currentWorkspace); await ws.clearCache(); await ws.clearStorageData(); } catch(e) {}
    }
  } catch(e) {}
});

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}
