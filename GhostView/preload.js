const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ghost', {
  // Auth
  register: (p, pw) => ipcRenderer.invoke('register', p, pw),
  login: (p, pw) => ipcRenderer.invoke('login', p, pw),
  logout: () => ipcRenderer.invoke('logout'),
  enterBrowser: () => ipcRenderer.send('enter-browser'),
  clearMenu: () => ipcRenderer.send('clear-menu'),
  openSettings: () => ipcRenderer.send('open-settings'),
  openHistory: () => ipcRenderer.send('open-history'),
  changePassword: (oldPw, newPw) => ipcRenderer.invoke('change-password', oldPw, newPw),
  uploadPhoto: (base64) => ipcRenderer.invoke('upload-photo', base64),
  verifyPassword: (pw) => ipcRenderer.invoke('verify-password', pw),
  getUser: () => ipcRenderer.invoke('get-user'),
  getHistory: () => ipcRenderer.invoke('get-history'),

  // Workspaces
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  getActiveWorkspace: () => ipcRenderer.invoke('get-active-workspace'),
  createWorkspace: (name) => ipcRenderer.invoke('create-workspace', name),
  renameWorkspace: (id, name) => ipcRenderer.invoke('rename-workspace', id, name),
  deleteWorkspace: (id) => ipcRenderer.invoke('delete-workspace', id),
  selectWorkspace: (id) => ipcRenderer.invoke('select-workspace', id),
  switchWorkspace: (id) => ipcRenderer.invoke('switch-workspace', id),
  onWorkspaceSwitched: (cb) => ipcRenderer.on('workspace-switched', (e, d) => cb(d)),

  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  addBookmark: (url, title) => ipcRenderer.invoke('add-bookmark', url, title),
  removeBookmark: (url) => ipcRenderer.invoke('remove-bookmark', url),
  isBookmarked: (url) => ipcRenderer.invoke('is-bookmarked', url),

  // Browser
  navigate: (u) => ipcRenderer.send('navigate', u),
  navigateNewTab: (u) => ipcRenderer.send('navigate-new-tab', u),
  newTab: (u) => ipcRenderer.send('new-tab', u),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  activateTab: (id) => ipcRenderer.send('activate-tab', id),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  stop: () => ipcRenderer.send('stop'),
  resizeContent: () => ipcRenderer.send('resize-content'),
  panelToggle: (open) => ipcRenderer.send('panel-toggle', open),
  getTabs: () => ipcRenderer.invoke('get-tabs'),
  onTabUpdated: (cb) => ipcRenderer.on('tab-updated', (e, d) => cb(d)),
  onTabLoading: (cb) => ipcRenderer.on('tab-loading', (e, d) => cb(d)),
  onTabActivated: (cb) => ipcRenderer.on('tab-activated', (e, d) => cb(d)),
  onTabsList: (cb) => ipcRenderer.on('tabs-list', (e, d) => cb(d)),
  onStatusUrl: (cb) => ipcRenderer.on('status-url', (e, d) => cb(d)),
  onShowHistory: (cb) => ipcRenderer.on('show-history', () => cb()),
  onReturnToLogin: (cb) => ipcRenderer.on('return-to-login', () => cb()),
  onReturnToWorkspaces: (cb) => ipcRenderer.on('return-to-workspaces', () => cb()),
  cleanupTabs: () => ipcRenderer.invoke('cleanup-tabs'),
  onNavState: (cb) => ipcRenderer.on('nav-state', (e, d) => cb(d)),

  // Zoom
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  zoomReset: () => ipcRenderer.send('zoom-reset'),

  // Find
  findStart: (text) => ipcRenderer.send('find-start', text),
  findNext: (text) => ipcRenderer.send('find-next', text),
  findStop: () => ipcRenderer.send('find-stop'),

  // Fullscreen
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  onFullscreenChange: (cb) => ipcRenderer.on('fs-change', (e, d) => cb(d)),

  // Home
  goHome: () => ipcRenderer.send('go-home'),

  // Idle
  resetIdleTimer: () => ipcRenderer.send('reset-idle'),

  // Split View
  enterSplit: (wsId) => ipcRenderer.invoke('enter-split', wsId),
  exitSplit: () => ipcRenderer.invoke('exit-split'),
  focusSplitPane: (side) => ipcRenderer.invoke('focus-split-pane', side),
  onSplitChanged: (cb) => ipcRenderer.on('split-changed', (e, d) => cb(d)),

  // Downloads
  getDownloads: () => ipcRenderer.invoke('get-downloads'),
  getDownloadsHistory: () => ipcRenderer.invoke('get-downloads-history'),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onToggleDownloads: (cb) => ipcRenderer.on('toggle-downloads', () => cb()),
  toggleDownloads: () => ipcRenderer.send('toggle-downloads'),
  openDownloadFolder: (savePath) => ipcRenderer.invoke('open-download-folder', savePath),

  // Emergency
  loginGuest: () => ipcRenderer.invoke('login-guest'),
  quitApp: () => ipcRenderer.send('quit-app'),
});
