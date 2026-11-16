const { SessionBus } = require("./dbus");

/**
 * Media keys (Fn+F6/F7/F8) go to whichever player was started or stopped LAST, Shuffull or anything else.
 *
 * WHY THIS EXISTS. Cinnamon's media-key daemon (csd-media-keys, read at cinnamon-settings-daemon 6.6.4,
 * plugins/media-keys/mpris-controller.c) sends the keys to the FIRST MPRIS player that appeared on the session
 * bus and keeps it until that player's bus name vanishes. It never looks at PlaybackStatus. So if YouTube in the
 * browser played before Shuffull, the keys drove YouTube until the browser was closed, whatever the user did
 * after that.
 *
 * HOW. The same daemon serves an older API first: an app that calls GrabMediaPlayerKeys gets every key as a
 * MediaPlayerKeyPressed signal, ahead of the MPRIS fallback (csd_media_player_key_pressed). We grab, then act as a
 * switchboard: we watch PlaybackStatus on every org.mpris.MediaPlayer2.* name and forward each key, as the MPRIS
 * method call, to the player that most recently changed state. Shuffull is just one of those players. Chromium
 * publishes its own MPRIS name for this window and turns those calls into the page's mediaSession handlers
 * (shims/trackPlayer.web.ts), so nothing in the renderer had to change.
 *
 * The grab lives as long as our bus connection, so quitting Shuffull hands the keys straight back to Cinnamon's
 * own rule. Without a session bus or the Cinnamon daemon (another desktop), this does nothing and Chromium's
 * MPRIS behaviour is untouched.
 */

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

// Cinnamon's daemon owns the GNOME name for this interface (csd-media-keys-manager.c, GSD_DBUS_NAME).
const MEDIA_KEYS_DEST = "org.gnome.SettingsDaemon";
const MEDIA_KEYS_PATH = "/org/gnome/SettingsDaemon/MediaKeys";
const MEDIA_KEYS_IFACE = "org.gnome.SettingsDaemon.MediaKeys";
const APP_ID = "Shuffull";

