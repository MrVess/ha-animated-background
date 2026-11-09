/*
 * Animated Background for Home Assistant dashboards
 * https://github.com/MrVess/ha-animated-background  —  MIT License
 *
 * Plays a video or image behind any Lovelace dashboard, optionally switching on an
 * entity's state. Configure it with the "Animated Background" card (visual editor,
 * pick or upload media from HA's Media library) or with YAML. The YAML format is
 * compatible with the 2020 "lovelace-animated-background" project by Villhellm,
 * which inspired this rewrite for the current HA frontend:
 *   home-assistant > home-assistant-main > ha-drawer > partial-panel-resolver
 *     > ha-panel-lovelace > hui-root > hui-view-container#view > hui-view-background
 *
 * The background is a fixed <video>/<img> layer appended to hui-root's shadow root
 * at z-index:-1, and HA's own hui-view-background is hidden while it is active.
 */

const AB_VERSION = "1.1.0";
const AB_LOG = "Animated Background: ";
const AB_ID = "animated-background";
const AB_CARD = "animated-background-card";
const AB_CARD_TYPE = "custom:" + AB_CARD;
const RESOLVE_TTL = 23 * 60 * 60 * 1000; // HA signs media URLs for 24h

let Debug_Mode = false;
let Hass = null;

// render state
let Current_Root = null;     // hui-root element we rendered into
let Current_Key = null;      // "src|overlay" currently shown
let Current_Resolved_At = 0; // when a media-source URL was signed
let Render_Token = 0;        // guards against out-of-order async resolves
let Previous_Entity = null;
let Previous_State = null;
let Previous_View = null;
let Previous_Config = null;
let Chosen_Src = null;       // keeps a random pick stable until state/view changes
const Resolved = new Map();  // media-source id -> { url, mime, at }

const log = (msg, ...rest) => console.info(AB_LOG + msg, ...rest);
const debug = (msg, ...rest) => { if (Debug_Mode) console.debug(AB_LOG + "[debug] " + msg, ...rest); };
const toArray = (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);

/* ---------------------------------------------------------------- DOM */

function findHuiRoot() {
  const ha = document.querySelector("home-assistant");
  const main = ha?.shadowRoot?.querySelector("home-assistant-main");
  const resolver = main?.shadowRoot?.querySelector("partial-panel-resolver");
  // ha-panel-lovelace for normal dashboards; other panels (e.g. ha-panel-home) also host hui-root
  const panel = resolver?.querySelector("ha-panel-lovelace") || resolver?.firstElementChild;
  return panel?.shadowRoot?.querySelector("hui-root") || null;
}

/* ------------------------------------------------------------- config */

function currentViewPath() {
  // /<dashboard>/<view>
  return decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
}

function currentViewConfig(lovelace) {
  const views = lovelace?.config?.views || [];
  const path = currentViewPath();
  let idx = views.findIndex((v) => v.path !== undefined && String(v.path) === path);
  if (idx === -1 && path !== "" && /^\d+$/.test(path)) idx = Number(path);
  if (idx === -1 && path === "") idx = 0;
  return views[idx] || null;
}

function getGroupConfig(root, name) {
  if (name === "none") return { enabled: false, reason: "view group is 'none'" };
  return (root.groups || []).find((g) => g.name === name)?.config || null;
}

function entityState(entity) {
  return Hass?.states?.[entity]?.state ?? null;
}

/* ---- card based config (set up in the UI) ---- */

function viewCards(view) {
  const cards = [...(view?.cards || [])];
  for (const s of view?.sections || []) cards.push(...(s.cards || []));
  return cards.filter((c) => c?.type === AB_CARD_TYPE);
}

