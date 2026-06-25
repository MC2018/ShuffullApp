# Shuffull App — Redesign Plan

**Status:** Approved direction, foundation not yet built (planning phase).
**Chosen visual direction:** Aurora · Oxblood (`design/mockups/style-01c-oxblood.html`).
**Owner:** solo dev. **Last updated:** 2026-06-25.

This document is the source of truth for the app redesign: the locked decisions, the
design language, the concrete design tokens, the component/IA plan, the Genre Jam rework,
and the phased build order. Visual reference lives in `design/mockups/` (open `index.html`).

---

## 1. Goals

- Replace the current debug-grade UI (default RN components, inline styles, white
  backgrounds) with a cohesive, dark, music-forward design system.
- Make **Genre Jam** the headline feature instead of an unappealing pill-grid form.
- Establish a real **design-token + primitive-component foundation** before re-skinning
  screens, so the look is consistent and cheap to evolve.
- Keep the build **web-ready without paying for web yet** (see §9).

---

## 2. Locked decisions

| Area | Decision | Notes |
|------|----------|-------|
| Visual direction | **Aurora · Oxblood** | Neutral charcoal canvas, single deep-wine accent, flat/low-glow, album-art carries color. |
| Bottom nav | **Songs · Home · Library** (Home center) | Matches existing `app/(app)/(tabs)/_layout.tsx`; opens on Home. Jam is **not** a tab. |
| Genre Jam placement | A **card on Home** + a **Jams surface in Library** | Reachable without its own tab. |
| Web vs app | **Separate codebases, shared tokens** | App stays native/offline-first; the future website is its own API-consuming app. Share a framework-agnostic token layer (and later API types). See §9. |
| Styling engine | **Plain `StyleSheet` + a typed theme** | Zero new deps, full control, token-driven so we can swap engines later. No UI kit. |
| Component kit | **Build our own primitives** | A pre-styled kit (Paper/NativeBase/gluestack/Tamagui) would fight the bespoke look. |
| New dependencies for Phase 1 | **None** | Reuse installed: `@expo/vector-icons`, `react-native-reanimated`, `react-native-gesture-handler`, `@react-native-community/slider`, `react-native-safe-area-context`. |

---

## 3. Design language — "Aurora · Oxblood"

**Principles**
1. **Album art carries the color.** Chrome stays neutral charcoal; the accent is a single
   confident deep wine. The art is the most colorful thing on screen.
2. **Flat, low-glow, editorial.** No neon, no rainbow duotone gradients on UI chrome, no
   heavy drop-shadows. Depth comes from subtle surface tints and thin lines.
3. **Type does the work.** A clear hierarchy (screen title → section → body → label)
   instead of boxes and borders everywhere.
4. **Restrained motion.** Purposeful transitions (lyrics autoscroll, sheet open, jam
   launch) rather than decorative animation.

---

## 4. Design tokens

Tokens live in **`app/theme/tokens.ts`** as a **pure-TS object with no React Native
imports** (so the future web app can import the exact same values). Values below are taken
from the approved Oxblood mockup.

### 4.1 Color — surfaces

| Token | Value | Use |
|-------|-------|-----|
| `color.bg` | `#0d0b0c` | App canvas / screen background |
| `color.bgDeep` | `#0a0708` | Root / behind sheets and modals |
| `color.surface` | `rgba(255,245,246,0.05)` | Cards, list rows, pills |
| `color.surfaceAlt` | `rgba(255,245,246,0.09)` | Raised / active / pressed surfaces |
| `color.line` | `rgba(200,168,170,0.12)` | Borders, dividers |

### 4.2 Color — text

| Token | Value | Use |
|-------|-------|-----|
| `color.textPrimary` | `#f1eced` | Titles, primary content |
| `color.textMuted` | `#a59a9c` | Secondary text, artists, captions |
| `color.textFaint` | `#6b6063` | Tertiary / metadata / disabled |

### 4.3 Color — accent (oxblood) & states

| Token | Value | Use |
|-------|-------|-----|
| `color.accent` | `#c25b54` | Primary actions, active tab, "Love", play button |
| `color.accentDeep` | `#8f3b46` | Gradient partner, pressed accent |
| `color.accentTint` | `#e6b3ad` | Eyebrow/label text on dark, soft highlights |
| `color.accentWash` | `rgba(194,91,84,0.10)` | Subtle tinted card/CTA backgrounds, art "bleed" |
| `color.onAccent` | `#ffffff` *(verify, see note)* | Text/icon sitting on the accent fill |
| `color.positive` | `#6f9e7e` | "Downloaded / synced" indicators (optional) |
| `color.neutralFill` | `#2a2326` | **Dislike** active state (deliberately not red — accent is already red) |