const BUS = { destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus" };

/** Key names csd sends -> the MPRIS method that does it. "Play" is the play/pause key, as in csd's own fallback. */
const KEY_METHODS = { Play: "PlayPause", Pause: "Pause", Stop: "Stop", Next: "Next", Previous: "Previous" };

/**
 * How long a new PlaybackStatus must hold before it counts as the user touching that player. A track change can
 * blip Playing -> Paused -> Playing; without this, a song ending in a background player would steal the keys.
 */
const SETTLE_MS = 600;

/**
 * Decides which player gets the next key. Pure, so it is tested without a bus: feed it what the bus reports,
 * ask `target(now)`.
 *
 * A player is TOUCHED when a status change settles to something other than what it was. Appearing already
 * Playing counts too: Firefox-based browsers only publish their MPRIS name once media starts, so a freshly opened
 * YouTube shows up Playing with no change ever reported.
 */
class MediaKeyRouter {
    constructor({ settleMs = SETTLE_MS, preferred = null } = {}) {
        this.settleMs = settleMs;
        // Used only before anything has been touched: our own window's player.
        this.preferred = preferred;
        this.players = new Map(); // name -> { settled, pending: { status, at } | null, touchedAt, seen }
    }

    appeared(name) {
        if (!this.players.has(name)) {
            this.players.set(name, { settled: null, pending: null, touchedAt: null, seen: false });
        }
    }

    vanished(name) {
        this.players.delete(name);
    }

    /** A PlaybackStatus change reported by the player. */
    observe(name, status, at) {
        const player = this.players.get(name);
        if (!player) {
            return;
        }
        this.settle(player, at);
        player.seen = true;
        player.pending = { status, at };
    }

    /** The status read when we first saw the player. Ignored if a change already arrived, which is newer. */
    observeInitial(name, status, at) {
        const player = this.players.get(name);
        if (player && !player.seen) {
            this.observe(name, status, at);
        }
    }

    settle(player, now) {
        const { pending } = player;
        if (!pending || now - pending.at < this.settleMs) {
            return;
        }
        const changed = player.settled === null ? pending.status === "Playing" : pending.status !== player.settled;
        if (changed) {
            player.touchedAt = pending.at;
        }
        player.settled = pending.status;
        player.pending = null;
    }

    /** The player the next key should go to, or null if there are none. */
    target(now) {
        let touched = null;
        let touchedAt = -Infinity;
        const playing = [];
        for (const [name, player] of this.players) {
            this.settle(player, now);
            if (player.touchedAt !== null && player.touchedAt > touchedAt) {
                touched = name;
                touchedAt = player.touchedAt;
            }
            if (player.settled === "Playing") {
                playing.push(name);
            }
        }
        if (touched) {
            return touched;
        }
        if (playing.length) {
            return playing.includes(this.preferred) ? this.preferred : playing[0];
        }
        if (this.players.has(this.preferred)) {
            return this.preferred;
        }
        return this.players.keys().next().value ?? null;
    }
}

/**
 * Connects, grabs the keys and starts routing. Resolves with `{ stop }`, or null where it can't apply (not Linux,
 * no session bus). Rejects if the bus or the grab fails; the caller logs that and carries on without it.
 */
async function startMediaKeyRouter({ log = console } = {}) {
    if (process.platform !== "linux" || !process.env.DBUS_SESSION_BUS_ADDRESS) {
        return null;
    }

    const bus = await SessionBus.connect();
    // Chromium names this window's player after the browser (main) process id.
    const router = new MediaKeyRouter({ preferred: `${MPRIS_PREFIX}chromium.instance${process.pid}` });
    // PropertiesChanged arrives from a unique name (":1.42"); this maps it back to the player names it owns.
    const ownerNames = new Map();

    const forget = (name) => {
        router.vanished(name);
        for (const names of ownerNames.values()) {
            names.delete(name);
        }
    };

    const track = async (name, owner) => {
        router.appeared(name);
        try {
            const unique = owner ?? (await bus.call({ ...BUS, member: "GetNameOwner", signature: "s", body: [name] }))[0];
            if (!ownerNames.has(unique)) {
                ownerNames.set(unique, new Set());
            }
            ownerNames.get(unique).add(name);
            const [status] = await bus.call({
                destination: name,
                path: MPRIS_PATH,
                iface: "org.freedesktop.DBus.Properties",
                member: "Get",
                signature: "ss",
                body: [PLAYER_IFACE, "PlaybackStatus"],
            });
            router.observeInitial(name, status, Date.now());
        } catch (err) {
            // A player that left mid-lookup, or one without PlaybackStatus. It still gets keys if touched later.
            log.warn?.(`[media-keys] couldn't read ${name}: ${err.message}`);
        }
    };

    const grab = () =>
        bus.call({
            destination: MEDIA_KEYS_DEST,
            path: MEDIA_KEYS_PATH,
            iface: MEDIA_KEYS_IFACE,
            member: "GrabMediaPlayerKeys",
            signature: "su",
            body: [APP_ID, 0], // 0 = "now"; the most recent grab wins
        });

    const press = (key) => {
        const method = KEY_METHODS[key];
        const target = router.target(Date.now());
        if (!method || !target) {
            return;
        }
        bus.call({ destination: target, path: MPRIS_PATH, iface: PLAYER_IFACE, member: method }).catch((err) =>
            log.warn?.(`[media-keys] ${method} on ${target} failed: ${err.message}`),
        );
    };

    bus.on("signal", (msg) => {
        if (msg.iface === "org.freedesktop.DBus" && msg.member === "NameOwnerChanged") {
            const [name, oldOwner, newOwner] = msg.body;
            if (name.startsWith(MPRIS_PREFIX)) {
                if (oldOwner) forget(name);
                if (newOwner) track(name, newOwner);
            } else if (name === MEDIA_KEYS_DEST && newOwner) {
                // Cinnamon restarted its daemon: the old grab died with it.
                grab().catch((err) => log.warn?.(`[media-keys] re-grab failed: ${err.message}`));
            }
        } else if (msg.iface === "org.freedesktop.DBus.Properties" && msg.member === "PropertiesChanged" && msg.path === MPRIS_PATH) {
            const [iface, changed] = msg.body;
            if (iface !== PLAYER_IFACE || typeof changed?.PlaybackStatus !== "string") {
                return;
            }
            for (const name of ownerNames.get(msg.sender) ?? []) {
                router.observe(name, changed.PlaybackStatus, Date.now());
            }
        } else if (msg.iface === MEDIA_KEYS_IFACE && msg.member === "MediaPlayerKeyPressed" && msg.path === MEDIA_KEYS_PATH) {
            const [app, key] = msg.body;
            if (app === APP_ID) {
                press(key);
            }
        }
    });
    bus.on("error", (err) => log.warn?.(`[media-keys] bus error: ${err.message}`));
    let stopping = false;
    bus.on("close", () => {
        if (!stopping) log.warn?.("[media-keys] bus connection closed; media keys are back to Cinnamon's default");
    });

    try {
        await bus.addMatch(`type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'`);
        await bus.addMatch(`type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${MEDIA_KEYS_DEST}'`);
        await bus.addMatch(`type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='${MPRIS_PATH}',arg0='${PLAYER_IFACE}'`);
        await bus.addMatch(`type='signal',interface='${MEDIA_KEYS_IFACE}',member='MediaPlayerKeyPressed'`);

        const [names] = await bus.call({ ...BUS, member: "ListNames" });
        await Promise.all(names.filter((n) => n.startsWith(MPRIS_PREFIX)).map((n) => track(n)));

        await grab();
    } catch (err) {
        stopping = true;
        bus.close();
        throw err;
    }

    log.log?.("[media-keys] routing media keys to the player used last");
    return {
        stop: () => {
            stopping = true;
            bus.close();
        },
    };
}

module.exports = { MediaKeyRouter, startMediaKeyRouter, KEY_METHODS, SETTLE_MS };
