const { app, BrowserWindow, protocol, net, session, globalShortcut, ipcMain, Notification } = require("electron");
const path = require("node:path");
const url = require("node:url");

/**
 * Global rating shortcuts.
 *
 * NO SUPER-BASED ACCELERATORS. This is the trap that made the first attempt (Super+Alt+…) silently do nothing:
 * under Cinnamon/Muffin on X11 the window manager owns the Super key, so it swallows Super chords before they
 * reach another client's passive grab. `globalShortcut.register` still returns TRUE — it only reports whether
 * XGrabKey succeeded, not whether the key will ever be delivered — so the failure looks exactly like a working
 * registration. Verified empirically: Super+Alt+J registered and never fired, while Control+Alt+J and
 * Alt+Shift+J both fired. An accelerator being unbound in gsettings is NOT evidence that it is deliverable.
 *
 * Alt+Shift keeps the letters mnemonic, which is the whole point: L=Like, H=Heart, D=Dislike, K=Keep,
 * N=Neutral. Ctrl+Alt would have been the more conventional space, but Ctrl+Alt+L is the screensaver here, and
 * losing L is what makes the set worth less than the chord it saves. Nothing is bound to Alt+Shift+<letter> on
 * this machine, and there is no Alt+Shift keyboard-layout toggle to fight (single US layout, no xkb-options).
 *
 * Known cost: Firefox triggers a page's accesskeys with Alt+Shift+<key>, so grabbing these five removes them
 * from web pages. Accepted deliberately - the letters are worth more here.
 *
 * H rather than Shift+L for Love, because Like and Love both start with L.
 *
 * All five were verified to actually FIRE (not merely register) by synthetic keypress before being adopted.
 */
const RATING_SHORTCUTS = [
    { accelerator: "Alt+Shift+L", action: "like" },
    { accelerator: "Alt+Shift+H", action: "love" },
    { accelerator: "Alt+Shift+D", action: "dislike" },
    { accelerator: "Alt+Shift+K", action: "keep" },
    { accelerator: "Alt+Shift+N", action: "neutral" },
];

/**
 * Desktop shell around the Expo web build (`dist/`, produced by `expo export --platform web`).
 *
 * Two things make this more than "open a folder in a browser":
 *
 * 1. It serves the build over a custom `app://` protocol rather than `file://`. OPFS — which expo-sqlite's
 *    web driver stores the database in — requires a SECURE CONTEXT, and `file://` is not one. A registered
 *    privileged scheme is, so the database works here exactly as it would on https.
 *
 * 2. It sets COOP/COEP. expo-sqlite's web build needs SharedArrayBuffer, which browsers only expose to
 *    cross-origin-isolated pages. In a browser those headers are viral and would block cross-origin audio
 *    and album art; here we own the whole origin, so we can grant isolation without that cost — one of the
 *    concrete reasons desktop is an easier target than the browser.
 */
const DIST = path.join(__dirname, "..", "dist");
const SCHEME = "app";

// Must be declared before `ready`. `standard` gives normal URL parsing, `secure` makes it a secure context
// (the part OPFS cares about), `supportFetchAPI` lets the wasm/worker assets be fetched.
protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 860,
        backgroundColor: "#000000",
        webPreferences: {
            // Nothing in the web bundle needs Node, and letting the renderer have it would be a liability.
            nodeIntegration: false,
            contextIsolation: true,
            // The single, deliberately narrow bridge: rating shortcuts in, notifications out. See preload.js.
            preload: path.join(__dirname, "preload.js"),
        },
    });

    // Renderer console -> terminal. Without this the web build's console output is only visible by opening
    // devtools by hand, which makes anything that fails on a timer (the 10s sync loop) practically invisible.
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        const tag = ["verbose", "info", "warning", "error"][level] ?? "info";
        console.log(`[renderer:${tag}] ${message}${sourceId ? ` (${sourceId}:${line})` : ""}`);
    });

    // SHUFFULL_DEVTOOLS=1 pnpm desktop:run — opens devtools for network/OPFS inspection.
    if (process.env.SHUFFULL_DEVTOOLS === "1") {
        win.webContents.openDevTools({ mode: "detach" });
    }

    // Load the SPA ROOT, not /index.html: expo-router treats the path as a route, and "/index.html"
    // matches nothing — you get its "Unmatched Route" screen instead of the app.
    win.loadURL(`${SCHEME}://local/`);
    return win;
}

app.whenReady().then(() => {
    // Cross-origin isolation, so SharedArrayBuffer (and therefore the SQLite web driver) is available.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                "Cross-Origin-Opener-Policy": ["same-origin"],
                "Cross-Origin-Embedder-Policy": ["require-corp"],
                // Our own assets must be embeddable under that isolation.
                "Cross-Origin-Resource-Policy": ["cross-origin"],
            },
        });
    });

    protocol.handle(SCHEME, (request) => {
        const { pathname } = new URL(request.url);
        // SPA: unknown paths are routes, not files — hand back index.html and let expo-router resolve them.
        const rel = pathname === "/" || !path.extname(pathname) ? "/index.html" : pathname;
        const filePath = path.join(DIST, decodeURIComponent(rel));

        // Never serve outside dist/, even if a request tries to walk up.
        if (!filePath.startsWith(DIST)) {
            return new Response("Forbidden", { status: 403 });
        }

        return net.fetch(url.pathToFileURL(filePath).toString());
    });

    const mainWindow = createWindow();

    // Notifications raised by the renderer after a shortcut lands. The shortcuts are GLOBAL, so the user is
    // normally looking at another window - without feedback a rating that silently failed is indistinguishable
    // from one that worked, which matters because a Like spends AI credit on audition songs.
    ipcMain.on("shuffull:notify", (_event, { title, body } = {}) => {
        if (!Notification.isSupported()) return;
        new Notification({ title: title || "Shuffull", body: body || "" }).show();
    });

    // Global rating shortcuts. register() returns false when something else already owns the combo; report
    // that rather than leaving a key that silently does nothing.
    for (const { accelerator, action } of RATING_SHORTCUTS) {
        const registered = globalShortcut.register(accelerator, () => {
            const target = BrowserWindow.getAllWindows()[0] ?? mainWindow;
            target?.webContents.send("shuffull:rating-shortcut", action);
        });

        if (!registered) {
            console.warn(`[shortcuts] ${accelerator} (${action}) is already taken by another application.`);
        }
    }

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Global shortcuts are process-wide OS grabs; releasing them on quit stops a crashed/closed instance holding
// Super+Alt+L hostage for every other app.
app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
