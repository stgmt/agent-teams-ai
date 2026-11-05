const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');

// This fixture has no application services, transport, team, or access to the user's profile.
app.setPath('userData', process.argv[2]);
app.setPath('sessionData', process.argv[2]);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL(pathToFileURL(process.argv[3]).href);
  try {
    const result = await window.webContents.executeJavaScript('window.composerStorageTest');
    process.stdout.write(`COMPOSER_RESULT=${JSON.stringify(result)}\n`);
    app.quit();
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    app.exit(1);
  }
});
