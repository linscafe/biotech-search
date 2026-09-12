"use strict";

/*
 * Static Supabase-backed frontend for the biotech company search.
 *
 * Security-relevant invariants this file must preserve (see
 * plan-migration.md, Phase 5 and "Verification and release gates" #5):
 *  - No data is rendered before session init completes AND access_status()
 *    returns true.
 *  - No innerHTML anywhere; all DOM text comes from textContent /
 *    createTextNode. Highlighting is done by splitting text and appending
 *    real <mark> elements.
 *  - Only http:/https: URLs (via `new URL()`) are ever rendered as links.
 *  - No query text, results, tokens or session data go into the URL,
 *    localStorage, a service worker, or any persistent cache.
 *  - Auth callback handling never does data work synchronously inside
 *    onAuthStateChange (scheduled via queueMicrotask instead).
 *  - Every request is tagged with a request id + session id; stale
 *    responses (wrong id, or session no longer current) are discarded.
 */

(function () {
  const fatalErrorEl = document.getElementById("fatal-error");

  function fatal(message) {
    fatalErrorEl.textContent = message;
    fatalErrorEl.hidden = false;
    document.getElementById("auth-screen").hidden = true;
    document.getElementById("app-screen").hidden = true;
  }

  if (!window.APP_CONFIG || !window.APP_CONFIG.SUPABASE_URL || !window.APP_CONFIG.SUPABASE_PUBLISHABLE_KEY) {
    fatal(
      "Configuration error: docs/config.js is missing or incomplete.\n" +
      "An operator must set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY before this page can work."
    );
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    fatal(
      "Missing dependency: the Supabase client library was not found.\n" +
      "An operator must vendor docs/vendor/supabase-js.min.js (see docs/vendor/README.md) " +
      "before this page can work."
    );
    return;
  }

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  const PAGE_SIZE = 50;
  const EXPORT_PAGE_SIZE = 100; // server max
  const MAX_PAGE_OFFSET = 100000;
  const MAX_QUERY_LENGTH = 500;
  const MAX_KEYWORDS = 10;
  const DEBOUNCE_MS = 250;
  const SORT_OPTIONS = new Set(["relevance", "name_asc", "name_desc", "country_asc", "country_desc"]);

  // Derived only from the page's own location — never from user input or a
  // query parameter. A trailing "index.html" is stripped so that /repo/ and
  // /repo/index.html produce the SAME value: Supabase matches redirect URLs
  // exactly, and only the directory form is registered in the allowlist.
  const REDIRECT_TO =
    window.location.origin +
    window.location.pathname.replace(/index\.html$/, "");

  const createClient = window.supabase.createClient;
  const supabaseClient = createClient(
    window.APP_CONFIG.SUPABASE_URL,
    window.APP_CONFIG.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        flowType: "pkce",
        storage: window.sessionStorage,
        persistSession: true,
        detectSessionInUrl: true,
        autoRefreshToken: true,
      },
    }
  );

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------

  const authScreen = document.getElementById("auth-screen");
  const authMessage = document.getElementById("auth-message");
  const signinBtn = document.getElementById("signin-btn");
  const authSignoutBtn = document.getElementById("auth-signout-btn");

  const appScreen = document.getElementById("app-screen");
  const userEmailEl = document.getElementById("user-email");
  const signoutBtn = document.getElementById("signout-btn");

  const form = document.getElementById("search-form");
  const input = document.getElementById("q");
  const queryErrorEl = document.getElementById("query-error");
  const statusEl = document.getElementById("status");
  const resultsBody = document.getElementById("results");
  const exportMdBtn = document.getElementById("export-md");
  const exportCsvBtn = document.getElementById("export-csv");
  const paginationEl = document.getElementById("pagination");
  const pageInfoEl = document.getElementById("page-info");
  const pageSelect = document.getElementById("page-select");
  const prevBtn = document.getElementById("prev-page");
  const nextBtn = document.getElementById("next-page");
  const countryFilter = document.getElementById("filter-country");
  const websiteFilter = document.getElementById("filter-website");
  const resetFiltersBtn = document.getElementById("reset-filters");
  const sortableHeaders = document.querySelectorAll("th.sortable");

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  let sessionEpoch = 0; // bumped on every auth event; invalidates in-flight work
  let requestCounter = 0;
  let currentRequestEpoch = { req: 0, session: -1 };

  let currentKeywords = [];
  let currentSort = "relevance";
  let currentOffset = 0;
  let currentTotal = 0;
  let currentRows = []; // rows currently rendered (for reference only)
  let lastQueryArgs = null; // filter/sort/q snapshot backing the currently displayed results
  let knownCountries = [];
  let debounceTimer = null;
  let exportInFlight = false;
  let activeObjectUrls = [];
  let appInitialized = false;

  function revokeAllObjectUrls() {
    for (const url of activeObjectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {
        /* ignore */
      }
    }
    activeObjectUrls = [];
  }

  function clearAppState() {
    resultsBody.textContent = "";
    statusEl.textContent = "";
    statusEl.classList.remove("is-error");
    paginationEl.hidden = true;
    exportMdBtn.disabled = true;
    exportCsvBtn.disabled = true;
    currentKeywords = [];
    currentOffset = 0;
    currentTotal = 0;
    currentRows = [];
    lastQueryArgs = null;
    revokeAllObjectUrls();
    appInitialized = false;
  }

  // ---------------------------------------------------------------------
  // Screen management
  // ---------------------------------------------------------------------

  function showAuthScreen(message, { showSignin = false, showSignout = false, isError = false } = {}) {
    appScreen.hidden = true;
    authScreen.hidden = false;
    authMessage.textContent = message;
    authMessage.classList.toggle("is-error", !!isError);
    signinBtn.hidden = !showSignin;
    authSignoutBtn.hidden = !showSignout;
  }

  function showAppScreen(email) {
    authScreen.hidden = true;
    appScreen.hidden = false;
    userEmailEl.textContent = email || "";
  }

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------

  async function signInWithGoogle() {
    try {
      await supabaseClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: REDIRECT_TO },
      });
    } catch (err) {
      showAuthScreen("Could not start sign-in. Please try again.", { showSignin: true, isError: true });
    }
  }

  async function signOut() {
    revokeAllObjectUrls();
    try {
      await supabaseClient.auth.signOut();
    } catch (_) {
      // Even if the network call fails, onAuthStateChange / local state
      // cleanup below still runs on the next SIGNED_OUT-equivalent path.
    }
  }

  function stripOAuthParamsFromUrl() {
    const url = new URL(window.location.href);
    const searchKeys = ["code", "state", "error", "error_description", "error_code", "scope"];
    let changed = false;
    for (const key of searchKeys) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    let hash = url.hash;
    if (hash && /access_token|refresh_token|error|provider_token/.test(hash)) {
      hash = "";
      changed = true;
    }
    if (changed) {
      url.hash = hash;
      history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + (hash || ""));
    }
  }

  async function checkApproval(epoch) {
    let result;
    try {
      result = await supabaseClient.rpc("access_status");
    } catch (err) {
      if (epoch !== sessionEpoch) return;
      clearAppState();
      showAuthScreen(
        "Service temporarily unavailable. Please check your connection and try again.",
        { showSignout: true, isError: true }
      );
      return;
    }
    if (epoch !== sessionEpoch) return; // stale

    const { data, error } = result;
    if (error) {
      if (epoch !== sessionEpoch) return;
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("jwt") || msg.includes("token") || error.status === 401) {
        clearAppState();
        showAuthScreen("Your session has expired. Please sign in again.", { showSignin: true, isError: true });
        await signOut();
        return;
      }
      clearAppState();
      showAuthScreen(
        "Service temporarily unavailable. Please try again shortly.",
        { showSignout: true, isError: true }
      );
      return;
    }

    if (data === true) {
      const { data: userData } = await supabaseClient.auth.getUser().catch(() => ({ data: null }));
      if (epoch !== sessionEpoch) return;
      const email = userData && userData.user ? userData.user.email : "";
      showAppScreen(email);
      initAppOnce();
    } else {
      clearAppState();
      showAuthScreen(
        "Your account is signed in but not yet approved for access.\nPlease contact the administrator.",
        { showSignout: true }
      );
    }
  }

  function handleAuthEvent(event, session) {
    sessionEpoch += 1;
    const epoch = sessionEpoch;

    if (!session) {
      clearAppState();
      showAuthScreen("Sign in to search the database.", { showSignin: true });
      stripOAuthParamsFromUrl();
      return;
    }

    // Only show the transitional "checking access" screen on first sign-in;
    // a background token refresh re-verifies approval without disrupting an
    // already-rendered app screen (checkApproval re-hides it if approval
    // was actually lost).
    if (!appInitialized) {
      showAuthScreen("Checking access...", {});
    }
    checkApproval(epoch);
    stripOAuthParamsFromUrl();
  }

  supabaseClient.auth.onAuthStateChange((event, session) => {
    // Never do data work synchronously inside this callback.
    queueMicrotask(() => handleAuthEvent(event, session));
  });

  signinBtn.addEventListener("click", () => {
    signInWithGoogle();
  });
  authSignoutBtn.addEventListener("click", () => {
    signOut();
  });
  signoutBtn.addEventListener("click", () => {
    signOut();
  });

  // ---------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------

  function parseKeywords(raw) {
    return raw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }

  function validateQuery(raw) {
    if (raw.length > MAX_QUERY_LENGTH) {
      return `Query is too long (max ${MAX_QUERY_LENGTH} characters).`;
    }
    const keywords = parseKeywords(raw);
    if (keywords.length > MAX_KEYWORDS) {
      return `Too many keywords (max ${MAX_KEYWORDS} comma-separated terms).`;
    }
    return null;
  }

  function setQueryError(message) {
    if (message) {
      queryErrorEl.textContent = message;
      queryErrorEl.hidden = false;
    } else {
      queryErrorEl.textContent = "";
      queryErrorEl.hidden = true;
    }
  }

  // ---------------------------------------------------------------------
  // URL / link safety
  // ---------------------------------------------------------------------

  function safeHttpUrl(value) {
    if (!value) return null;
    let u;
    try {
      u = new URL(value);
    } catch (_) {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  }

  // ---------------------------------------------------------------------
  // Highlighting (no innerHTML: split text, append real <mark> elements)
  // ---------------------------------------------------------------------

  function findSpans(text, keywords) {
    const lowerText = text.toLowerCase();
    const spans = [];
    for (const kw of keywords) {
      const lkw = kw.toLowerCase();
      if (!lkw) continue;
      let idx = 0;
      while (idx <= lowerText.length) {
        const found = lowerText.indexOf(lkw, idx);
        if (found === -1) break;
        spans.push([found, found + lkw.length]);
        idx = found + lkw.length;
      }
    }
    if (!spans.length) return [];
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0].slice()];
    for (let i = 1; i < spans.length; i++) {
      const [s, e] = spans[i];
      const last = merged[merged.length - 1];
      if (s <= last[1]) {
        last[1] = Math.max(last[1], e);
      } else {
        merged.push([s, e]);
      }
    }
    return merged;
  }

  function renderHighlighted(container, text, keywords) {
    container.textContent = "";
    if (!text) return;
    const spans = keywords.length ? findSpans(text, keywords) : [];
    if (!spans.length) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    let pos = 0;
    for (const [s, e] of spans) {
      if (s > pos) {
        container.appendChild(document.createTextNode(text.slice(pos, s)));
      }
      const mark = document.createElement("mark");
      mark.textContent = text.slice(s, e);
      container.appendChild(mark);
      pos = e;
    }
    if (pos < text.length) {
      container.appendChild(document.createTextNode(text.slice(pos)));
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function updateCountryOptions(countries) {
    const changed =
      countries.length !== knownCountries.length || countries.some((c, i) => c !== knownCountries[i]);
    if (!changed) return;
    knownCountries = countries;
    const current = countryFilter.value;
    countryFilter.textContent = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All";
    countryFilter.appendChild(allOpt);
    for (const c of countries) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      countryFilter.appendChild(opt);
    }
    if (countries.includes(current)) {
      countryFilter.value = current;
    }
  }

  function updateSortIndicators() {
    for (const th of sortableHeaders) {
      const key = th.dataset.sort;
      const arrow = th.querySelector(".sort-arrow");
      if (currentSort === `${key}_asc`) {
        arrow.textContent = " ▲";
      } else if (currentSort === `${key}_desc`) {
        arrow.textContent = " ▼";
      } else {
        arrow.textContent = "";
      }
    }
  }

  function renderPagination(total, offset) {
    if (total === 0) {
      paginationEl.hidden = true;
      return;
    }
    paginationEl.hidden = false;

    const start = offset + 1;
    const end = Math.min(offset + PAGE_SIZE, total);
    pageInfoEl.textContent = `Showing ${start}–${end} of ${total}`;

    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const currentPage = Math.floor(offset / PAGE_SIZE);

    pageSelect.textContent = "";
    for (let p = 0; p < pageCount; p++) {
      const pStart = p * PAGE_SIZE + 1;
      const pEnd = Math.min((p + 1) * PAGE_SIZE, total);
      const opt = document.createElement("option");
      opt.value = String(p * PAGE_SIZE);
      opt.textContent = `${pStart}–${pEnd}`;
      if (p === currentPage) opt.selected = true;
      pageSelect.appendChild(opt);
    }

    prevBtn.disabled = offset <= 0;
    nextBtn.disabled = offset + PAGE_SIZE >= total;
  }

  function websiteCell(website) {
    const url = safeHttpUrl(website);
    if (!url) {
      return document.createTextNode(website ? "" : "—");
    }
    const a = document.createElement("a");
    a.href = url.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = url.href;
    a.textContent = url.hostname.replace(/^www\./, "");
    return a;
  }

  /** Join a jsonb string array into one display line, dropping non-strings
   *  and blanks. Returns "" when there is nothing to show. */
  function joinTextList(value) {
    if (!Array.isArray(value)) return "";
    return value
      .filter((v) => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim())
      .join("; ");
  }

  function appendPeopleLine(cell, label, value, keywords) {
    const text = joinTextList(value);
    if (!text) return;
    const div = document.createElement("div");
    div.className = "tag people";
    div.appendChild(document.createTextNode(label + ": "));
    const span = document.createElement("span");
    renderHighlighted(span, text, keywords);
    div.appendChild(span);
    cell.appendChild(div);
  }

  function renderRows(rows, keywords) {
    resultsBody.textContent = "";
    for (const r of rows) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.className = "name-cell";
      nameTd.title = r.name || "";
      const nameSpan = document.createElement("span");
      renderHighlighted(nameSpan, r.name || "", keywords);
      nameTd.appendChild(nameSpan);
      if (r.city) {
        const loc = document.createElement("div");
        loc.className = "loc";
        loc.textContent = r.city;
        nameTd.appendChild(loc);
      }

      const countryTd = document.createElement("td");
      countryTd.className = "country-cell";
      countryTd.textContent = r.country || "—";
      countryTd.title = r.country || "";

      const websiteTd = document.createElement("td");
      websiteTd.className = "website-cell";
      websiteTd.appendChild(websiteCell(r.website));

      const briefTd = document.createElement("td");
      briefTd.className = "brief-cell";
      const briefSpan = document.createElement("span");
      renderHighlighted(briefSpan, r.brief || "", keywords);
      briefTd.appendChild(briefSpan);

      if (Array.isArray(r.technology) && r.technology.length) {
        const tagDiv = document.createElement("div");
        tagDiv.className = "tag";
        tagDiv.appendChild(document.createTextNode("Technology: "));
        const tagText = document.createElement("span");
        renderHighlighted(tagText, r.technology.join(", "), keywords);
        tagDiv.appendChild(tagText);
        briefTd.appendChild(tagDiv);
      }

      // Free-text, model-extracted, and often long — same untrusted handling
      // as every other database field: text nodes only, never innerHTML.
      appendPeopleLine(briefTd, "Founders", r.founders, keywords);
      appendPeopleLine(briefTd, "Investors", r.investors, keywords);

      tr.appendChild(nameTd);
      tr.appendChild(countryTd);
      tr.appendChild(websiteTd);
      tr.appendChild(briefTd);
      resultsBody.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

  function currentSearchArgs(offset) {
    return {
      q: input.value,
      filter_country: countryFilter.value || null,
      only_with_website: websiteFilter.checked ? true : null,
      sort_mode: SORT_OPTIONS.has(currentSort) ? currentSort : "relevance",
      page_size: PAGE_SIZE,
      page_offset: Math.max(0, Math.min(MAX_PAGE_OFFSET, offset)),
    };
  }

  async function runSearch(offset = 0) {
    const raw = input.value;
    const validationError = validateQuery(raw);
    setQueryError(validationError);
    if (validationError) {
      return;
    }

    const epoch = sessionEpoch;
    const reqId = ++requestCounter;
    currentRequestEpoch = { req: reqId, session: epoch };

    currentKeywords = parseKeywords(raw);
    currentOffset = Math.max(0, Math.min(MAX_PAGE_OFFSET, offset));

    statusEl.classList.remove("is-error");
    statusEl.textContent = "Searching...";

    const searchArgs = currentSearchArgs(currentOffset);

    let result;
    try {
      result = await supabaseClient.rpc("search_companies", searchArgs);
    } catch (err) {
      if (reqId !== currentRequestEpoch.req || epoch !== sessionEpoch) return;
      statusEl.classList.add("is-error");
      statusEl.textContent = "Network error while searching. Please try again.";
      return;
    }

    if (reqId !== currentRequestEpoch.req || epoch !== sessionEpoch) return; // stale response

    const { data, error } = result;
    if (error) {
      statusEl.classList.add("is-error");
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("jwt") || msg.includes("token") || error.status === 401) {
        statusEl.textContent = "Your session has expired. Please sign in again.";
        await signOut();
      } else {
        statusEl.textContent = "Something went wrong loading results. Please try again.";
      }
      return;
    }

    const rows = Array.isArray(data) ? data : [];
    currentRows = rows;
    currentTotal = rows.length ? Number(rows[0].total_count) || 0 : 0;
    // Snapshot the exact filter/sort/query that produced what's on screen,
    // so a later export always matches what the user is looking at even if
    // they've started typing a new query that hasn't been searched yet.
    lastQueryArgs = {
      q: searchArgs.q,
      filter_country: searchArgs.filter_country,
      only_with_website: searchArgs.only_with_website,
      sort_mode: searchArgs.sort_mode,
    };

    exportMdBtn.disabled = currentTotal === 0;
    exportCsvBtn.disabled = currentTotal === 0;

    updateSortIndicators();
    renderRows(rows, currentKeywords);
    renderPagination(currentTotal, currentOffset);

    if (currentTotal === 0) {
      if (currentKeywords.length) {
        statusEl.textContent = `No companies matched: ${currentKeywords.join(", ")}`;
      } else {
        statusEl.textContent = "No companies matched the current filters.";
      }
      return;
    }
    statusEl.textContent = `${currentTotal} compan${currentTotal === 1 ? "y" : "ies"} matched`;
  }

  async function fetchCountries() {
    const epoch = sessionEpoch;
    let result;
    try {
      result = await supabaseClient.rpc("list_countries");
    } catch (_) {
      return; // non-fatal: filter just won't populate
    }
    if (epoch !== sessionEpoch) return;
    const { data, error } = result;
    if (error || !Array.isArray(data)) return;
    updateCountryOptions(data.map((r) => r.country).filter((c) => !!c));
  }

  function initAppOnce() {
    if (appInitialized) return;
    appInitialized = true;
    fetchCountries();
    runSearch(0);
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  const EXPORT_HEADER = ["Company", "Sector", "City", "Country", "Website", "Brief", "Founders", "Investors"];

  function neutralizeFormula(value) {
    let i = 0;
    while (i < value.length && value.charCodeAt(i) <= 0x20) i++;
    const leading = value.slice(0, i);
    const rest = value.slice(i);
    const dangerousLead = rest.length > 0 && ["=", "+", "-", "@"].includes(rest[0]);
    const dangerousStrippedControl = /[\t\r\n]/.test(leading);
    if (dangerousLead || dangerousStrippedControl) {
      return "'" + value;
    }
    return value;
  }

  function csvField(raw) {
    let v = raw === null || raw === undefined ? "" : String(raw);
    v = neutralizeFormula(v);
    v = v.replace(/"/g, '""');
    return '"' + v + '"';
  }

  function buildCsv(rows) {
    const lines = [EXPORT_HEADER.map(csvField).join(",")];
    for (const r of rows) {
      lines.push(
        [r.name, r.sector, r.city, r.country, r.website, r.brief,
         joinTextList(r.founders), joinTextList(r.investors)].map(csvField).join(",")
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  function mdEscape(raw) {
    let v = raw === null || raw === undefined ? "" : String(raw);
    v = v.replace(/\\/g, "\\\\");
    v = v.replace(/\|/g, "\\|");
    v = v.replace(/\r\n|\r|\n/g, " ");
    return v;
  }

  function mdWebsiteCell(website) {
    const url = safeHttpUrl(website);
    if (!url) return mdEscape(website || "");
    return `[${mdEscape(url.hostname.replace(/^www\./, ""))}](${mdEscape(url.href)})`;
  }

  function buildMarkdown(rows, keywords) {
    const lines = [];
    lines.push(`# Biotech search results: ${keywords.length ? keywords.join(", ") : "(all)"}`);
    lines.push("");
    lines.push(`| ${EXPORT_HEADER.join(" | ")} |`);
    lines.push(`| ${EXPORT_HEADER.map(() => "---").join(" | ")} |`);
    for (const r of rows) {
      lines.push(
        `| ${mdEscape(r.name)} | ${mdEscape(r.sector)} | ${mdEscape(r.city)} | ` +
        `${mdEscape(r.country)} | ${mdWebsiteCell(r.website)} | ${mdEscape(r.brief)} | ` +
        `${mdEscape(joinTextList(r.founders))} | ${mdEscape(joinTextList(r.investors))} |`
      );
    }
    return lines.join("\n") + "\n";
  }

  async function fetchAllRowsForExport(epoch) {
    if (!lastQueryArgs) return [];
    const rows = [];
    let offset = 0;
    const args = Object.assign({}, lastQueryArgs, { page_size: EXPORT_PAGE_SIZE });
    while (true) {
      if (epoch !== sessionEpoch) return null; // session changed mid-export
      if (offset > MAX_PAGE_OFFSET) break;
      const callArgs = Object.assign({}, args, { page_offset: offset });
      let result;
      try {
        result = await supabaseClient.rpc("search_companies", callArgs);
      } catch (err) {
        throw new Error("network");
      }
      if (epoch !== sessionEpoch) return null;
      const { data, error } = result;
      if (error) throw new Error("rpc");
      const page = Array.isArray(data) ? data : [];
      if (!page.length) break;
      for (const row of page) rows.push(row);
      const total = Number(page[0].total_count) || 0;
      offset += EXPORT_PAGE_SIZE;
      if (offset >= total) break;
    }
    return rows;
  }

  function triggerDownload(content, mimeType, filename) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    activeObjectUrls.push(url);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      activeObjectUrls = activeObjectUrls.filter((u) => u !== url);
    }, 2000);
  }

  function exportFilenameSlug(keywords) {
    const base = keywords.length ? keywords.join("-") : "all";
    return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  }

  async function runExport(format) {
    if (exportInFlight) return;
    exportInFlight = true;
    exportMdBtn.disabled = true;
    exportCsvBtn.disabled = true;
    const priorStatus = statusEl.textContent;
    statusEl.classList.remove("is-error");
    statusEl.textContent = "Preparing export...";
    const epoch = sessionEpoch;
    try {
      const rows = await fetchAllRowsForExport(epoch);
      if (rows === null || epoch !== sessionEpoch) {
        return; // session changed; abandon silently, UI has already reset
      }
      const slug = exportFilenameSlug(currentKeywords);
      if (format === "csv") {
        triggerDownload(buildCsv(rows), "text/csv;charset=utf-8", `biotech-search-${slug}.csv`);
      } else {
        triggerDownload(
          buildMarkdown(rows, currentKeywords),
          "text/markdown;charset=utf-8",
          `biotech-search-${slug}.md`
        );
      }
      statusEl.textContent = `Exported ${rows.length} row${rows.length === 1 ? "" : "s"}.`;
    } catch (err) {
      statusEl.classList.add("is-error");
      statusEl.textContent = "Export failed. Please try again.";
    } finally {
      exportInFlight = false;
      if (epoch === sessionEpoch) {
        exportMdBtn.disabled = currentTotal === 0;
        exportCsvBtn.disabled = currentTotal === 0;
        if (statusEl.textContent === "Preparing export...") {
          statusEl.textContent = priorStatus;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(debounceTimer);
    runSearch(0);
  });

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(0), DEBOUNCE_MS);
  });

  prevBtn.addEventListener("click", () => {
    const offset = Math.max(0, parseInt(pageSelect.value, 10) - PAGE_SIZE);
    runSearch(offset);
  });

  nextBtn.addEventListener("click", () => {
    runSearch(parseInt(pageSelect.value, 10) + PAGE_SIZE);
  });

  pageSelect.addEventListener("change", () => {
    runSearch(parseInt(pageSelect.value, 10));
  });

  exportMdBtn.addEventListener("click", () => runExport("md"));
  exportCsvBtn.addEventListener("click", () => runExport("csv"));

  countryFilter.addEventListener("change", () => runSearch(0));
  websiteFilter.addEventListener("change", () => runSearch(0));

  resetFiltersBtn.addEventListener("click", () => {
    countryFilter.value = "";
    websiteFilter.checked = false;
    currentSort = "relevance";
    runSearch(0);
  });

  for (const th of sortableHeaders) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (currentSort === `${key}_asc`) {
        currentSort = `${key}_desc`;
      } else {
        currentSort = `${key}_asc`;
      }
      runSearch(0);
    });
  }
})();
