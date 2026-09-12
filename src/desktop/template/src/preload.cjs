const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('notes', {
  list:() => ipcRenderer.invoke('notes:list'),
  add:title => ipcRenderer.invoke('notes:add', title),
});
