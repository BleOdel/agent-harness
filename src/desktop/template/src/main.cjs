const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');
const store = require('./store.cjs');
app.whenReady().then(() => {
  const file = path.join(app.getPath('userData'), 'notes.json');
  // Serialize saves so double submissions cannot overwrite each other.
  let writes = Promise.resolve();
  ipcMain.handle('notes:list', () => store.load(file));
  ipcMain.handle('notes:add', (_, title) => {
    const next = writes.then(() => store.add(file, title));
    writes = next.catch(() => {});
    return next;
  });
  const window = new BrowserWindow({width:900, height:650, webPreferences:{
    preload:path.join(__dirname, 'preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true,
  }});
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
