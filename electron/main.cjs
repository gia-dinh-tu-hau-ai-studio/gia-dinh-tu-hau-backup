const { app, BrowserWindow, shell, session } = require("electron");
const path = require("path");
const APP_URL = "https://giadinhtuhau.com/?desktop=1&appVersion=1.0.5&siteVersion=20260827-performance";
const SAFE_USER_AGENT = "GiaDinhTuHauDesktop/1.0.5";
const APP_PARTITION = "persist:gia-dinh-tu-hau";

async function refreshRemoteAppCache() {
  const appSession = session.fromPartition(APP_PARTITION);
  await Promise.all([
    appSession.clearCache(),
    appSession.clearStorageData({
      origin: "https://giadinhtuhau.com",
      storages: ["serviceworkers", "cachestorage"],
    }),
  ]);
}
function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: "#07543d", icon: path.join(__dirname, "..", "public", "logo.png"), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: APP_PARTITION },
  });
  // Keep the HTTP header ASCII-only. Vietnamese characters in Electron's app
  // name can otherwise make Supabase Auth reject session creation on Windows.
  window.webContents.setUserAgent(SAFE_USER_AGENT);
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://giadinhtuhau.com")) return { action: "allow" };
    shell.openExternal(url); return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("https://giadinhtuhau.com")) { event.preventDefault(); shell.openExternal(url); }
  });
  window.webContents.on("did-fail-load", (_event, errorCode, _description, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 && !validatedURL.endsWith("offline.html")) window.loadFile(path.join(__dirname, "offline.html"));
  });
  window.loadURL(APP_URL);
}
app.whenReady().then(async () => {
  await refreshRemoteAppCache();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });





