"use strict";

/* =========================================================================
   Emberpage — local storage layer (IndexedDB for content, localStorage for
   small synchronous UI settings), reading UI, and EPUB import.
   ========================================================================= */

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "emberpage-db";
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("no-indexeddb")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains("books")) {
        d.createObjectStore("books", { keyPath: "id" });
      }
      if (!d.objectStoreNames.contains("chapterMeta")) {
        const cs = d.createObjectStore("chapterMeta", { keyPath: "id" });
        cs.createIndex("bookId", "bookId", { unique: false });
      }
      if (!d.objectStoreNames.contains("chapterText")) {
        d.createObjectStore("chapterText", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function getAll(store) {
  const t = db.transaction([store]);
  return reqP(t.objectStore(store).getAll());
}
function getAllByIndex(store, indexName, key) {
  const t = db.transaction([store]);
  return reqP(t.objectStore(store).index(indexName).getAll(key));
}
function getOne(store, key) {
  const t = db.transaction([store]);
  return reqP(t.objectStore(store).get(key));
}
function putOne(store, val) {
  const t = db.transaction([store], "readwrite");
  t.objectStore(store).put(val);
  return txDone(t);
}
function deleteOne(store, key) {
  const t = db.transaction([store], "readwrite");
  t.objectStore(store).delete(key);
  return txDone(t);
}
function putBookAndChapters(book, metaArr, textArr) {
  const t = db.transaction(["books", "chapterMeta", "chapterText"], "readwrite");
  if (book) t.objectStore("books").put(book);
  const ms = t.objectStore("chapterMeta"), ts = t.objectStore("chapterText");
  metaArr.forEach((m) => ms.put(m));
  textArr.forEach((x) => ts.put(x));
  return txDone(t);
}
function deleteBookCascade(bookId) {
  return getAllByIndex("chapterMeta", "bookId", bookId).then((metas) => {
    const t = db.transaction(["books", "chapterMeta", "chapterText"], "readwrite");
    t.objectStore("books").delete(bookId);
    const ms = t.objectStore("chapterMeta"), ts = t.objectStore("chapterText");
    metas.forEach((m) => { ms.delete(m.id); ts.delete(m.id); });
    return txDone(t);
  });
}

/* ---------------- small sync settings (localStorage) ---------------- */
const LS_SETTINGS = "emberpage.settings.v1";
const LS_CURRENT = "emberpage.current.v1";
function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
}

const defaultSettings = {
  theme: null, font: "serif", size: 19, leading: 1.75, width: 66,
  sidebarOpen: true, focus: false, collapsedBooks: [], readMode: "scroll",
};
let settings = Object.assign({}, defaultSettings, loadJSON(LS_SETTINGS, {}));
if (!Array.isArray(settings.collapsedBooks)) settings.collapsedBooks = [];
let currentId = loadJSON(LS_CURRENT, null);
let lastBookTitle = "";

if (!settings.theme) {
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  settings.theme = prefersDark ? "dusk" : "paper";
}

/* ---------------- in-memory mirrors ---------------- */
let books = [];       // [{id, title, createdAt}]
let chapters = [];    // chapterMeta rows [{id,bookId,title,words,seq,addedAt,updatedAt,scrollPct,pagePct}]
let currentText = "";
let openToken = 0;

/* ---------------- DOM refs ---------------- */
const app = document.getElementById("app");
const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebarToggle");
const backdrop = document.getElementById("backdrop");
const chapterList = document.getElementById("chapterList");
const storageMeter = document.getElementById("storageMeter");
const addChapterBtn = document.getElementById("addChapterBtn");
const readerScroll = document.getElementById("readerScroll");
const readerInner = document.getElementById("readerInner");
const progressFill = document.getElementById("progressFill");
const dock = document.getElementById("dock");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const focusBtn = document.getElementById("focusBtn");
const modeBtn = document.getElementById("modeBtn");
const sizeVal = document.getElementById("sizeVal");
const themeGroup = document.getElementById("themeGroup");

const modalOverlay = document.getElementById("modalOverlay");
const modalCard = document.getElementById("modalCard");
const modalTitle = document.getElementById("modalTitle");
const titleInput = document.getElementById("chapterTitleInput");
const chapterBookInput = document.getElementById("chapterBookInput");
const bookDatalist = document.getElementById("bookDatalist");
const textInput = document.getElementById("chapterTextInput");
const modalWordCount = document.getElementById("modalWordCount");
const modalCancel = document.getElementById("modalCancel");
const modalSave = document.getElementById("modalSave");

const importEpubBtn = document.getElementById("importEpubBtn");
const epubFileInput = document.getElementById("epubFileInput");
const epubOverlay = document.getElementById("epubOverlay");
const epubBody = document.getElementById("epubBody");
const epubCancel = document.getElementById("epubCancel");
const epubImportBtn = document.getElementById("epubImportBtn");

const toastHost = document.getElementById("toastHost");

const flipStage = document.getElementById("flipStage");
const flipTrack = document.getElementById("flipTrack");
const flipZonePrev = document.getElementById("flipZonePrev");
const flipZoneNext = document.getElementById("flipZoneNext");
const flipPageNum = document.getElementById("flipPageNum");

const libraryToggle = document.getElementById("libraryToggle");
const libraryView = document.getElementById("libraryView");
const libraryGrid = document.getElementById("libraryGrid");
const libraryTag = document.getElementById("libraryTag");
const libraryCloseBtn = document.getElementById("libraryCloseBtn");

/* ---------------- utils ---------------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function wordsOf(text) { const m = text.trim().match(/\S+/g); return m ? m.length : 0; }
function readMinutes(words) { return Math.max(1, Math.round(words / 220)); }
function paragraphsHtml(text) {
  const norm = text.replace(/\r\n?/g, "\n").trim();
  let chunks = norm.split(/\n{2,}/);
  if (chunks.length < 2) chunks = norm.split(/\n/);
  return chunks.map((c) => c.trim()).filter(Boolean).map((c) => `<p>${esc(c)}</p>`).join("");
}
function uid(prefix) { return (prefix || "id") + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function showToast(msg, isError) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 3800);
}

/* ---------------- book helpers ---------------- */
function findBookByTitle(title) {
  const key = (title || "").trim().toLowerCase();
  if (!key) return null;
  return books.find((b) => b.title.trim().toLowerCase() === key) || null;
}
function getOrCreateBook(title) {
  const t = (title || "").trim();
  if (!t) return Promise.resolve(null);
  const existing = findBookByTitle(t);
  if (existing) return Promise.resolve(existing);
  const book = { id: uid("b"), title: t, createdAt: Date.now() };
  books.push(book);
  return putOne("books", book).then(() => book);
}
function nextSeq(bookId) {
  const key = bookId || null;
  let max = -1;
  chapters.forEach((c) => { if ((c.bookId || null) === key && c.seq > max) max = c.seq; });
  return max + 1;
}
function groupChapters() {
  const groups = [];
  books.forEach((b) => {
    const items = chapters.filter((c) => c.bookId === b.id).sort((a, z) => a.seq - z.seq);
    if (items.length) groups.push({ book: b, items });
  });
  const loose = chapters.filter((c) => !c.bookId).sort((a, z) => a.seq - z.seq);
  if (loose.length) groups.push({ book: null, items: loose });
  return groups;
}
function siblings(ch) {
  if (!ch) return chapters.slice().sort((a, z) => a.seq - z.seq);
  const key = ch.bookId || null;
  return chapters.filter((c) => (c.bookId || null) === key).sort((a, z) => a.seq - z.seq);
}
function refreshBookDatalist() {
  bookDatalist.innerHTML = books.map((b) => `<option value="${esc(b.title)}">`).join("");
}
function updateStorageMeter() {
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((est) => {
      const mb = (est.usage / 1048576).toFixed(1);
      const totalCh = chapters.length.toLocaleString();
      storageMeter.textContent = `${totalCh} chapters \u00B7 ${mb} MB on this device`;
    }).catch(() => {});
  } else {
    storageMeter.textContent = `${chapters.length.toLocaleString()} chapters`;
  }
}

/* ---------------- theme & typography ---------------- */
function applyTheme() {
  document.documentElement.setAttribute("data-reader-theme", settings.theme);
  themeGroup.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("on", b.dataset.theme === settings.theme));
  document.querySelector('meta[name="theme-color"]').setAttribute("content",
    getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#0A0A0C");
}
themeGroup.addEventListener("click", (e) => {
  const b = e.target.closest(".swatch");
  if (!b) return;
  settings.theme = b.dataset.theme;
  applyTheme();
  saveJSON(LS_SETTINGS, settings);
});
function applyTypography() {
  document.documentElement.style.setProperty("--reading-size", settings.size + "px");
  document.documentElement.style.setProperty("--reading-leading", settings.leading);
  document.documentElement.style.setProperty("--content-w", settings.width + "ch");
  document.documentElement.style.setProperty("--font-current", settings.font === "serif" ? "var(--font-body)" : "var(--font-body-alt)");
  sizeVal.textContent = settings.size;
  document.getElementById("fontSerifBtn").classList.toggle("on", settings.font === "serif");
  document.getElementById("fontSansBtn").classList.toggle("on", settings.font === "sans");
  if (settings.readMode === "flip") layoutFlip(true);
}
document.getElementById("fontSerifBtn").addEventListener("click", () => { settings.font = "serif"; applyTypography(); saveJSON(LS_SETTINGS, settings); });
document.getElementById("fontSansBtn").addEventListener("click", () => { settings.font = "sans"; applyTypography(); saveJSON(LS_SETTINGS, settings); });
document.getElementById("sizeMinus").addEventListener("click", () => { settings.size = Math.max(15, settings.size - 1); applyTypography(); saveJSON(LS_SETTINGS, settings); });
document.getElementById("sizePlus").addEventListener("click", () => { settings.size = Math.min(26, settings.size + 1); applyTypography(); saveJSON(LS_SETTINGS, settings); });
document.getElementById("leadMinus").addEventListener("click", () => { settings.leading = Math.max(1.4, +(settings.leading - 0.1).toFixed(2)); applyTypography(); saveJSON(LS_SETTINGS, settings); });
document.getElementById("leadPlus").addEventListener("click", () => { settings.leading = Math.min(2.2, +(settings.leading + 0.1).toFixed(2)); applyTypography(); saveJSON(LS_SETTINGS, settings); });
document.getElementById("widthMinus").addEventListener("click", () => { settings.width = Math.max(52, settings.width - 4); applyTypography(); saveJSON(LS_SETTINGS, settings); });
document.getElementById("widthPlus").addEventListener("click", () => { settings.width = Math.min(84, settings.width + 4); applyTypography(); saveJSON(LS_SETTINGS, settings); });

/* ---------------- sidebar open/close & focus mode ---------------- */
function isMobile() { return window.innerWidth <= 820; }
function syncSidebarClass() {
  app.classList.toggle("sidebar-open", !!settings.sidebarOpen);
  app.classList.toggle("is-mobile", isMobile());
}
function toggleSidebar() { settings.sidebarOpen = !settings.sidebarOpen; syncSidebarClass(); saveJSON(LS_SETTINGS, settings); }
sidebarToggle.addEventListener("click", toggleSidebar);
backdrop.addEventListener("click", () => { if (isMobile()) toggleSidebar(); });
window.addEventListener("resize", () => { syncSidebarClass(); if (settings.readMode === "flip") layoutFlip(); });

function applyFocus() {
  app.classList.toggle("focus-mode", !!settings.focus);
  focusBtn.classList.toggle("on", !!settings.focus);
}
function toggleFocus() { settings.focus = !settings.focus; applyFocus(); saveJSON(LS_SETTINGS, settings); }
focusBtn.addEventListener("click", toggleFocus);
readerScroll.addEventListener("click", (e) => { if (settings.focus && e.target === readerScroll) toggleFocus(); });

let dockIdleTimer;
function wakeDock() {
  dock.classList.remove("dimmed");
  if (app.classList.contains("focus-mode")) dock.classList.add("wake");
  clearTimeout(dockIdleTimer);
  dockIdleTimer = setTimeout(() => {
    dock.classList.add("dimmed");
    if (app.classList.contains("focus-mode")) dock.classList.remove("wake");
  }, 2600);
}
dock.addEventListener("mouseenter", () => { clearTimeout(dockIdleTimer); dock.classList.remove("dimmed"); });
dock.addEventListener("mouseleave", wakeDock);

/* ---------------- read mode (scroll vs flip/book) ---------------- */
function applyReadMode() {
  modeBtn.classList.toggle("on", settings.readMode === "flip");
  const ch = chapters.find((c) => c.id === currentId);
  if (!ch) return;
  if (settings.readMode === "flip") {
    readerScroll.hidden = true; flipStage.hidden = false;
    renderFlipChapter(ch, currentText);
  } else {
    flipStage.hidden = true; readerScroll.hidden = false;
    renderScrollChapter(ch, currentText);
  }
}
modeBtn.addEventListener("click", () => {
  settings.readMode = settings.readMode === "flip" ? "scroll" : "flip";
  saveJSON(LS_SETTINGS, settings);
  applyReadMode();
});

/* ---------------- sidebar rendering ---------------- */
function renderSidebar() {
  if (chapters.length === 0) {
    chapterList.innerHTML =
      '<div class="sidebar-empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1.4 2.5 3.4 3.8 3.4 6.9a3.4 3.4 0 1 1-6.8 0C8.6 6.8 10.6 5.5 12 3z"/><path d="M7 21h10"/><path d="M9 21c0-2 1.3-3.2 3-3.2s3 1.2 3 3.2"/></svg>' +
        "<p>No chapters yet.<br>Paste one in or import an EPUB.</p>" +
      "</div>";
    storageMeter.textContent = "";
    return;
  }
  const groups = groupChapters();
  const showHeaders = groups.length > 1;
  let html = "";
  groups.forEach((grp) => {
    const bookId = grp.book ? grp.book.id : "";
    const collapsed = showHeaders && settings.collapsedBooks.indexOf(bookId) !== -1;
    if (showHeaders) {
      html += `<div class="book-group${collapsed ? " collapsed" : ""}" data-book-id="${esc(bookId)}">` +
        `<div class="book-group-head" data-action="toggle-group" data-book-id="${esc(bookId)}">` +
          '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
          `<span class="book-group-title" data-action="rename-group" data-book-id="${esc(bookId)}">${esc(grp.book ? grp.book.title : "Loose chapters")}</span>` +
          `<span class="book-group-count">${grp.items.length}</span>` +
          (grp.book ? `<span class="book-group-actions"><button class="mini-btn" data-action="delete-group" data-book-id="${esc(bookId)}" title="Delete this shelf"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button></span>` : "") +
        "</div>";
    }
    if (!collapsed) {
      grp.items.forEach((c, i) => {
        const active = c.id === currentId;
        html += `<div class="chapter-row${active ? " active" : ""}" data-id="${c.id}" tabindex="0" role="button" aria-label="Open ${esc(c.title)}">` +
          `<span class="chapter-num">${i + 1}</span>` +
          `<span class="chapter-info"><span class="chapter-title">${esc(c.title)}</span>` +
            `<span class="chapter-meta">${c.words} words &middot; ${readMinutes(c.words)} min</span></span>` +
          '<span class="chapter-actions">' +
            '<button class="mini-btn" data-action="up" title="Move up" aria-label="Move chapter up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg></button>' +
            '<button class="mini-btn" data-action="down" title="Move down" aria-label="Move chapter down"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>' +
            '<button class="mini-btn" data-action="edit" title="Edit" aria-label="Edit chapter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
            '<button class="mini-btn" data-action="delete" title="Delete" aria-label="Delete chapter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button>' +
          "</span>" +
        "</div>";
      });
    }
    if (showHeaders) html += "</div>";
  });
  chapterList.innerHTML = html;
  updateStorageMeter();
}

/* ---------------- reader rendering: scroll mode ---------------- */
function renderEmptyMain() {
  readerInner.innerHTML =
    '<div class="empty-hero">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 2.5c1.7 3 4 4.7 4 8.4a4 4 0 1 1-8 0c0-1 .3-1.8.8-2.6"/>' +
        '<path d="M9 21h6"/><path d="M10 21c0-2.3 1-3.6 2-3.6s2 1.3 2 3.6"/>' +
      "</svg>" +
      "<h1>Your reading nook is empty</h1>" +
      "<p>Emberpage holds only what you bring to it. Paste in a chapter, or import EPUB files &mdash; select several volumes of the same book at once and they'll land on one shelf, in order.</p>" +
      '<div class="hero-actions"><button class="btn accent" id="emptyAddBtn" type="button">Add a chapter</button><button class="btn ghost" id="emptyImportBtn" type="button">Import EPUB</button></div>' +
    "</div>";
  const b = document.getElementById("emptyAddBtn");
  const ib = document.getElementById("emptyImportBtn");
  if (b) b.addEventListener("click", () => openModal("add"));
  if (ib) ib.addEventListener("click", () => epubFileInput.click());
  progressFill.style.width = "0%";
}
function renderScrollChapter(ch, text) {
  const sibs = siblings(ch);
  const idx = sibs.findIndex((c) => c.id === ch.id);
  const book = ch.bookId ? books.find((b) => b.id === ch.bookId) : null;
  const eyebrow = (book ? esc(book.title) + " &middot; " : "") + "Chapter " + (idx + 1) + " of " + sibs.length;
  readerInner.innerHTML =
    '<div class="chapter-head">' +
      `<p class="chapter-eyebrow">${eyebrow}</p>` +
      `<h1>${esc(ch.title)}</h1>` +
      `<div class="chapter-submeta"><span>${ch.words} words</span><span>${readMinutes(ch.words)} min read</span></div>` +
    "</div>" +
    `<article class="chapter-body">${paragraphsHtml(text)}</article>` +
    '<div class="chapter-foot">' +
      `<button class="btn ghost" id="footPrev" type="button"${idx <= 0 ? " disabled" : ""}>&larr; Previous</button>` +
      `<button class="btn ghost" id="footNext" type="button"${idx >= sibs.length - 1 ? " disabled" : ""}>Next &rarr;</button>` +
    "</div>";
  const fp = document.getElementById("footPrev"), fn = document.getElementById("footNext");
  if (fp) fp.addEventListener("click", () => goRelative(-1));
  if (fn) fn.addEventListener("click", () => goRelative(1));
  updateNav();
  requestAnimationFrame(() => {
    const max = readerScroll.scrollHeight - readerScroll.clientHeight;
    readerScroll.scrollTop = Math.max(0, (ch.scrollPct || 0) * max);
    onReaderScroll();
  });
}
function updateNav() {
  const ch = chapters.find((c) => c.id === currentId);
  const sibs = siblings(ch);
  const idx = sibs.findIndex((c) => c.id === currentId);
  if (settings.readMode === "flip") {
    prevBtn.disabled = idx <= 0 && flipState.currentSpread <= 0;
    nextBtn.disabled = idx < 0 || (idx >= sibs.length - 1 && flipState.currentSpread >= flipState.totalSpreads - 1);
  } else {
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= sibs.length - 1;
  }
}
let scrollSaveTimer;
function onReaderScroll() {
  const max = readerScroll.scrollHeight - readerScroll.clientHeight;
  const pct = max > 0 ? Math.min(1, Math.max(0, readerScroll.scrollTop / max)) : 0;
  progressFill.style.width = (pct * 100).toFixed(2) + "%";
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    const ch = chapters.find((c) => c.id === currentId);
    if (ch) { ch.scrollPct = pct; putOne("chapterMeta", ch); }
  }, 400);
}
readerScroll.addEventListener("scroll", onReaderScroll, { passive: true });

/* ---------------- reader rendering: flip / book mode ---------------- */
const flipState = { pagesPerView: 1, pageW: 0, gutter: 0, colStride: 0, spreadStride: 0, totalPages: 0, totalSpreads: 0, currentSpread: 0 };
const flipWindow = document.createElement("div");
flipWindow.id = "flipWindow";
flipTrack.parentNode.insertBefore(flipWindow, flipTrack);
flipWindow.appendChild(flipTrack);
const flipSpine = document.createElement("div");
flipSpine.id = "flipSpine";
flipWindow.appendChild(flipSpine);

function renderFlipChapter(ch, text, landLast) {
  const sibs = siblings(ch);
  const idx = sibs.findIndex((c) => c.id === ch.id);
  const book = ch.bookId ? books.find((b) => b.id === ch.bookId) : null;
  const eyebrow = (book ? esc(book.title) + " &middot; " : "") + "Chapter " + (idx + 1) + " of " + sibs.length;
  flipTrack.innerHTML =
    '<div class="flip-page-pad">' +
    `<div class="flip-chap-head"><p class="chapter-eyebrow">${eyebrow}</p><h1>${esc(ch.title)}</h1></div>` +
    paragraphsHtml(text) +
    "</div>";
  requestAnimationFrame(() => {
    layoutFlip(false, landLast ? "last" : (ch.pagePct || 0));
    updateNav();
  });
}
let flipLayoutTimer;
function layoutFlip(keepSpread, landAt) {
  const rect = flipStage.getBoundingClientRect();
  if (rect.width < 10) return;
  const sidePad = isMobile() ? 16 : 44;
  const availW = rect.width - sidePad * 2;
  const pagesPerView = availW >= 900 ? 2 : 1;
  // No column gap: pages sit flush so the spine pivot for the page-turn lands
  // exactly on the page edge. The visual spine gap comes from .flip-page-pad
  // padding plus the #flipSpine shadow.
  const gutter = 0;
  let pageW = pagesPerView === 2 ? Math.floor(Math.min(availW, 1360) / 2) : Math.min(availW, 720);
  pageW = Math.max(240, pageW);
  const pageH = rect.height - 44;

  const prevSpreadPct = flipState.totalSpreads > 1 ? flipState.currentSpread / (flipState.totalSpreads - 1) : 0;

  flipState.pagesPerView = pagesPerView;
  flipState.pageW = pageW;
  flipState.pageH = pageH;
  flipState.gutter = gutter;
  flipState.colStride = pageW + gutter;
  flipState.spreadStride = pagesPerView * flipState.colStride;

  flipWindow.style.width = (pagesPerView * pageW) + "px";
  flipWindow.style.height = pageH + "px";
  flipSpine.style.display = pagesPerView === 2 ? "block" : "none";
  flipTrack.style.columnWidth = pageW + "px";
  flipTrack.style.columnGap = gutter + "px";
  flipTrack.style.height = pageH + "px";

  flipState.totalPages = Math.max(1, Math.round((flipTrack.scrollWidth + gutter) / flipState.colStride));
  flipState.totalSpreads = Math.max(1, Math.ceil(flipState.totalPages / pagesPerView));

  let target;
  if (landAt === "last") target = flipState.totalSpreads - 1;
  else if (typeof landAt === "number") target = Math.round(landAt * (flipState.totalSpreads - 1));
  else target = keepSpread ? Math.round(prevSpreadPct * (flipState.totalSpreads - 1)) : flipState.currentSpread;
  goToFlipSpread(target, true);
}
window.addEventListener("resize", () => {
  if (settings.readMode !== "flip" || flipStage.hidden) return;
  clearTimeout(flipLayoutTimer);
  flipLayoutTimer = setTimeout(() => layoutFlip(true), 150);
});
function goToFlipSpread(n, instant) {
  flipState.currentSpread = Math.max(0, Math.min(flipState.totalSpreads - 1, n || 0));
  const x = -flipState.currentSpread * flipState.spreadStride;
  if (instant) {
    flipTrack.style.transition = "none";
    flipTrack.style.transform = `translateX(${x}px)`;
    void flipTrack.offsetWidth;
    flipTrack.style.transition = "";
  } else {
    flipWindow.classList.add("turning");
    flipTrack.style.transform = `translateX(${x}px)`;
    setTimeout(() => flipWindow.classList.remove("turning"), 420);
  }
  const firstPage = flipState.currentSpread * flipState.pagesPerView;
  flipPageNum.textContent = flipState.pagesPerView === 2
    ? `Pages ${firstPage + 1}–${Math.min(firstPage + 2, flipState.totalPages)} of ${flipState.totalPages}`
    : `Page ${firstPage + 1} of ${flipState.totalPages}`;
  const pct = flipState.totalSpreads > 1 ? flipState.currentSpread / (flipState.totalSpreads - 1) : 0;
  progressFill.style.width = (pct * 100).toFixed(2) + "%";
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    const ch = chapters.find((c) => c.id === currentId);
    if (ch) { ch.pagePct = pct; putOne("chapterMeta", ch); }
  }, 400);
  updateNav();
}
/* ---- page-turn animation: a leaf that rotates around the spine ---- */
const FLIP_MS = 620;
const flipLeaf = document.createElement("div");
flipLeaf.id = "flipLeaf";
flipLeaf.innerHTML =
  '<div class="leaf-face leaf-front"><div class="leaf-inner"></div><div class="leaf-shade"></div></div>' +
  '<div class="leaf-face leaf-back"><div class="leaf-inner"></div><div class="leaf-shade"></div></div>';
