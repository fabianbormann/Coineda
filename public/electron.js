const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');

function createWindow() {
  const image = nativeImage.createFromPath(
    path.join(__dirname, 'icons', 'icon.png')
  );

  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Coineda',
    icon: image,
    webPreferences: {
      devTools: isDev,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadURL(
    isDev
      ? 'http://localhost:3000'
      : `file://${path.join(__dirname, 'index.html')}`
  );
  mainWindow.maximize();
}

let server = null;

if (!isDev) {
  server = require('./server/index.js').server;
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
