const { app, BrowserWindow, protocol, net, session } = require("electron");
const path = require("node:path");
const url = require("node:url");

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
        },
    });

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

    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