// media picker values, media-source ids and plain URLs -> list of sources
function sources(media, url) {
  return [
    ...toArray(media).map((m) => (typeof m === "string" ? m : m?.media_content_id)),
    ...toArray(url),
  ].filter((s) => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
}

function cardToConfig(card) {
  const cfg = { default_url: sources(card.media, card.url), _card: true };
  if (card.entity) {
    cfg.entity = card.entity;
    cfg.state_url = {};
    for (const row of card.states || []) {
      if (row?.state === undefined || row.state === "") continue;
      const list = sources(row.media, row.url);
      cfg.state_url[String(row.state)] = list.length ? list : "none";
    }
  }
  if (Array.isArray(card.tint_color) && card.tint_opacity) {
    const [r, g, b] = card.tint_color;
    cfg.background = `rgba(${r}, ${g}, ${b}, ${Math.min(card.tint_opacity, 100) / 100})`;
  }
  for (const k of ["excluded_users", "included_users", "excluded_devices", "included_devices", "enabled"]) {
    if (card[k] !== undefined) cfg[k] = card[k];
  }
  return cfg;
}

// Priority: card on this view > YAML view/group > dashboard-wide card > YAML root
function resolveConfig(rootCfg, lovelace) {
  const view = currentViewConfig(lovelace);

  const viewCard = viewCards(view).find((c) => c.apply_to === "view");
  if (viewCard) return cardToConfig(viewCard);

  if (rootCfg) {
    const path = currentViewPath();
    for (const v of rootCfg.views || []) {
      if (String(v.path) === path) {
        if (v.config) return v.config;
        log("view '" + path + "' has no config block");
      }
    }
    if (view?.animated_background) {
      const g = getGroupConfig(rootCfg, view.animated_background);
      if (g) return g;
    }
  }

  for (const v of lovelace?.config?.views || []) {
    const dashCard = viewCards(v).find((c) => c.apply_to !== "view");
    if (dashCard) return cardToConfig(dashCard);
  }

  if (rootCfg && (rootCfg.entity || rootCfg.default_url)) return rootCfg;
  return null;
}

const matchesDevice = (list) =>
  toArray(list).some((d) => navigator.userAgent.toLowerCase().includes(String(d).toLowerCase()));
const matchesUser = (list) => {
  const name = Hass?.user?.name?.toLowerCase();
  return !!name && toArray(list).map((u) => String(u).toLowerCase()).includes(name);
};

function applyFilters(cfg, enabled) {
  if (cfg.excluded_devices && matchesDevice(cfg.excluded_devices)) { debug("device excluded"); enabled = false; }
  if (cfg.excluded_users && matchesUser(cfg.excluded_users)) { debug("user excluded"); enabled = false; }
  if (cfg.included_users) enabled = matchesUser(cfg.included_users) ? true : (debug("user not included"), false);
  if (cfg.included_devices) enabled = matchesDevice(cfg.included_devices) ? true : (debug("device not included"), false);
  return enabled;
}

function isEnabled(rootCfg, cfg) {
  let enabled = applyFilters(rootCfg || {}, true);
  if (cfg !== rootCfg) enabled = applyFilters(cfg, enabled);
  if (cfg.enabled === false) enabled = false;
  if (cfg.enabled === true) enabled = true;
  return enabled;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Returns the source to show (URL or media-source id), or null for "use the theme"
function resolveSource(cfg) {
  const viewKey = currentViewPath();
  let raw = cfg.default_url;
  let stateKey = null;

  if (cfg.entity && cfg.state_url) {
    const st = entityState(cfg.entity);
    stateKey = cfg.entity + "=" + st;
    if (cfg.state_url[st] !== undefined) raw = cfg.state_url[st];
    else debug("no state_url for state '" + st + "', using default_url");
  }
  if (raw === "none") return null;
  const list = toArray(raw).filter((s) => typeof s === "string" && s !== "");
  if (!list.length) return null;

  // only re-roll a random choice when something meaningful changed
  const changed =
    cfg !== Previous_Config || viewKey !== Previous_View ||
    cfg.entity !== Previous_Entity || stateKey !== Previous_State;
  if (changed || !list.includes(Chosen_Src)) {
    if (stateKey !== Previous_State && cfg.entity) debug(cfg.entity + " is now " + entityState(cfg.entity));
    Chosen_Src = pick(list);
  }
  Previous_Config = cfg;
  Previous_View = viewKey;
  Previous_Entity = cfg.entity;
  Previous_State = stateKey;
  return Chosen_Src;
}

/* ------------------------------------------------------------- media */

const isMediaSource = (src) => src.startsWith("media-source://");

// -> { url, mime } ; media-source ids are signed by HA and cached ~23h
async function resolveMedia(src) {
  if (!isMediaSource(src)) return { url: src, mime: null, at: 0 };
  const hit = Resolved.get(src);
  if (hit && Date.now() - hit.at < RESOLVE_TTL) return hit;
  const res = await Hass.callWS({ type: "media_source/resolve_media", media_content_id: src });
  const entry = { url: res.url, mime: res.mime_type || null, at: Date.now() };
  Resolved.set(src, entry);
  return entry;
}

function videoType(url, mime) {
  if (mime) return mime.startsWith("video/") ? mime : null;
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".mp4") || clean.endsWith(".m4v")) return "video/mp4";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".mov")) return "video/quicktime";
  return null;
}

/* ------------------------------------------------------------- render */

const STYLE = `
  #${AB_ID} {
    position: fixed;
    inset: 0;
    z-index: -1;
    overflow: hidden;
    pointer-events: none;
  }
  #${AB_ID} > video, #${AB_ID} > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  #${AB_ID} > .ab-overlay { position: absolute; inset: 0; }
  :host([animated-background]) hui-view-background { display: none; }
`;