> **Contrast note:** the mockup used near-black text (`#2a1012`) on the accent. Before
> shipping, verify WCAG contrast for `onAccent`; default to white text on `color.accent`
> unless the dark variant tests cleanly. **Dislike** uses a neutral fill, not red, to avoid
> red-on-red confusion with the wine accent (which represents Love/like).

### 4.4 Spacing, radius, elevation

```
space   = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 }
radius  = { sm: 8, md: 14, lg: 22, pill: 999 }
shadow  = { card: subtle, art: deep (album art), modal: deep }
```

### 4.5 Typography

Family: **system default** for now — only `SpaceMono` is currently bundled in
`assets/fonts`, so the type scale uses the platform system font (SF Pro / Roboto), which is
clean and music-app-appropriate. Inter (or another grotesk) can be added via `expo-font`
later as a polish step; tokens expose a single `font.family` so the swap is one line.

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| `type.display` | 30 | 800 | Rare oversized headers |
| `type.screenTitle` | 26 | 800 | Screen titles ("Library", greeting) |
| `type.title` | 20 | 800 | Now-Playing track title, card heads |
| `type.section` | 15 | 700 | Section headers |
| `type.body` | 14 | 500 | Body text |
| `type.bodyStrong` | 14 | 700 | Emphasized body / row titles |
| `type.label` | 12.5 | 600 | Buttons, pills |
| `type.caption` | 11 | 500 | Metadata, counts |
| `type.micro` | 10.5 | 600 | Uppercase tracking labels (`letter-spacing ~0.16em`) |

---

## 5. Component library (primitives)

Token-driven, built on `StyleSheet`, placed in the existing atomic-design folders. Icons
via `@expo/vector-icons` (replacing the hand-rolled SVGs in the mockups).

| Component | Responsibility |
|-----------|----------------|
| `Screen` | Safe-area wrapper + `color.bg`, consistent padding |
| `Text` | `variant` (type scale) + `color` props |
| `Button` | `variant`: primary / ghost / danger; sizes; icon slot |
| `IconButton` | Circular/rounded icon button (transport, etc.) |
| `Card` | Surface container w/ radius + optional tint |
| `Chip` / `Pill` | Selectable tag/filter/mood pill (idle / selected / excluded) |
| `ListRow` | Art + title + subtitle + trailing slot (library, songs, jams) |
| `AlbumArt` | Image w/ placeholder + static oxblood wash (art-tint later) |
| `SectionHeader` | Title + optional action link |
| `Divider` | Hairline using `color.line` |
| `TabBar` | Custom themed bottom bar (Songs · Home · Library) |
| `MiniPlayer` | Persistent now-playing bar above the tab bar (replaces `PlayerBar` styling) |
| `Slider` | Wraps `@react-native-community/slider` for skimmer + Energy |

---

## 6. Information architecture & navigation

```
(auth)/login
(app)
  (tabs)
    songs            — flat all-songs list
    home   [center]  — landing hub (resume, Start-a-Jam, saved jams)
      genre-jam      — the reworked Jam builder
    library
      index          — Playlists / Jams / Downloads
      playlist/[id]
      downloads
  now-playing        — full-screen player (art-bleed, lyrics, Like/Love/Dislike)
```

- Home opens by default. A persistent **MiniPlayer** sits above the tab bar on every tab;
  tapping it opens **now-playing**.

---

## 7. Screens

- **Home** — greeting → "Resume" current track → **Start a Jam** CTA card → "Your Jams"
  (saved jams) → recently played. Replaces the current debug button panel.
- **Now Playing** — large album art with a subtle oxblood wash, title/artist, skimmer,
  transport, **Like / Love / Dislike**, synced **LRC lyrics** (active line highlighted in
  accent, autoscroll), genre tags. *Pilot screen for the foundation.*
- **Library** — segmented **Playlists / Jams / Downloads**; rows via `ListRow`.
- **Songs** — flat all-songs list (kept as a tab per nav decision).

---

## 8. Genre Jam — reworked feature