flipStage.appendChild(flipLeaf);
const leafFrontInner = flipLeaf.querySelector(".leaf-front .leaf-inner");
const leafBackInner = flipLeaf.querySelector(".leaf-back .leaf-inner");
const leafFrontShade = flipLeaf.querySelector(".leaf-front .leaf-shade");
const leafBackShade = flipLeaf.querySelector(".leaf-back .leaf-shade");
let leafTimer = null;
let leafAnims = [];

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function fillLeafFace(container, pageIndex) {
  container.innerHTML = "";
  const clone = flipTrack.cloneNode(true);
  clone.removeAttribute("id");
  clone.style.transition = "none";
  clone.style.transform = `translateX(${-pageIndex * flipState.colStride}px)`;
  container.appendChild(clone);
}
function endLeaf() {
  clearTimeout(leafTimer);
  leafTimer = null;
  leafAnims.forEach((a) => { try { a.cancel(); } catch (e) {} });
  leafAnims = [];
  flipLeaf.classList.remove("animating");
  leafFrontInner.innerHTML = "";
  leafBackInner.innerHTML = "";
}
function runPageTurn(dir, frontPage, backPage) {
  if (leafTimer) endLeaf();
  const winRect = flipWindow.getBoundingClientRect();
  const stageRect = flipStage.getBoundingClientRect();
  const x = (winRect.left - stageRect.left) + flipWindow.clientLeft + (flipState.pagesPerView - 1) * flipState.pageW;
  const y = (winRect.top - stageRect.top) + flipWindow.clientTop;

  flipLeaf.style.left = x + "px";
  flipLeaf.style.top = y + "px";
  flipLeaf.style.width = flipState.pageW + "px";
  flipLeaf.style.height = flipState.pageH + "px";
  fillLeafFace(leafFrontInner, frontPage);
  // In spread mode the leaf lands exactly on the facing page, so its back shows
  // that page's text. In single-page mode it swings out past the book's edge, so
  // the back stays blank paper - a page turning over, not text floating offscreen.
  if (flipState.pagesPerView === 2) fillLeafFace(leafBackInner, backPage);
  else leafBackInner.innerHTML = "";

  const startDeg = dir > 0 ? 0 : -180;
  const endDeg = dir > 0 ? -180 : 0;
  flipLeaf.classList.add("animating");

  // Web Animations API rather than CSS transitions: no start/reflow staging to get
  // wrong, and it still resolves correctly if the tab is backgrounded mid-turn.
  const ease = "cubic-bezier(.42,.02,.28,1)";
  const opts = { duration: FLIP_MS, easing: ease, fill: "forwards" };
  leafAnims = [
    flipLeaf.animate([{ transform: `rotateY(${startDeg}deg)` }, { transform: `rotateY(${endDeg}deg)` }], opts),
    leafFrontShade.animate([{ opacity: dir > 0 ? 0 : 0.5 }, { opacity: dir > 0 ? 0.5 : 0 }], opts),
    leafBackShade.animate([{ opacity: dir > 0 ? 0.5 : 0 }, { opacity: dir > 0 ? 0 : 0.5 }], opts),
  ];
  leafAnims[0].finished.then(endLeaf).catch(() => {});
  leafTimer = setTimeout(endLeaf, FLIP_MS + 120);
}
function nextFlipPage() {
  if (flipState.currentSpread < flipState.totalSpreads - 1) {
    const to = flipState.currentSpread + 1;
    if (reducedMotion()) { goToFlipSpread(to); return; }
    const ppv = flipState.pagesPerView;
    const frontPage = flipState.currentSpread * ppv + (ppv - 1);
    runPageTurn(1, frontPage, frontPage + 1);
    goToFlipSpread(to, true);
    return;
  }
  goRelative(1);
}
function prevFlipPage() {
  if (flipState.currentSpread > 0) {
    const to = flipState.currentSpread - 1;
    if (reducedMotion()) { goToFlipSpread(to); return; }
    const ppv = flipState.pagesPerView;
    const frontPage = to * ppv + (ppv - 1);
    runPageTurn(-1, frontPage, frontPage + 1);
    goToFlipSpread(to, true);
    return;
  }
  goRelative(-1, true);
}
flipZoneNext.addEventListener("click", nextFlipPage);
flipZonePrev.addEventListener("click", prevFlipPage);
let touchStartX = null;
flipStage.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
flipStage.addEventListener("touchend", (e) => {
  if (touchStartX == null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  touchStartX = null;
  if (Math.abs(dx) < 40) return;
  if (dx < 0) nextFlipPage(); else prevFlipPage();
}, { passive: true });

/* ---------------- library / home view ---------------- */
function bookProgress(book) {
  const items = chapters.filter((c) => c.bookId === book.id);
  const total = items.length;
  if (!total) return { total: 0, readCount: 0, pct: 0 };
  const readCount = book.furthestSeq == null ? 0 : items.filter((c) => c.seq <= book.furthestSeq).length;
  return { total, readCount, pct: Math.round((readCount / total) * 100) };
}
function openLibrary() {
  libraryView.hidden = false;
  readerScroll.hidden = true;
  flipStage.hidden = true;
  progressFill.style.width = "0%";
  renderLibrary();
}
function closeLibrary() {
  libraryView.hidden = true;
  if (chapters.some((c) => c.id === currentId)) applyReadMode();
  else { readerScroll.hidden = false; flipStage.hidden = true; renderEmptyMain(); }
}
libraryToggle.addEventListener("click", () => { libraryView.hidden ? openLibrary() : closeLibrary(); });
libraryCloseBtn.addEventListener("click", closeLibrary);

function renderLibrary() {
  const n = books.length;
  const dot = "\u00B7";
  libraryTag.textContent = n ? `${n} ${n === 1 ? "shelf" : "shelves"} ${dot} ${chapters.length.toLocaleString()} chapters total` : "Nothing here yet";
  let html = "";
  books.slice().sort((a, b) => (b.lastOpenedRank || 0) - (a.lastOpenedRank || 0) || a.title.localeCompare(b.title)).forEach((book) => {
    const prog = bookProgress(book);
    const statusText = prog.total === 0 ? "No chapters" : prog.readCount === 0 ? `${prog.total} chapters &middot; not started` : `Chapter ${prog.readCount} of ${prog.total} &middot; ${prog.pct}% read`;
    html += `<div class="book-card" data-book-id="${esc(book.id)}" tabindex="0" role="button" aria-label="Open ${esc(book.title)}">` +
      `<span class="book-card-actions">` +
        `<button class="mini-btn" data-action="rename" data-book-id="${esc(book.id)}" title="Rename"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>` +
        `<button class="mini-btn" data-action="delete" data-book-id="${esc(book.id)}" title="Delete this shelf"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button>` +
      `</span>` +
      `<div class="book-card-title">${esc(book.title)}</div>` +
      `<div class="book-card-status">${statusText}</div>` +
      `<div class="book-card-progress"><div class="fill" style="width:${prog.pct}%"></div></div>` +
      `<div class="book-card-foot"><span>${prog.pct}%</span></div>` +
    `</div>`;
  });
  html += '<div class="book-card add-card" id="libraryAddCard" tabindex="0" role="button" aria-label="Add a book">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' +
    '<span>Add a chapter or import an EPUB</span>' +
  '</div>';
  libraryGrid.innerHTML = html;
  const addCard = document.getElementById("libraryAddCard");
  addCard.addEventListener("click", () => epubFileInput.click());
}
const libraryDeleteArm = {};
libraryGrid.addEventListener("click", (e) => {
  const actionBtn = e.target.closest("[data-action]");
  if (actionBtn) {
    e.stopPropagation();
    const bookId = actionBtn.dataset.bookId;
    const action = actionBtn.dataset.action;
    if (action === "rename") {
      const book = books.find((b) => b.id === bookId);
      const val = prompt("Rename shelf", book ? book.title : "");
      if (val && val.trim() && book) { book.title = val.trim(); putOne("books", book).then(() => { renderLibrary(); renderSidebar(); }); }
      return;
    }
    if (action === "delete") {
      if (libraryDeleteArm[bookId]) {
        clearTimeout(libraryDeleteArm[bookId]);
        delete libraryDeleteArm[bookId];
        deleteBookCascade(bookId).then(() => {
          const removedIds = chapters.filter((c) => c.bookId === bookId).map((c) => c.id);
          chapters = chapters.filter((c) => c.bookId !== bookId);
          books = books.filter((b) => b.id !== bookId);
          if (removedIds.indexOf(currentId) !== -1) {
            currentId = null;
            saveJSON(LS_CURRENT, null);
            if (chapters.length) openChapter(chapters[0].id).then(() => { libraryView.hidden = false; renderLibrary(); });
            else { renderEmptyMain(); updateNav(); }
          }
          renderLibrary(); renderSidebar();
          showToast("Shelf deleted.");
        });
      } else {
        actionBtn.classList.add("danger-arm");
        actionBtn.title = "Click again to delete the whole shelf";
        libraryDeleteArm[bookId] = setTimeout(() => { actionBtn.classList.remove("danger-arm"); actionBtn.title = "Delete this shelf"; delete libraryDeleteArm[bookId]; }, 3000);
      }
      return;
    }
  }
  const card = e.target.closest(".book-card:not(.add-card)");
  if (!card) return;
  const bookId = card.dataset.bookId;
  const book = books.find((b) => b.id === bookId);
  if (!book) return;
  const sibs = chapters.filter((c) => c.bookId === bookId).sort((a, z) => a.seq - z.seq);
  const target = (book.lastReadChapterId && sibs.some((c) => c.id === book.lastReadChapterId)) ? book.lastReadChapterId : (sibs[0] && sibs[0].id);
  if (target) openChapter(target);
});
libraryGrid.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest(".book-card");
  if (!card) return;
  e.preventDefault();
  card.click();
});

/* ---------------- open / navigate chapters ---------------- */
function openChapter(id, landLastPage) {
  const ch = chapters.find((c) => c.id === id);
  if (!ch) {
    currentId = null; saveJSON(LS_CURRENT, null);
    renderEmptyMain(); renderSidebar(); updateNav();
    return Promise.resolve();
  }
  currentId = id;
  saveJSON(LS_CURRENT, currentId);
  closeLibrary();
  if (ch.bookId) {
    const book = books.find((b) => b.id === ch.bookId);
    if (book) {
      let changed = false;
      if (book.lastReadChapterId !== ch.id) { book.lastReadChapterId = ch.id; changed = true; }
      if (book.furthestSeq == null || ch.seq > book.furthestSeq) { book.furthestSeq = ch.seq; changed = true; }
      if (changed) putOne("books", book);
    }
  }
  const token = ++openToken;
  return getOne("chapterText", id).then((rec) => {
    if (token !== openToken) return;
    currentText = rec ? rec.text : "";
    renderSidebar();
    if (settings.readMode === "flip") {
      readerScroll.hidden = true; flipStage.hidden = false;
      renderFlipChapter(ch, currentText, landLastPage);
    } else {
      flipStage.hidden = true; readerScroll.hidden = false;
      renderScrollChapter(ch, currentText);
    }
    if (isMobile()) { settings.sidebarOpen = false; syncSidebarClass(); saveJSON(LS_SETTINGS, settings); }
  });
}
function goRelative(delta, landLast) {
  if (chapters.length === 0) return;
  const cur = chapters.find((c) => c.id === currentId);
  const sibs = siblings(cur);
  const idx = sibs.findIndex((c) => c.id === currentId);
  const next = idx < 0 ? 0 : Math.min(sibs.length - 1, Math.max(0, idx + delta));
  if (sibs[next] && sibs[next].id !== currentId) openChapter(sibs[next].id, landLast);
}
prevBtn.addEventListener("click", () => { settings.readMode === "flip" ? prevFlipPage() : goRelative(-1); });
nextBtn.addEventListener("click", () => { settings.readMode === "flip" ? nextFlipPage() : goRelative(1); });