function removeBackground(root) {
  if (!root) return;
  root.removeAttribute("animated-background");
  root.shadowRoot?.getElementById(AB_ID)?.remove();
  root.shadowRoot?.getElementById(AB_ID + "-style")?.remove();
}

function render(root, url, mime, overlay) {
  const sr = root.shadowRoot;
  if (!sr.getElementById(AB_ID + "-style")) {
    const style = document.createElement("style");
    style.id = AB_ID + "-style";
    style.textContent = STYLE;
    sr.appendChild(style);
  }
  let wrap = sr.getElementById(AB_ID);
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = AB_ID;
    sr.appendChild(wrap);
  }
  wrap.replaceChildren();

  const type = videoType(url, mime);
  let media;
  if (type) {
    media = document.createElement("video");
    // properties (not just attributes) are required for autoplay on mobile
    media.muted = true;
    media.defaultMuted = true;
    media.autoplay = true;
    media.loop = true;
    media.playsInline = true;
    media.setAttribute("muted", "");
    media.setAttribute("playsinline", "");
    const source = document.createElement("source");
    source.src = url;
    source.type = type;
    media.appendChild(source);
    media.play?.().catch(() => {});
  } else {
    media = document.createElement("img");
    media.src = url;
    media.alt = "";
  }
  wrap.appendChild(media);

  if (overlay) {
    const ov = document.createElement("div");
    ov.className = "ab-overlay";
    ov.style.background = overlay;
    wrap.appendChild(ov);
  }
  root.setAttribute("animated-background", "");
}

/* --------------------------------------------------------------- main */

function update() {
  const root = findHuiRoot();

  if (Current_Root && Current_Root !== root) {
    // dashboard switched or rebuilt; old root is gone or stale
    removeBackground(Current_Root);
    Current_Root = null;
    Current_Key = null;
  }
  if (!root || !Hass) return;

  const lovelace = root.lovelace;
  const rootCfg = lovelace?.config?.animated_background;
  Debug_Mode = !!rootCfg?.debug;

  let src = null;
  let overlay = null;
  const cfg = resolveConfig(rootCfg, lovelace);
  if (cfg && cfg.enabled !== false && isEnabled(rootCfg, cfg)) {
    src = resolveSource(cfg);
    overlay = cfg.background ?? (cfg._card ? null : rootCfg?.background) ?? null;
    // the old "background: transparent" default is a no-op now
    if (overlay === "transparent") overlay = null;
  } else if (cfg?.reason) {
    debug("disabled: " + cfg.reason);
  }

  const key = src ? src + "|" + (overlay || "") : null;
  const present = !!root.shadowRoot?.getElementById(AB_ID);
  const expired = src && isMediaSource(src) && Date.now() - Current_Resolved_At > RESOLVE_TTL;
  if (key === Current_Key && root === Current_Root && present === !!key && !expired) return;

  Current_Root = root;
  Current_Key = key;
  const token = ++Render_Token;

  if (!key) {
    removeBackground(root);
    debug("no background for this view, using theme");
    return;
  }
  resolveMedia(src).then(
    ({ url, mime, at }) => {
      if (token !== Render_Token) return; // something newer was requested meanwhile
      debug("applying " + url);
      Current_Resolved_At = at;
      render(root, url, mime, overlay);
    },
    (err) => {
      if (token !== Render_Token) return;
      console.warn(AB_LOG + "could not load " + src, err);
      removeBackground(root);
    }
  );
}

let Scheduled = false;
function schedule() {
  if (Scheduled) return;
  Scheduled = true;
  requestAnimationFrame(() => {
    Scheduled = false;
    try { update(); } catch (e) { console.error(AB_LOG, e); }
  });
}

/* ---------------------------------------------------------------- card */