**Concept.** A jam is an ad-hoc "jam playlist" over your whole library — no playlist
required. An **empty jam already means**: *all music, minus Disliked songs, with a slight
preference toward Loved tracks.* Filters only narrow it.

**Editor (replaces the pill-grid):**
1. Big **Start a Jam** button + a live pool estimate (e.g. "≈ 2,140 songs in this jam").
2. **Mood** chips (new dimension — see §10).
3. **Energy** slider (mellow → driving).
4. **Include / Exclude** rows for Genres, Artists, Decades, Languages (friendly add +
   include/exclude state, not a raw whitelist/blacklist grid).
5. **Save & name** the jam; saved jams resurface on Home and in Library → Jams.

**Data model.** Reuse the existing `genre_jam` table (`genreJamId`, `name`, `whitelists`,
`blacklists`). Additions needed:
- A **list query** for saved jams (currently only `addGenreJam` + `getGenreJam` exist).
- A **Mood** field once the Mood dimension lands (stubbed locally first).

**Selection algorithm (shuffle):** extends the existing `getFilteredSong` query —
- **Hard-exclude** `LikeStatus.Dislike` (already enforced).
- **Slight up-weight** for Liked / Loved (small multiplier, not a hard filter).
- **Recency anti-repeat** so the same songs don't recur too soon.

---

## 9. Web strategy

**Separate codebases, shared design tokens.** The app is offline-first and deeply native
(`react-native-track-player`, `expo-sqlite`/`drizzle`, `expo-file-system`,
`react-native-background-actions`, native Argon2) — none of which have a real web path. A
web version would be **online-only** and is best built as its own app (e.g. Next.js)
consuming the same API.

**Web-readiness rules (cheap insurance, do now):**
- Keep `app/theme/tokens.ts` **free of RN imports** so web can reuse it verbatim.
- Keep the API client + types in a clean module for later extraction.
- **Do not** build a monorepo or adopt React Native Web / Tamagui until the website
  actually starts. (`react-native-web` is already a dep and *renders*, but the native
  audio/storage/auth layers silently break — treat the `web` script as non-functional.)

---

## 10. Cross-repo dependencies

- **Mood dimension.** The Jam's Mood needs backend support: a new Mood tag type on the API
  (SITE) → sync → app schema (`TagType` + jam field). **Plan:** stub Mood locally in-app
  first so the redesign isn't blocked; wire the backend as a separate task.
- **BPM display.** Deferred until confirmed that BPM actually flows through the metadata
  pipeline to the app.

---

## 11. Build phases

### Phase 1 — Oxblood foundation (no behavior change)
- [ ] `app/theme/tokens.ts` (RN-free) + `app/theme/index.ts`
- [ ] `ThemeProvider` + `useTheme()`; apply global dark bg + status bar at root `_layout`
- [ ] Primitive components (§5), token-driven
- [ ] Swap hand-rolled SVGs → `@expo/vector-icons`
- [ ] **Pilot: re-skin Now Playing** end-to-end to validate the system

### Phase 2 — Re-skin remaining screens (logic untouched)
- [ ] Home → real landing (resume / Start-a-Jam / saved jams)
- [ ] Library (Playlists / Jams / Downloads) + Songs
- [ ] MiniPlayer + custom TabBar (Songs · Home · Library)

### Phase 3 — Genre Jam rework
- [ ] Empty-jam semantics + like-weighting + recency in `getFilteredSong`
- [ ] Saved-jams list query + Jams surface + relaunch
- [ ] New editor UI (Mood + Energy + Include/Exclude) replacing the pill-grid
- [ ] Mood stubbed in-app; backend Mood dimension as a follow-up task

### Phase 4 — Extras (deferred)
- [ ] BPM display (after confirming pipeline support)
- [ ] Motion polish; optional `@gorhom/bottom-sheet` Now Playing

---

## 12. Deferred backlog (pre-existing)

- Secure/rotate the plaintext OpenAI key in `Shuffull.Api/appsettings.Development.json`.
- Push the `Shuffull.Metadata` submodule (currently local-only).
- On-device end-to-end verification.

---

## 13. References

- Visual drafts: `design/mockups/index.html` (chooser) → `style-01c-oxblood.html` (chosen).
- Other explored directions kept for reference: `style-01-aurora`, `style-04-slate` (+ a/b/c),
  `style-05-velvet` (+ a/b/c), `style-02-nocturne`, `style-03-pulse`.
