/*
 * Animated Background for Home Assistant dashboards
 * https://github.com/MrVess/ha-animated-background  —  MIT License
 *
 * Plays a video or image behind any Lovelace dashboard, optionally switching on an
 * entity's state. YAML config is compatible with the 2020 "lovelace-animated-background"
 * project by Villhellm, which inspired this rewrite for the current HA frontend:
 *   home-assistant > home-assistant-main > ha-drawer > partial-panel-resolver
 *     > ha-panel-lovelace > hui-root > hui-view-container#view > hui-view-background
 *
 * The background is a fixed <video>/<img> layer appended to hui-root's shadow root
 * at z-index:-1, and HA's own hui-view-background is hidden while it is active.
 */

const AB_VERSION = "1.0.0";
const AB_LOG = "Animated Background: ";
const AB_ID = "animated-background";

let Debug_Mode = false;
let Hass = null;

// render state
let Current_Root = null;     // hui-root element we rendered into
let Current_Key = null;      // "url|overlay" currently shown
let Previous_Entity = null;
let Previous_State = null;
let Previous_View = null;
let Previous_Config = null;
let Chosen_Url = null;       // keeps a random pick stable until state/view changes

const log = (msg, ...rest) => console.info(AB_LOG + msg, ...rest);
const debug = (msg, ...rest) => { if (Debug_Mode) console.debug(AB_LOG + "[debug] " + msg, ...rest); };

/* ---------------------------------------------------------------- DOM */

function findHuiRoot() {
  const ha = document.querySelector("home-assistant");
  const main = ha?.shadowRoot?.querySelector("home-assistant-main");
  const resolver = main?.shadowRoot?.querySelector("partial-panel-resolver");
  // ha-panel-lovelace for normal dashboards; other panels (e.g. ha-panel-home) also host hui-root
  const panel = resolver?.querySelector("ha-panel-lovelace") || resolver?.firstElementChild;
  return panel?.shadowRoot?.querySelector("hui-root") || null;
}

function getLovelace(root) {
  return root?.lovelace || null;
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

// Resolve which config block applies to the current view
function resolveConfig(rootCfg, lovelace) {
  if (!rootCfg) return null;
  let cfg = null;

  if (rootCfg.entity || rootCfg.default_url) cfg = rootCfg;

  const path = currentViewPath();
  for (const v of rootCfg.views || []) {
    if (String(v.path) === path) {
      if (v.config) cfg = v.config;
      else log("view '" + path + "' has no config block");
    }
  }

  const viewCfg = currentViewConfig(lovelace);
  if (viewCfg?.animated_background) {
    const g = getGroupConfig(rootCfg, viewCfg.animated_background);
    if (g) cfg = g;
  }
  return cfg;
}

const matchesDevice = (list) =>
  list.some((d) => navigator.userAgent.toLowerCase().includes(String(d).toLowerCase()));
const matchesUser = (list) => {
  const name = Hass?.user?.name?.toLowerCase();
  return !!name && list.map((u) => String(u).toLowerCase()).includes(name);
};

function applyFilters(cfg, enabled) {
  if (cfg.excluded_devices && matchesDevice(cfg.excluded_devices)) { debug("device excluded"); enabled = false; }
  if (cfg.excluded_users && matchesUser(cfg.excluded_users)) { debug("user excluded"); enabled = false; }
  if (cfg.included_users) enabled = matchesUser(cfg.included_users) ? true : (debug("user not included"), false);
  if (cfg.included_devices) enabled = matchesDevice(cfg.included_devices) ? true : (debug("device not included"), false);
  return enabled;
}

function isEnabled(rootCfg, cfg) {
  let enabled = applyFilters(rootCfg, true);
  if (cfg !== rootCfg) enabled = applyFilters(cfg, enabled);
  if (cfg.enabled === false) enabled = false;
  if (cfg.enabled === true) enabled = true;
  return enabled;
}

const pick = (url) => (Array.isArray(url) ? url[Math.floor(Math.random() * url.length)] : url);

// Returns the URL to show, or null for "use the normal theme background"
function resolveUrl(cfg) {
  const viewKey = currentViewPath();
  let raw = cfg.default_url;
  let stateKey = null;

  if (cfg.entity && cfg.state_url) {
    const st = entityState(cfg.entity);
    stateKey = cfg.entity + "=" + st;
    if (cfg.state_url[st] !== undefined) raw = cfg.state_url[st];
    else debug("no state_url for state '" + st + "', using default_url");
  }
  if (!raw || raw === "none") return null;

  // only re-roll a random choice when something meaningful changed
  const changed =
    cfg !== Previous_Config || viewKey !== Previous_View ||
    cfg.entity !== Previous_Entity || stateKey !== Previous_State;
  if (changed || !Chosen_Url || (Array.isArray(raw) ? !raw.includes(Chosen_Url) : raw !== Chosen_Url)) {
    if (stateKey !== Previous_State && cfg.entity) debug(cfg.entity + " is now " + entityState(cfg.entity));
    Chosen_Url = pick(raw);
  }
  Previous_Config = cfg;
  Previous_View = viewKey;
  Previous_Entity = cfg.entity;
  Previous_State = stateKey;
  return Chosen_Url;
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

function videoType(url) {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith(".mp4") || clean.endsWith(".m4v")) return "mp4";
  if (clean.endsWith(".webm")) return "webm";
  if (clean.endsWith(".mov")) return "quicktime";
  return null;
}

function removeBackground(root) {
  if (!root) return;
  root.removeAttribute("animated-background");
  root.shadowRoot?.getElementById(AB_ID)?.remove();
  root.shadowRoot?.getElementById(AB_ID + "-style")?.remove();
}

function render(root, url, overlay) {
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

  const type = videoType(url);
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
    const src = document.createElement("source");
    src.src = url;
    src.type = "video/" + type;
    media.appendChild(src);
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

  const rootCfg = getLovelace(root)?.config?.animated_background;
  Debug_Mode = !!rootCfg?.debug;

  let url = null;
  let overlay = null;
  if (rootCfg) {
    const cfg = resolveConfig(rootCfg, getLovelace(root));
    if (cfg && cfg.enabled !== false && isEnabled(rootCfg, cfg)) {
      url = resolveUrl(cfg);
      overlay = cfg.background ?? rootCfg.background ?? null;
      // the old "background: transparent" default is a no-op now
      if (overlay === "transparent") overlay = null;
    } else if (cfg?.reason) {
      debug("disabled: " + cfg.reason);
    }
  }

  const key = url ? url + "|" + (overlay || "") : null;
  const present = !!root.shadowRoot?.getElementById(AB_ID);
  if (key === Current_Key && root === Current_Root && present === !!key) return;

  if (!key) {
    removeBackground(root);
    debug("no background for this view, using theme");
  } else {
    debug("applying " + url);
    render(root, url, overlay);
  }
  Current_Root = root;
  Current_Key = key;
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