// An invisible card that holds the settings, so they can be edited with HA's card editor.
// It only shows itself (as a small placeholder) while the dashboard is being edited.
class AnimatedBackgroundCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._paint();
    schedule();
  }

  set hass(hass) { this._hass = hass; }

  set preview(value) {
    this._preview = !!value;
    this._paint();
  }
  get preview() { return !!this._preview; }

  // older HA versions set editMode instead of preview
  set editMode(value) { this.preview = value; }

  connectedCallback() { this._paint(); }

  _paint() {
    const hide = !this._preview;
    if (this.hidden !== hide) {
      this.hidden = hide;
      this.dispatchEvent(new CustomEvent("card-visibility-changed", { detail: { value: !hide } }));
    }
    if (hide) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config || {};
    const n = sources(c.media, c.url).length;
    const states = (c.states || []).length;
    const scope = c.apply_to === "view" ? "this view" : "the whole dashboard";
    const what = [
      n ? n + " background" + (n > 1 ? "s (random)" : "") : "no default background",
      c.entity ? states + " state rule" + (states === 1 ? "" : "s") + " for " + c.entity : null,
    ].filter(Boolean).join(" · ");
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 16px; display: flex; gap: 12px; align-items: center; }
        .t { font-weight: 500; } .s { color: var(--secondary-text-color); font-size: 0.9em; }
      </style>
      <ha-card>
        <ha-icon icon="mdi:movie-open-play-outline"></ha-icon>
        <div><div class="t">Animated Background — ${scope}</div>
        <div class="s"></div>
        <div class="s">Hidden when you're not editing the dashboard.</div></div>
      </ha-card>`;
    this.shadowRoot.querySelectorAll(".s")[0].textContent = what;
  }

  getCardSize() { return 1; }
  getGridOptions() { return { columns: 12, rows: 1, min_rows: 1 }; }

  static getConfigElement() { return document.createElement(AB_CARD + "-editor"); }
  static getStubConfig() { return { apply_to: "dashboard" }; }
}

const MEDIA_SELECTOR = { media: { accept: ["video/*", "image/*"] } };

const EDITOR_SCHEMA = [
  {
    name: "apply_to",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "dashboard", label: "Whole dashboard (every view)" },
          { value: "view", label: "Only the view this card is on" },
        ],
      },
    },
  },
  { name: "media", selector: { media: { accept: ["video/*", "image/*"], multiple: true } } },
  { name: "url", selector: { text: { type: "url", multiple: true } } },
  { name: "entity", selector: { entity: {} } },
  {
    name: "states",
    selector: {
      object: {
        multiple: true,
        label_field: "state",
        fields: {
          state: { label: "When the entity's state is", required: true, selector: { text: {} } },
          media: { label: "Show this video or image", selector: MEDIA_SELECTOR },
          url: { label: "…or this URL", selector: { text: { type: "url" } } },
        },
      },
    },
  },
  {
    type: "expandable",
    name: "",
    title: "Tint",
    icon: "mdi:palette",
    schema: [
      { name: "tint_color", selector: { color_rgb: {} } },
      { name: "tint_opacity", selector: { number: { min: 0, max: 90, step: 5, mode: "slider", unit_of_measurement: "%" } } },
    ],
  },
];

const EDITOR_LABELS = {
  apply_to: "Apply to",
  media: "Videos or images (pick several to rotate randomly)",
  url: "URL",
  entity: "Change with an entity (optional)",
  states: "Backgrounds per state",
  tint_color: "Tint colour",
  tint_opacity: "Tint strength",
};

const EDITOR_HELPERS = {
  media: "Upload your own files in Media → My media, then pick them here.",
  url: "Or use a link instead: /local/backgrounds/rain.mp4 (a file in /config/www) or https://…",
  entity: "Weather, sun, an alarm, a media player… anything with a state.",
  states: "A state with no media uses the normal theme background. Other states use the default above.",
  tint_opacity: "Darkens or colours the background so cards stay readable.",
};

class AnimatedBackgroundCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  async connectedCallback() {
    // make sure HA's form components are loaded (they are lazy-loaded)
    if (!customElements.get("ha-form") && window.loadCardHelpers) {
      const helpers = await window.loadCardHelpers();
      const el = await helpers.createCardElement({ type: "entities", entities: [] });
      await el.constructor.getConfigElement?.();
    }
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] ?? s.name;
      this._form.computeHelper = (s) => EDITOR_HELPERS[s.name];
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const config = { ...ev.detail.value };
        for (const k of Object.keys(config)) {
          const v = config[k];
          if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete config[k];
        }
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = { apply_to: "dashboard", ...this._config };
    this._form.schema = EDITOR_SCHEMA;
  }
}

if (!customElements.get(AB_CARD)) customElements.define(AB_CARD, AnimatedBackgroundCard);
if (!customElements.get(AB_CARD + "-editor")) customElements.define(AB_CARD + "-editor", AnimatedBackgroundCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === AB_CARD)) {
  window.customCards.push({
    type: AB_CARD,
    name: "Animated Background",
    description: "Play your own video or image behind this dashboard, optionally changing with an entity's state.",
    preview: false,
    documentationURL: "https://github.com/MrVess/ha-animated-background",
  });
}

/* --------------------------------------------------------------- start */

async function start() {
  await customElements.whenDefined("home-assistant");
  const ha = document.querySelector("home-assistant");
  if (!ha) return;

  // subscribe to hass updates (state changes, user, etc.)
  ha.provideHass({
    set hass(value) {
      Hass = value;
      schedule();
    },
  });
  Hass = ha.hass || Hass;

  window.addEventListener("location-changed", schedule);
  window.addEventListener("popstate", schedule);
  // catches dashboard edits, view rebuilds and panel switches that fire no event
  setInterval(schedule, 1000);

  schedule();
  log("v" + AB_VERSION + " loaded");
}

start();