/* ---------------- sidebar chapter/group actions ---------------- */
const deleteArm = {};
chapterList.addEventListener("click", (e) => {
  const groupHead = e.target.closest('[data-action="toggle-group"]');
  const renameEl = e.target.closest('[data-action="rename-group"]');
  const delGroupBtn = e.target.closest('[data-action="delete-group"]');

  if (renameEl) {
    e.stopPropagation();
    startRenameBook(renameEl.dataset.bookId, renameEl);
    return;
  }
  if (delGroupBtn) {
    e.stopPropagation();
    const bookId = delGroupBtn.dataset.bookId;
    if (deleteArm["b:" + bookId]) {
      clearTimeout(deleteArm["b:" + bookId]);
      delete deleteArm["b:" + bookId];
      deleteBookCascade(bookId).then(() => {
        const removedIds = chapters.filter((c) => c.bookId === bookId).map((c) => c.id);
        chapters = chapters.filter((c) => c.bookId !== bookId);
        books = books.filter((b) => b.id !== bookId);
        if (removedIds.indexOf(currentId) !== -1) {
          currentId = chapters.length ? chapters[0].id : null;
          saveJSON(LS_CURRENT, currentId);
          if (currentId) openChapter(currentId); else { renderEmptyMain(); updateNav(); }
        }
        renderSidebar();
        showToast("Shelf deleted.");
      });
    } else {
      delGroupBtn.classList.add("danger-arm");
      delGroupBtn.title = "Click again to delete the whole shelf";
      deleteArm["b:" + bookId] = setTimeout(() => {
        delGroupBtn.classList.remove("danger-arm");
        delGroupBtn.title = "Delete this shelf";
        delete deleteArm["b:" + bookId];
      }, 3000);
    }
    return;
  }
  if (groupHead) {
    const bookId = groupHead.dataset.bookId;
    const gi = settings.collapsedBooks.indexOf(bookId);
    if (gi === -1) settings.collapsedBooks.push(bookId); else settings.collapsedBooks.splice(gi, 1);
    saveJSON(LS_SETTINGS, settings);
    renderSidebar();
    return;
  }

  const actionBtn = e.target.closest("[data-action]");
  const row = e.target.closest(".chapter-row");
  if (!row) return;
  const id = row.dataset.id;

  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    const ch = chapters.find((c) => c.id === id);
    const sibs = siblings(ch);
    const pos = sibs.findIndex((c) => c.id === id);
    if (action === "up" && pos > 0) {
      const tmp = sibs[pos - 1].seq; sibs[pos - 1].seq = ch.seq; ch.seq = tmp;
      Promise.all([putOne("chapterMeta", ch), putOne("chapterMeta", sibs[pos - 1])]).then(() => { renderSidebar(); if (currentId === id) refreshHeadIfCurrent(id); });
    } else if (action === "down" && pos < sibs.length - 1) {
      const tmp = sibs[pos + 1].seq; sibs[pos + 1].seq = ch.seq; ch.seq = tmp;
      Promise.all([putOne("chapterMeta", ch), putOne("chapterMeta", sibs[pos + 1])]).then(() => { renderSidebar(); if (currentId === id) refreshHeadIfCurrent(id); });
    } else if (action === "edit") {
      if (ch) openModalEdit(ch);
    } else if (action === "delete") {
      if (deleteArm[id]) {
        clearTimeout(deleteArm[id]);
        delete deleteArm[id];
        Promise.all([deleteOne("chapterMeta", id), deleteOne("chapterText", id)]).then(() => {
          chapters = chapters.filter((c) => c.id !== id);
          if (currentId === id) {
            currentId = chapters.length ? chapters[0].id : null;
            saveJSON(LS_CURRENT, currentId);
            if (currentId) openChapter(currentId); else { renderEmptyMain(); updateNav(); }
          }
          renderSidebar();
        });
      } else {
        actionBtn.classList.add("danger-arm");
        actionBtn.title = "Click again to delete";
        deleteArm[id] = setTimeout(() => { actionBtn.classList.remove("danger-arm"); actionBtn.title = "Delete"; delete deleteArm[id]; }, 3000);
      }
    }
    return;
  }
  if (id !== currentId) openChapter(id);
});
chapterList.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest(".chapter-row");
  if (!row) return;
  e.preventDefault();
  if (row.dataset.id !== currentId) openChapter(row.dataset.id);
});
function refreshHeadIfCurrent(id) {
  const ch = chapters.find((c) => c.id === id);
  if (ch && ch.id === currentId) { if (settings.readMode === "flip") renderFlipChapter(ch, currentText); else renderScrollChapter(ch, currentText); }
}
function startRenameBook(bookId, el) {
  const book = books.find((b) => b.id === bookId);
  if (!book) return;
  const input = document.createElement("input");
  input.type = "text"; input.value = book.title; input.className = "book-group-title";
  el.replaceWith(input);
  input.focus(); input.select();
  function commit() {
    const val = input.value.trim() || book.title;
    book.title = val;
    putOne("books", book).then(() => renderSidebar());
  }
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    else if (ev.key === "Escape") { renderSidebar(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (ev) => ev.stopPropagation());
}

/* ---------------- add / edit chapter modal ---------------- */
function openModal(mode) {
  modalCard.dataset.editId = "";
  modalTitle.textContent = "Add a chapter";
  titleInput.value = "";
  chapterBookInput.value = lastBookTitle || "";
  textInput.value = "";
  refreshBookDatalist();
  updateModalCount();
  modalOverlay.hidden = false;
  setTimeout(() => titleInput.focus(), 20);
}
function openModalEdit(ch) {
  modalCard.dataset.editId = ch.id;
  modalTitle.textContent = "Edit chapter";
  titleInput.value = ch.title;
  const book = ch.bookId ? books.find((b) => b.id === ch.bookId) : null;
  chapterBookInput.value = book ? book.title : "";
  refreshBookDatalist();
  getOne("chapterText", ch.id).then((rec) => {
    textInput.value = rec ? rec.text : "";
    updateModalCount();
  });
  modalOverlay.hidden = false;
  setTimeout(() => titleInput.focus(), 20);
}
function closeModal() { modalOverlay.hidden = true; }
function updateModalCount() { modalWordCount.textContent = wordsOf(textInput.value) + " words"; }
textInput.addEventListener("input", updateModalCount);
addChapterBtn.addEventListener("click", () => openModal("add"));
modalCancel.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

modalSave.addEventListener("click", () => {
  const title = titleInput.value.trim() || "Untitled chapter";
  const bookTitle = chapterBookInput.value.trim();
  const text = textInput.value;
  if (!text.trim()) { textInput.focus(); return; }
  lastBookTitle = bookTitle;
  const editId = modalCard.dataset.editId;

  getOrCreateBook(bookTitle).then((book) => {
    const bookId = book ? book.id : null;
    if (editId) {
      const ch = chapters.find((c) => c.id === editId);
      if (!ch) return;
      const bookChanged = (ch.bookId || null) !== (bookId || null);
      ch.title = title; ch.words = wordsOf(text); ch.updatedAt = Date.now();
      if (bookChanged) { ch.bookId = bookId; ch.seq = nextSeq(bookId); }
      return putBookAndChapters(null, [ch], [{ id: ch.id, text }]).then(() => {
        closeModal(); renderSidebar();
        if (currentId === editId) { currentText = text; refreshHeadIfCurrent(editId); }
      });
    } else {
      const id = uid("c");
      const ch = { id, bookId, title, words: wordsOf(text), seq: nextSeq(bookId), addedAt: Date.now(), scrollPct: 0, pagePct: 0 };
      chapters.push(ch);
      return putBookAndChapters(null, [ch], [{ id, text }]).then(() => {
        closeModal();
        openChapter(id);
      });
    }
  }).catch(() => showToast("Could not save - local storage may be full.", true));
});

/* ---------------- EPUB import ---------------- */
importEpubBtn.addEventListener("click", () => epubFileInput.click());
epubFileInput.addEventListener("change", () => {
  const files = Array.from(epubFileInput.files || []);
  epubFileInput.value = "";
  if (!files.length) return;
  if (typeof JSZip === "undefined") { showToast("The EPUB reader library didn't load.", true); return; }
  runEpubImportFlow(files);
});

function guessVolumeNumber(fileName) {
  const base = fileName.replace(/\.epub$/i, "");
  let m = base.match(/vol(?:ume)?\.?\s*#?(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = base.match(/[-_ ]c(\d+)(?:-c?\d+)?/i);
  if (m) return parseInt(m[1], 10);
  return null;
}
function textOfDoc(doc) {
  const body = doc.body;
  if (!body) return "";
  const paras = Array.prototype.slice.call(doc.querySelectorAll("p"))
    .map((p) => p.textContent.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  if (paras.length) return paras.join("\n\n");
  return (body.textContent || "").replace(/[ \t]+/g, " ").trim();
}
function getDcText(opfDoc, tag) {
  const nodes = Array.prototype.slice.call(opfDoc.getElementsByTagName("*"));
  const n = nodes.find((x) => x.localName === tag);
  return n && n.textContent ? n.textContent.trim() : "";
}
const FRONT_MATTER_RE = /^(cover|title\s*page|half\s*title|copyright|imprint|colophon|table\s*of\s*contents|contents|toc|index|acknowledge?ments?|dedication|also\s*by|about\s*the\s*author|epigraph|praise\s*for)$/i;

function parseEpubFile(file, onProgress) {
  return JSZip.loadAsync(file).then((zip) => {
    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) throw new Error("not-epub");
    return containerFile.async("string").then((containerXml) => {
      const containerDoc = new DOMParser().parseFromString(containerXml, "application/xml");
      const rootfileEl = containerDoc.querySelector("rootfile");
      const opfPath = rootfileEl ? rootfileEl.getAttribute("full-path") : null;
      if (!opfPath) throw new Error("no-opf");
      const opfDir = opfPath.indexOf("/") !== -1 ? opfPath.split("/").slice(0, -1).join("/") : "";
      const opfFile = zip.file(opfPath);
      if (!opfFile) throw new Error("opf-missing");
      return opfFile.async("string").then((opfXml) => {
        const opfDoc = new DOMParser().parseFromString(opfXml, "application/xml");
        const bookTitle = getDcText(opfDoc, "title") || file.name.replace(/\.epub$/i, "");
        const creator = getDcText(opfDoc, "creator");
        let series = null, seriesIndex = null;
        Array.prototype.slice.call(opfDoc.querySelectorAll("metadata meta")).forEach((meta) => {
          const name = meta.getAttribute("name") || "";
          if (name === "calibre:series") series = meta.getAttribute("content");
          if (name === "calibre:series_index") seriesIndex = meta.getAttribute("content");
        });
        const manifest = {};
        Array.prototype.slice.call(opfDoc.querySelectorAll("manifest > item")).forEach((item) => {
          manifest[item.getAttribute("id")] = {
            href: item.getAttribute("href"),
            type: item.getAttribute("media-type") || "",
            properties: item.getAttribute("properties") || "",
          };
        });
        const spineEntries = Array.prototype.slice.call(opfDoc.querySelectorAll("spine > itemref")).map((el) => ({
          id: el.getAttribute("idref"),
          linear: el.getAttribute("linear"),
        }));
        const items = [];
        let chain = Promise.resolve();
        spineEntries.forEach((entry) => {
          chain = chain.then(() => {
            const m = manifest[entry.id];
            if (!m || !/html/i.test(m.type)) return;
            if (/\bnav\b/.test(m.properties)) return; // EPUB3 nav document - pure navigation, never real content
            const href = decodeURIComponent(m.href);
            const path = opfDir ? opfDir + "/" + href : href;
            const zf = zip.file(path) || zip.file(href);
            if (!zf) return;
            return zf.async("string").then((html) => {
              const doc = new DOMParser().parseFromString(html, "text/html");
              Array.prototype.slice.call(doc.querySelectorAll("script,style")).forEach((n) => n.remove());
              const heading = doc.querySelector("h1,h2,h3");
              const titleEl = doc.querySelector("title");
              const secTitle = ((heading && heading.textContent) || (titleEl && titleEl.textContent) || "").replace(/\s+/g, " ").trim();
              const text = textOfDoc(doc);
              const words = wordsOf(text);
              if (!text) return;
              const isFrontMatter = FRONT_MATTER_RE.test(secTitle.trim());
              const isNonLinear = entry.linear === "no";
              items.push({
                title: secTitle || ("Section " + (items.length + 1)),
                text, words,
                include: words >= 80 && !isFrontMatter && !isNonLinear,
              });
              if (onProgress && items.length % 12 === 0) onProgress(items.length);
            });
          });
        });
        return chain.then(() => {
          if (onProgress) onProgress(items.length);
          return { fileName: file.name, bookTitle, creator, series, seriesIndex, items };
        });
      });
    });
  });
}
function groupParsedFiles(parsed) {
  const used = new Array(parsed.length).fill(false);
  const groups = [];
  for (let i = 0; i < parsed.length; i++) {
    if (used[i] || !parsed[i].series) continue;
    const key = parsed[i].series.trim().toLowerCase();
    const members = [i];
    for (let j = i + 1; j < parsed.length; j++) if (!used[j] && parsed[j].series && parsed[j].series.trim().toLowerCase() === key) members.push(j);
    members.forEach((k) => { used[k] = true; });
    const files = members.map((k) => parsed[k]).sort((a, b) => (parseFloat(a.seriesIndex) || 0) - (parseFloat(b.seriesIndex) || 0));
    groups.push({ title: parsed[i].series.trim(), members: files });
  }
  for (let i = 0; i < parsed.length; i++) {
    if (used[i]) continue;
    const key = (parsed[i].bookTitle || "").trim().toLowerCase();
    if (!key) continue;
    const members = [i];
    for (let j = i + 1; j < parsed.length; j++) if (!used[j] && (parsed[j].bookTitle || "").trim().toLowerCase() === key) members.push(j);
    if (members.length > 1) {
      members.forEach((k) => { used[k] = true; });
      const files = members.map((k) => parsed[k]).sort((a, b) => {
        const va = guessVolumeNumber(a.fileName), vb = guessVolumeNumber(b.fileName);
        if (va != null && vb != null) return va - vb;
        if (va != null) return -1;
        if (vb != null) return 1;
        return a.fileName.localeCompare(b.fileName);
      });
      groups.push({ title: parsed[i].bookTitle.trim(), members: files });
    }
  }
  for (let i = 0; i < parsed.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    groups.push({ title: parsed[i].bookTitle || parsed[i].fileName.replace(/\.epub$/i, ""), members: [parsed[i]] });
  }
  return groups;
}

let epubPending = null;
function runEpubImportFlow(files) {
  epubOverlay.hidden = false;
  epubImportBtn.disabled = true;
  const progLine = document.createElement("div");
  progLine.className = "epub-progress";
  progLine.innerHTML = '<div class="spinner"></div><span id="epubProgText">Reading files&hellip;</span>';
  epubBody.innerHTML = "";
  epubBody.appendChild(progLine);
  const progText = document.getElementById("epubProgText");

  const parsed = [];
  let chain = Promise.resolve();
  files.forEach((file, fi) => {
    chain = chain.then(() => {
      progText.textContent = `Reading ${file.name} (${fi + 1} of ${files.length})\u2026`;
      return parseEpubFile(file, (n) => { progText.textContent = `Reading ${file.name} (${fi + 1} of ${files.length}) \u2014 ${n} sections found\u2026`; })
        .then((r) => { parsed.push(r); })
        .catch((err) => { console.error(err); showToast(`Skipped ${file.name} - couldn't read it as an EPUB.`, true); });
    });
  });
  chain.then(() => {
    if (!parsed.length) { closeEpubModal(); showToast("No readable EPUB files found.", true); return; }
    const groups = groupParsedFiles(parsed);
    epubPending = { groups: groups.map((g) => {
      const combined = [];
      g.members.forEach((mem) => { mem.items.forEach((it) => combined.push(it)); });
      const totalItems = combined.length;
      const mode = (g.members.length > 1 || totalItems > 40) ? "compact" : "granular";
      const existing = findBookByTitle(g.title);
      return { title: g.title, members: g.members, mode, existingBookId: existing ? existing.id : null };
    }) };
    renderEpubPreview();
  });
}
function closeEpubModal() { epubOverlay.hidden = true; epubPending = null; epubImportBtn.disabled = true; }
epubCancel.addEventListener("click", closeEpubModal);
epubOverlay.addEventListener("click", (e) => { if (e.target === epubOverlay) closeEpubModal(); });

function renderEpubPreview() {
  let html = "";
  epubPending.groups.forEach((grp, gi) => {
    const totalWords = grp.members.reduce((s, m) => s + m.items.reduce((s2, it) => s2 + it.words, 0), 0);
    const totalItems = grp.members.reduce((s, m) => s + m.items.length, 0);
    html += `<div class="epub-group" data-gi="${gi}">` +
      '<div class="epub-group-head">' +
        `<input class="epub-group-title" data-gi="${gi}" value="${esc(grp.title)}">` +
        `<span class="epub-group-total">${totalItems} sections &middot; ${totalWords.toLocaleString()} words</span>` +
      "</div>";
    if (grp.existingBookId) {
      html += `<div class="epub-append-note">Will be added to your existing "${esc(grp.title)}" shelf.</div>`;
    }
    if (grp.mode === "compact") {
      html += '<div class="epub-vol-list">';
      grp.members.forEach((mem, mi) => {
        const w = mem.items.reduce((s, it) => s + it.words, 0);
        const included = mem.items.filter((it) => it.include).length;
        html += `<label class="epub-row" data-gi="${gi}" data-mi="${mi}">` +
          `<input type="checkbox" data-gi="${gi}" data-mi="${mi}" checked>` +
          `<span class="epub-row-title">${esc(mem.fileName)}</span>` +
          `<span class="epub-row-meta">${included} ch &middot; ${w.toLocaleString()}w</span>` +
        "</label>";
      });
      html += "</div>";
    } else {
      html += '<div class="epub-vol-list">';
      grp.members[0].items.forEach((it, ii) => {
        html += `<label class="epub-row${it.include ? "" : " skip"}" data-gi="${gi}" data-ii="${ii}">` +
          `<input type="checkbox" data-gi="${gi}" data-ii="${ii}"${it.include ? " checked" : ""}>` +
          `<span class="epub-row-title">${esc(it.title)}</span>` +
          `<span class="epub-row-meta">${it.words}w</span>` +
        "</label>";
      });
      html += "</div>";
    }
    html += "</div>";
  });
  epubBody.innerHTML = html;
  epubImportBtn.disabled = false;
}
epubBody.addEventListener("change", (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (cb) {
    const gi = +cb.dataset.gi;
    const grp = epubPending.groups[gi];
    if (cb.dataset.mi !== undefined) {
      const mi = +cb.dataset.mi;
      grp.members[mi].items.forEach((it) => { it.include = cb.checked; });
    } else if (cb.dataset.ii !== undefined) {
      const ii = +cb.dataset.ii;
      grp.members[0].items[ii].include = cb.checked;
      cb.closest(".epub-row").classList.toggle("skip", !cb.checked);
    }
    return;
  }
  const titleInputEl = e.target.closest(".epub-group-title");
  if (titleInputEl) { epubPending.groups[+titleInputEl.dataset.gi].title = titleInputEl.value; }
});

epubImportBtn.addEventListener("click", () => {
  if (!epubPending) return;
  epubImportBtn.disabled = true;
  const summaries = [];
  const chain = epubPending.groups.reduce(
    (p, grp) => p.then(() => importOneGroup(grp)).then((s) => { if (s) summaries.push(s); }),
    Promise.resolve()
  );
  chain.then(() => {
    closeEpubModal();
    renderSidebar();
    updateStorageMeter();
    if (summaries.length) {
      showToast(summaries.length === 1 ? summaries[0] : summaries.join(" "));
    } else {
      showToast("Nothing was imported - every detected section was below the length threshold.", true);
    }
    if (!currentId && chapters.length) openChapter(chapters[0].id);
  }).catch((err) => {
    console.error(err);
    showToast("Import failed partway through - local storage may be full.", true);
    closeEpubModal();
    renderSidebar();
  });
});
function importOneGroup(grp) {
  const title = (grp.title || "Imported book").trim();
  return getOrCreateBook(title).then((book) => {
    let seq = nextSeq(book.id);
    const metaArr = [], textArr = [];
    let count = 0;
    grp.members.forEach((mem) => {
      mem.items.forEach((it) => {
        if (!it.include) return;
        const id = uid("c");
        metaArr.push({ id, bookId: book.id, title: it.title, words: it.words, seq: seq++, addedAt: Date.now(), scrollPct: 0, pagePct: 0 });
        textArr.push({ id, text: it.text });
        count++;
      });
    });
    if (!count) return "";
    return putBookAndChapters(null, metaArr, textArr).then(() => {
      metaArr.forEach((m) => chapters.push(m));
      lastBookTitle = title;
      return `Imported ${count.toLocaleString()} chapters into "${title}".`;
    });
  });
}

/* ---------------- keyboard shortcuts ---------------- */
document.addEventListener("keydown", (e) => {
  if (!modalOverlay.hidden) { if (e.key === "Escape") closeModal(); return; }
  if (!epubOverlay.hidden) { if (e.key === "Escape") closeEpubModal(); return; }
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.key === "ArrowRight") { settings.readMode === "flip" ? nextFlipPage() : goRelative(1); }
  else if (e.key === "ArrowLeft") { settings.readMode === "flip" ? prevFlipPage() : goRelative(-1); }
  else if (e.key.toLowerCase() === "f") { toggleFocus(); wakeDock(); }
  else if (e.key.toLowerCase() === "n") openModal("add");
  else if (e.key === "Escape" && settings.focus) toggleFocus();
});
window.addEventListener("mousemove", () => { if (app.classList.contains("focus-mode")) wakeDock(); });

/* ---------------- boot ---------------- */
applyTheme();
applyTypography();
syncSidebarClass();
applyFocus();
modeBtn.classList.toggle("on", settings.readMode === "flip");

openDB()
  .then((_db) => { db = _db; return Promise.all([getAll("books"), getAll("chapterMeta")]); })
  .then(([b, c]) => {
    books = b; chapters = c;
    renderSidebar();
    if (currentId && chapters.some((c2) => c2.id === currentId)) openChapter(currentId);
    else if (chapters.length) openChapter(chapters.slice().sort((a, z) => a.seq - z.seq)[0].id);
    else { renderEmptyMain(); updateNav(); }
    wakeDock();
    updateStorageMeter();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  })
  .catch((err) => {
    console.error(err);
    chapterList.innerHTML = '<div class="sidebar-empty"><p>Local storage isn\'t available in this browser, so your library can\'t be saved here.</p></div>';
    renderEmptyMain();
  });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}
