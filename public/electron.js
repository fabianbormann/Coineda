const { app, BrowserWindow } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');

console.log(path.join(__dirname, '..', 'build', 'icons', 'icon.png'));

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Coineda',
    webPreferences: {
      devTools: isDev,
    },
    icon: path.join(__dirname, '..', 'build', 'icons', 'icon.png'),
  });

  mainWindow.setMenu(null);
  mainWindow.loadURL(
    isDev
      ? 'http://localhost:3000'
      : `file://${path.join(__dirname, '../build/index.html')}`
  );
  mainWindow.maximize();
}

let server = null;

if (!isDev) {
  server = require('./server/app.js').server;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();

  if (!isDev) {
    server.close();
  }
});
