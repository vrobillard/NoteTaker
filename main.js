const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');

let mainWindow;
let isNoteTakerMode = true; // Initialize in NoteTaker Mode

// Constants for window sizes
const NOTE_TAKER_WIDTH = 500;
const NOTE_TAKER_HEIGHT = 520;

// Path to tray icon (can be used as window icon)
const WINDOW_ICON_PATH = path.join(__dirname, 'icon3.ico'); // Ensure this file exists

app.setAppUserModelId('com.yourcompany.NoteTaker');

function createWindow() {

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: displayWidth, height: displayHeight } = primaryDisplay.workAreaSize;

  // Define window dimensions based on mode
  const windowWidth = isNoteTakerMode ? NOTE_TAKER_WIDTH : displayWidth;
  const windowHeight = isNoteTakerMode ? NOTE_TAKER_HEIGHT : displayHeight;

  // Create the browser window with appropriate options
  mainWindow = new BrowserWindow({
    icon: WINDOW_ICON_PATH,
    width: windowWidth,
    height: windowHeight,
    x: Math.floor((primaryDisplay.bounds.width - windowWidth) / 2),
    y: Math.floor((primaryDisplay.bounds.height - windowHeight) / 2),
    show: false, // Initially hide the window
    autoHideMenuBar: true,
    resizable: true,
    alwaysOnTop: isNoteTakerMode,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Load the main HTML file
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Once the window is ready to show, display it
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Once the content is loaded, send the initial mode to renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('note-taker-mode-changed', isNoteTakerMode);
  });

  // Handle window closed event
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle window minimize event
  mainWindow.on('minimize', () => {
    // No tray functionality; simply minimize normally
    // Optionally, you can handle other behaviors here
  });

  // Handle window restore event
  mainWindow.on('restore', () => {
    if (!isNoteTakerMode) {
      mainWindow.maximize();
    }
    // If in NoteTaker Mode, no action needed as the window was hidden
  });
}

// Function to enable NoteTaker Mode
function enableNoteTakerMode() {
  isNoteTakerMode = true;

  // Set window size to NoteTaker dimensions
  mainWindow.setBounds({
    x: Math.floor((screen.getPrimaryDisplay().bounds.width - NOTE_TAKER_WIDTH) / 2),
    y: Math.floor((screen.getPrimaryDisplay().bounds.height - NOTE_TAKER_HEIGHT) / 2),
    width: NOTE_TAKER_WIDTH,
    height: NOTE_TAKER_HEIGHT,
  });

  mainWindow.setResizable(true);
  mainWindow.setAlwaysOnTop(true);

  // Notify renderer about mode change
  mainWindow.webContents.send('note-taker-mode-changed', isNoteTakerMode);
}

// Function to disable NoteTaker Mode (View All Notes)
function disableNoteTakerMode() {
  isNoteTakerMode = false;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  // Maximize the window to full screen
  mainWindow.setBounds({
    x: Math.floor((primaryDisplay.bounds.width - width) / 2),
    y: Math.floor((primaryDisplay.bounds.height - height) / 2),
    width: width,
    height: height,
  });

  mainWindow.setResizable(true);
  mainWindow.setAlwaysOnTop(false);

  // Notify renderer about mode change
  mainWindow.webContents.send('note-taker-mode-changed', isNoteTakerMode);
}

// Function to toggle between modes
function toggleNoteTakerMode() {
  if (isNoteTakerMode) {
    disableNoteTakerMode();
  } else {
    enableNoteTakerMode();
  }
}

app.whenReady().then(createWindow);

// IPC event to toggle note-taker mode
ipcMain.on('toggle-note-taker-mode', () => {
  toggleNoteTakerMode();
});



// IPC handler for showing confirmation dialog
ipcMain.handle('show-confirm-dialog', async (event, message) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Yes', 'No'],
    defaultId: 1,
    title: 'Confirm Action',
    message: message,
  });
  return result.response === 0; // Returns true if 'Yes' is clicked
});

// IPC handler for showing error dialogs
ipcMain.handle('show-error-dialog', async (event, message) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    buttons: ['OK'],
    title: 'Error',
    message: message,
  });
});

// macOS-specific behavior
app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Quit the app when all windows are closed on Windows/Linux
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

if (require('electron-squirrel-startup')) {
  const createShortcut = (shortcutPath, targetPath) => {
    const fs = require('fs');
    const path = require('path');
    const shell = require('child_process');

    // Create a shortcut if it doesn't already exist
    if (!fs.existsSync(shortcutPath)) {
      const iconPath = path.join(targetPath, 'icon3.ico');
      const cmd = `powershell.exe -Command "New-Object -ComObject WScript.Shell | Out-Null; $s=(New-Object -ComObject WScript.Shell).CreateShortcut('${shortcutPath}');$s.TargetPath='${targetPath}';$s.IconLocation='${iconPath}';$s.Save()"`;

      shell.exec(cmd, (error) => {
        if (error) {
          console.error('Failed to create desktop shortcut:', error);
        }
      });
    }
  };

  const appFolder = path.resolve(process.execPath, '..');
  const appExe = path.join(appFolder, 'NoteTaker.exe');
  const shortcutPath = path.join(process.env.USERPROFILE, 'Desktop', 'NoteTaker.lnk');

  createShortcut(shortcutPath, appExe);
  return;
}
