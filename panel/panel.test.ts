import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import {
  checkEnNoCjk,
  checkI18nParity,
  checkPanelInvariants,
  DARK_BG_HEX,
  FAMILY_TOKENS,
  HARD_MAX_BYTES,
  LIGHT_OK_HEX,
} from "./kit/guard.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_HTML = path.join(__dirname, "dist", "panel.html");
const THEME_CSS = path.join(__dirname, "theme.css");
const VIEW_TS = path.join(__dirname, "view.ts");
const BRIDGE_TS = path.join(__dirname, "kit", "bridge.ts");

const stripTs = (tsCode: string): string => transformSync(tsCode, { loader: "ts" }).code;

class MockText {
  textContent: string;
  parent: MockEl | null = null;
  constructor(text: unknown) {
    this.textContent = String(text);
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.childNodes.indexOf(this);
    if (i >= 0) this.parent.childNodes.splice(i, 1);
    this.parent = null;
  }
}

class MockEl {
  tag: string;
  className = "";
  hidden = false;
  _text = "";
  title = "";
  disabled = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  childNodes: Array<MockEl | MockText> = [];
  parent: MockEl | null = null;
  classList: { toggle: (c: string, on?: boolean) => void };

  constructor(tag = "div") {
    this.tag = tag;
    this.classList = {
      toggle: (c: string, on?: boolean) => {
        const s = new Set(this.className.split(/\s+/).filter(Boolean));
        on ? s.add(c) : s.delete(c);
        this.className = [...s].join(" ");
      },
    };
  }
  get children(): MockEl[] {
    return this.childNodes.filter((c): c is MockEl => c instanceof MockEl);
  }
  get firstChild(): MockEl | MockText | null {
    return this.childNodes[0] || null;
  }
  get firstElementChild(): MockEl | null {
    return this.children[0] || null;
  }
  get lastElementChild(): MockEl | null {
    const ch = this.children;
    return ch[ch.length - 1] || null;
  }
  get textContent(): string {
    if (this.childNodes.length) return this.childNodes.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v: unknown) {
    this.childNodes = [];
    this._text = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attrs ? this.attrs[k] : null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
    if (k === "title") this.title = String(v);
    if (k === "disabled") this.disabled = true;
  }
  appendChild<T extends MockEl | MockText>(c: T): T {
    c.parent = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore<T extends MockEl | MockText>(el: T, ref: MockEl | MockText | null): T {
    el.parent = this;
    const i = this.childNodes.indexOf(el);
    if (i >= 0) this.childNodes.splice(i, 1);
    const r = ref ? this.childNodes.indexOf(ref) : -1;
    r >= 0 ? this.childNodes.splice(r, 0, el) : this.childNodes.push(el);
    return el;
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.childNodes.indexOf(this);
    if (i >= 0) this.parent.childNodes.splice(i, 1);
    this.parent = null;
  }
  findAll(pred: (el: MockEl) => boolean): MockEl[] {
    const out: MockEl[] = [];
    if (pred(this)) out.push(this);
    for (const c of this.children) out.push(...c.findAll(pred));
    return out;
  }
}

test("panel/dist/panel.html meets Lucid Indigo Panel Kit invariants, <=64 KiB budget, CSP, i18n parity, and anti-flicker guarantees", () => {
  assert.ok(fs.existsSync(DIST_HTML), "panel/dist/panel.html must exist");
  const html = fs.readFileSync(DIST_HTML, "utf8");
  const cssSrc = fs.readFileSync(THEME_CSS, "utf8");
  const viewSrc = fs.readFileSync(VIEW_TS, "utf8");
  const bytes = Buffer.byteLength(html, "utf8");

  const report = checkPanelInvariants(html, {
    maxBytes: HARD_MAX_BYTES,
    bootPlaceholder: "/*__CONTEXT_RADAR_BOOT__*/",
  });
  assert.equal(report.ok, true, `Panel Kit guard failed:\n- ${report.errors.join("\n- ")}`);
  assert.ok(bytes <= HARD_MAX_BYTES, `panel.html must land <=${HARD_MAX_BYTES} B, got ${bytes} B`);

  // Dark-first lock from byte 0 (Lucid Indigo #0B0D12)
  assert.ok(html.includes('<meta name="color-scheme" content="dark">'), "must declare dark-only initial meta color-scheme");
  assert.ok(html.includes(`style="background:${DARK_BG_HEX};color-scheme:dark"`), "must lock dark canvas inline on <html> from byte 0");
  assert.ok(html.includes(`<body style="background:${DARK_BG_HEX}">`), "must lock dark canvas inline on <body>");
  assert.ok(html.includes("/*__CONTEXT_RADAR_BOOT__*/"), "must contain SSR boot marker");
  assert.ok(html.includes("window.__CONTEXT_RADAR_BOOT__"), "must read SSR boot data");
  assert.ok(html.includes("background:var(--bg)"), "body must paint var(--bg)");
  assert.equal(/html,body\{[^}]*--color-background-primary/.test(html), false, "html/body CSS must never bind host --color-background-primary");
  assert.ok(html.includes('class="boot-frame"'), "panel.html must include Frame-0 .boot-frame shell");

  // All Lucid Indigo family tokens defined in both dark :root and :root[data-theme="light"]
  const darkRoot = html.match(/:root\{([^}]+)\}/)?.[1] || "";
  const lightRoot = html.match(/:root\[data-theme="?light"?\]\{([^}]+)\}/)?.[1] || "";
  assert.ok(darkRoot && lightRoot, "must define both :root and :root[data-theme=light]");
  for (const tok of FAMILY_TOKENS) {
    assert.ok(darkRoot.includes(`${tok}:`), `dark :root must define ${tok}`);
    assert.ok(lightRoot.includes(`${tok}:`), `light :root[data-theme=light] must define ${tok}`);
  }
  assert.ok(lightRoot.toUpperCase().includes(`--OK:${LIGHT_OK_HEX}`), `light mode --ok must equal ${LIGHT_OK_HEX}`);

  // Zero prefers-color-scheme, zero opacity:0 keyframes, prefers-reduced-motion present
  assert.equal(/prefers-color-scheme/i.test(html), false, "must NOT contain prefers-color-scheme anywhere");
  assert.equal(/prefers-color-scheme/i.test(cssSrc), false, "theme.css must NOT contain prefers-color-scheme");
  assert.ok(html.includes("prefers-reduced-motion:reduce"), "must respect prefers-reduced-motion:reduce");
  const keyframes = [...html.matchAll(/@keyframes\s+[^{]+\{[\s\S]*?\}\}/g)].map((m) => m[0]);
  assert.ok(keyframes.length >= 2, "must include pulse/spin/sweep keyframes");
  for (const kf of keyframes) {
    assert.equal(/opacity\s*:\s*0(?![.\d])/i.test(kf), false, `keyframe must never use opacity:0: ${kf}`);
  }

  // Zero innerHTML / outerHTML anywhere in view.ts or built panel.html
  assert.equal(/\b(?:inner|outer)HTML\b/.test(viewSrc), false, "view.ts must never use innerHTML/outerHTML");
  assert.equal(/\b(?:inner|outer)HTML\b/.test(html), false, "panel.html must never contain innerHTML/outerHTML");

  // Strict CSP default-src 'none', zero external URLs/tags, exactly ONE inline <script>
  assert.ok(html.includes("default-src 'none'"), "must declare CSP default-src 'none'");
  assert.equal(/https?:\/\//i.test(html), false, "must contain zero http/https URLs");
  assert.equal(/<link\b/i.test(html), false, "must contain zero external <link> tags");
  assert.equal(/<script[^>]+src=/i.test(html), false, "must contain zero external <script src>");
  const scripts = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, "panel.html must merge into exactly ONE inline <script>");
  assert.doesNotThrow(() => new vm.Script(scripts[0]), "single bundled <script> must be valid syntax");
  const injected = scripts[0].replace("/*__CONTEXT_RADAR_BOOT__*/", 'window.__CONTEXT_RADAR_BOOT__={"mode":"snapshot"};');
  assert.doesNotThrow(() => new vm.Script(injected), "SSR-injected <script> must be valid syntax");

  // Bilingual I18N parity and zero CJK in English strings
  const i18nMatch = viewSrc.match(/const I18N = `([\s\S]*?)`\.split/);
  assert.ok(i18nMatch, "view.ts must define I18N table");
  const enDict: Record<string, string> = {};
  const zhDict: Record<string, string> = {};
  i18nMatch[1].split("\n").forEach((row, idx) => {
    const parts = row.split("|");
    assert.equal(parts.length, 2, `I18N row ${idx} must have EN|ZH pair: ${row}`);
    enDict[`k${idx}`] = parts[0];
    zhDict[`k${idx}`] = parts[1];
  });
  for (const m of viewSrc.matchAll(/tr\("([^"\n|]+)\|([^"\n|]+)"\)/g)) {
    enDict[`tr_${Object.keys(enDict).length}`] = m[1];
    zhDict[`tr_${Object.keys(zhDict).length}`] = m[2];
  }
  const parity = checkI18nParity(enDict, zhDict);
  assert.equal(parity.ok, true, `i18n parity failed: ${parity.errors.join("; ")}`);
  const enCjk = checkEnNoCjk(enDict);
  assert.equal(enCjk.ok, true, `EN dictionary contains CJK: ${enCjk.errors.join("; ")}`);

  // Official relay + overview + CSS/title invariants
  assert.ok(html.includes("com.google.antigravity/message"), "must support official target:new relay");
  assert.ok(html.includes("context_radar_overview"), "must call context_radar_overview");
  assert.ok(html.includes("radar_prepare_handoff"), "must call <=24-char radar_prepare_handoff");
  assert.equal(html.includes("context_radar_prepare_handoff"), false, "must not reference >24-char context_radar_prepare_handoff");
  assert.ok(cssSrc.includes('html:not([data-can-msg="1"]) .cr-cap-msg'), "message buttons must be hidden by default until hostCapabilities confirm");
  assert.ok(cssSrc.includes(".bf{display:block;") || cssSrc.includes(".ht>.bf{display:block"), "hotspot fill bars (.ht > .bf) must be display:block to render width");
  assert.ok(html.includes("<title>Context Radar</title>"), "panel.html must use spaced Title Case title");
  assert.equal(cssSrc.includes("--buncss-"), false, "panel.html must contain zero --buncss-* declarations");
});

test("kit/bridge.ts skips size-changed RPCs in aux_pane/global and enables them in inline mode", async () => {
  const { App, LATEST_PROTOCOL_VERSION } = await import(BRIDGE_TS);

  async function runConnect(
    hostContext: Record<string, unknown>,
    opts: { autoResize: boolean } = { autoResize: true }
  ): Promise<{ sent: Array<{ method?: string }>; observedCount: number }> {
    const sent: Array<{ method?: string; id?: unknown }> = [];
    const listeners = new Map<string, (ev: unknown) => void>();
    const g = globalThis as unknown as Record<string, unknown>;
    const origWin = g.window;
    const origDoc = g.document;
    const origRO = g.ResizeObserver;
    const origRAF = g.requestAnimationFrame;

    let observedCount = 0;
    const parentTarget = {
      postMessage(msg: { method?: string; id?: unknown }) {
        sent.push(msg);
        if (msg.method === "ui/initialize") {
          queueMicrotask(() => {
            const cb = listeners.get("message");
            cb?.({
              source: parentTarget,
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  hostCapabilities: { serverTools: {} },
                  hostInfo: { name: "test-host", version: "1.0" },
                  hostContext,
                },
              },
            });
          });
        }
      },
    };

    g.window = {
      parent: parentTarget,
      innerWidth: 380,
      requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
      addEventListener(type: string, fn: (ev: unknown) => void) { listeners.set(type, fn); },
      removeEventListener(type: string) { listeners.delete(type); },
    };
    g.document = {
      documentElement: { style: { height: "" }, getAttribute: () => null, setAttribute: () => {}, getBoundingClientRect: () => ({ height: 320 }) },
      body: { style: {} },
    };
    g.ResizeObserver = class {
      observe(): void { observedCount += 1; }
      disconnect(): void {}
    };
    g.requestAnimationFrame = (fn: () => void) => { fn(); return 1; };

    try {
      const bridge = new App({ name: "context-radar-mcp", version: "1.0.0" }, {}, opts);
      await bridge.connect();
      bridge.close();
      return { sent, observedCount };
    } finally {
      g.window = origWin;
      g.document = origDoc;
      g.ResizeObserver = origRO;
      g.requestAnimationFrame = origRAF;
    }
  }

  const paneRes = await runConnect({ theme: "dark", displayMode: "inline" });
  assert.equal(paneRes.observedCount, 0, "aux_pane/global must not create ResizeObserver");
  assert.equal(paneRes.sent.some((m) => m.method === "ui/notifications/size-changed"), false);

  const inlineRes = await runConnect({ theme: "dark", displayMode: "inline", containerDimensions: { maxHeight: 600 } });
  assert.ok(inlineRes.observedCount > 0, "inline view should observe size changes");
  assert.equal(inlineRes.sent.some((m) => m.method === "ui/notifications/size-changed"), true);
});

test("kit/bridge.ts ignores transparent or translucent --color-background-primary and parseColorLum rejects low alpha", async () => {
  const { applyHostStyleVariables, parseColorLum } = await import(BRIDGE_TS);
  const applied = new Map<string, string>();
  const mockTarget = { style: { setProperty(k: string, v: string) { applied.set(k, v); } } };

  for (const badBg of [
    "", "   ", "transparent", "TRANSPARENT", "rgba(0, 0, 0, 0)",
    "rgba(11, 13, 18, 0.5)", "rgba(11, 13, 18, 0.89)", "rgb(11 13 18 / 0)",
    "rgb(11 13 18 / 50%)", "hsla(0, 0%, 10%, 0.4)", "#0B0D1200", "#0B0D1280", "#0000",
  ]) {
    applied.clear();
    applyHostStyleVariables({ "--color-background-primary": badBg, "--color-text-primary": "#F2F4F8" }, mockTarget);
    assert.equal(applied.has("--color-background-primary"), false, `must ignore unsafe bg=${JSON.stringify(badBg)}`);
    assert.equal(applied.get("--color-text-primary"), "#F2F4F8");
  }

  for (const okBg of ["#0B0D12", "#F8FAFD", "#0B0D12ff", "#0B0D12f0", "rgb(11, 13, 18)", "rgba(11, 13, 18, 1)", "rgba(11, 13, 18, 0.95)", "rgb(11 13 18 / 100%)"]) {
    applied.clear();
    applyHostStyleVariables({ "--color-background-primary": okBg }, mockTarget);
    assert.equal(applied.get("--color-background-primary"), okBg);
  }

  assert.equal(parseColorLum("transparent"), null);
  assert.equal(parseColorLum("rgba(255, 255, 255, 0)"), null);
  assert.equal(parseColorLum("rgba(255, 255, 255, 0.49)"), null);
  assert.equal(parseColorLum("rgb(255 255 255 / 20%)"), null);
  assert.equal(parseColorLum("#ffffff00"), null);
  assert.equal(parseColorLum("#ffffff7f"), null);
  assert.equal(parseColorLum("#fff0"), null);
  assert.ok((parseColorLum("#0B0D12") ?? 1) < 0.15);
  assert.ok((parseColorLum("#F8FAFD") ?? 0) > 0.9);
  assert.ok((parseColorLum("rgba(11, 13, 18, 0.8)") ?? 1) < 0.15);
  assert.ok((parseColorLum("#f8fafdcc") ?? 0) > 0.9);
});

test("auto_compact gating enforces inline ownership, side-pane canDirectCid, subagent/auto flags, and official ui/message without target:new", async () => {
  const viewSrc = fs.readFileSync(VIEW_TS, "utf8");
  const normWsM = viewSrc.match(/const normWs = [^\n]+;\n/);
  const sameWsM = viewSrc.match(/const sameWs = [^\n]+;\n/);
  const getHeroM = viewSrc.match(/const getHero = [^\n]+;\n/);
  const canDirectM = viewSrc.match(/const canDirectCid = [^\n]+;\n/);
  const canAutoM = viewSrc.match(/function canAutoRelay\([\s\S]*?\n\}/);
  const maybeAutoM = viewSrc.match(/function maybeAutoRelay\([\s\S]*?\n\}/);
  const execM = viewSrc.match(/async function executeDispatch\([\s\S]*?\n\}/);
  assert.ok(normWsM && sameWsM && getHeroM && canDirectM && canAutoM && maybeAutoM && execM, "view.ts must define auto_compact helpers");

  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const sentMessages: Array<{ text: string; meta: unknown }> = [];
  const uiActions: Array<Record<string, unknown>> = [];
  const copied: string[] = [];
  const sandbox = {
    D: { hidden: false }, S: String,
    AG_M: "com.google.antigravity/message",
    K_CID: "conversation_id", K_HCID: "handoff_conversation_id", K_AAH: "allow_auto_handoff",
    K_RSC: "running_subagent_count", K_LCT: "latest_context_tokens", K_GID: "grant_id",
    K_CC: "compact_command", K_CS: "compact_status", K_WS: "workspace", K_WSS: "workspaces",
    K_DW: "daemon_workspace", K_AR: "archived", K_ACT: "is_active", K_HP: "handoff_prompt",
    K_ERR: "isError", K_RC: "record_compact",
    L: (i: number) => `L${i}`, num: (v: unknown) => Number(v) || 0, tr: (e: string) => e,
    canMessage: true, canCallTools: true, allowAutoHandoff: true, ownerCid: "",
    snapshot: {
      daemon_workspace: "/ws/a",
      summary: { running_main_count: 1 },
      sessions: [{ id: "c1", is_active: true, workspace: "/ws/a" }],
      pending_grant: null as Record<string, unknown> | null,
    },
    handoffCard: null as Record<string, unknown> | null, handoffStatus: "pending", busyGrantId: null as string | null,
    attemptedGrants: new Set<string>(), autoCmpTimer: null as unknown,
    pg: () => sandbox.snapshot?.pending_grant,
    cancelAutoCmp: () => { sandbox.autoCmpTimer = null; },
    isHandoffLocked: () => /^(sen|com|old)/.test(sandbox.handoffStatus),
    st: (fn: () => void, ms: number) => { const h = { fn, ms, cancelled: false }; timers.push(h); return h; },
    ct: (h: { cancelled: boolean } | null) => { if (h) h.cancelled = true; },
    render: () => {}, flashMicro: () => {},
    cpCompact: async (cmd: string) => { copied.push(cmd); return true; },
    copyText: async (txt: string) => { copied.push(txt); return true; },
    extractRelayCid: () => "",
    uiSc: async (args: Record<string, unknown>) => { uiActions.push(args); return { claimed: true }; },
    recAct: async (action: string, gid: string, extra?: Record<string, unknown>) => { uiActions.push({ action, grant_id: gid, ...extra }); },
    sendTxt: async (text: string, meta: unknown) => { sentMessages.push({ text, meta }); return sandbox._sendReply(); },
    _sendReply: (): Record<string, unknown> => ({ isError: false }),
    canAutoRelay: null as unknown as (p: Record<string, unknown>, isInline: boolean) => string,
    maybeAutoRelay: null as unknown as (p: Record<string, unknown>, isInline: boolean) => void,
    executeDispatch: null as unknown as (p: Record<string, unknown>, m: string, i: boolean, c: boolean) => Promise<void>,
  };

  vm.runInNewContext(
    stripTs(`${normWsM[0]}\n${sameWsM[0]}\n${getHeroM[0]}\n${canDirectM[0]}\n${canAutoM[0]}\n${maybeAutoM[0]}\n${execM[0]}`) +
      `\nthis.canAutoRelay=canAutoRelay;this.maybeAutoRelay=maybeAutoRelay;this.executeDispatch=executeDispatch;`,
    sandbox
  );

  const mkGrant = (ov: Record<string, unknown> = {}) => ({
    grant_id: "g1", kind: "compact", conversation_id: "c1", workspace: "/ws/a",
    compact_command: "/compact preserve X", handoff_prompt: "handoff...",
    auto_fire: true, allow_auto_handoff: true, acp_proxy_active: false,
    claimed: false, compact_status: "", handoff_conversation_id: "", running_subagent_count: 0,
    ...ov,
  });

  // 1. Inline card allows auto_compact even when running_main_count > 1
  sandbox.snapshot.summary.running_main_count = 3;
  assert.equal(sandbox.canAutoRelay(mkGrant(), true), "auto_compact");
  assert.equal(sandbox.canAutoRelay(mkGrant({ running_subagent_count: 1 }), true), "");
  assert.equal(sandbox.canAutoRelay(mkGrant({ auto_fire: false }), true), "");
  assert.equal(sandbox.canAutoRelay(mkGrant({ allow_auto_handoff: false }), true), "");
  assert.equal(sandbox.canAutoRelay(mkGrant({ claimed: true }), true), "");
  assert.equal(sandbox.canAutoRelay(mkGrant({ compact_status: "sent" }), true), "");
  assert.equal(sandbox.canAutoRelay(mkGrant({ acp_proxy_active: true }), true), "");

  // 2. Side pane (isInline=false) enforces canDirectCid
  assert.equal(sandbox.canAutoRelay(mkGrant(), false), "");
  sandbox.ownerCid = "c1";
  assert.equal(sandbox.canAutoRelay(mkGrant(), false), "auto_compact");
  assert.equal(sandbox.canAutoRelay(mkGrant({ acp_proxy_active: true }), false), "");
  sandbox.snapshot.daemon_workspace = "/ws/My Project";
  assert.equal(sandbox.canAutoRelay(mkGrant({ workspace: "file:///ws/My%20Project/" }), false), "auto_compact");
  sandbox.snapshot.daemon_workspace = "/ws/a";
  sandbox.ownerCid = "c-other";
  assert.equal(sandbox.canAutoRelay(mkGrant(), false), "");
  sandbox.ownerCid = "";
  sandbox.snapshot.summary.running_main_count = 1;
  assert.equal(sandbox.canAutoRelay(mkGrant(), false), "auto_compact");
  assert.equal(sandbox.canAutoRelay(mkGrant({ workspace: "/ws/other" }), false), "");
  sandbox.allowAutoHandoff = false;
  assert.equal(sandbox.canAutoRelay(mkGrant(), false), "");
  sandbox.allowAutoHandoff = true;

  // 3. Inline maybeAutoRelay waits 1500ms, claims with inline ws, sends ui/message without target:new
  const gInline = mkGrant({ grant_id: "g-inline", workspace: "/ws/inline-card" });
  sandbox.handoffCard = gInline;
  sandbox.handoffStatus = "pending";
  sandbox.maybeAutoRelay(gInline, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1500);
  assert.equal(sentMessages.length, 0);
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
  timers[0].fn();
  await flush();
  assert.equal(uiActions[0].action, "claim_grant");
  assert.equal(uiActions[0].workspace, "/ws/inline-card");
  assert.equal(uiActions[0].claim_mode, "auto_compact");
  assert.deepEqual(sentMessages[0], { text: "/compact preserve X", meta: 0 });
  assert.deepEqual(uiActions[1], { action: "record_compact", grant_id: "g-inline", status: "sent" });
  assert.equal(sandbox.handoffStatus, "compacted");

  // 4. Side-pane auto_compact waits 2000ms and records fallback_copied on host isError
  uiActions.length = 0; sentMessages.length = 0; copied.length = 0; timers.length = 0;
  const gPane = mkGrant({ grant_id: "g-pane" });
  sandbox.snapshot.pending_grant = gPane;
  sandbox._sendReply = () => ({ isError: true, content: [{ type: "text", text: "host rejected" }] });
  sandbox.maybeAutoRelay(gPane, false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  timers[0].fn();
  await flush();
  assert.equal(uiActions[0].claim_mode, "auto_compact");
  assert.deepEqual(uiActions[1], { action: "record_compact", grant_id: "g-pane", status: "fallback_copied:host rejected" });
  assert.deepEqual(copied, ["/compact preserve X"]);

  // 5. Exception during ui/message records error detail and falls back to clipboard copy
  uiActions.length = 0; copied.length = 0;
  sandbox._sendReply = () => { throw new Error("Method not found"); };
  await sandbox.executeDispatch(mkGrant({ grant_id: "g-err" }), "auto_compact", true, true);
  assert.deepEqual(uiActions[1], { action: "record_compact", grant_id: "g-err", status: "error:Method not found" });
  assert.deepEqual(copied, ["/compact preserve X"]);

  // 6. When canCallTools=false or grant_id is missing, NEVER skip claim_grant and fire ui/message!
  uiActions.length = 0; sentMessages.length = 0; copied.length = 0;
  sandbox._sendReply = () => ({ isError: false });
  sandbox.canCallTools = false;
  assert.equal(sandbox.canAutoRelay(mkGrant(), true), "", "canAutoRelay must block when canCallTools=false");
  await sandbox.executeDispatch(mkGrant({ grant_id: "g-no-tools" }), "manual_compact", false, true);
  assert.equal(sentMessages.length, 0, "must NOT send ui/message when canCallTools=false");
  assert.equal(uiActions.length, 0, "must NOT call tools when canCallTools=false");
  assert.deepEqual(copied, ["/compact preserve X"]);

  sandbox.canCallTools = true;
  copied.length = 0;
  await sandbox.executeDispatch(mkGrant({ grant_id: "" }), "manual_handoff", true, false);
  assert.equal(sentMessages.length, 0, "must NOT send ui/message when grant_id is missing");
  assert.equal(uiActions.length, 0);
});

test("non-force periodic poll updates DOM on digest change, skips render on unchanged, clears error on recovery, and uses 15s timeout", async () => {
  const viewSrc = fs.readFileSync(VIEW_TS, "utf8");
  const applyM = viewSrc.match(/function applySnapshot\([\s\S]*?\n\}/);
  const refreshM = viewSrc.match(/async function refreshSnapshot\([\s\S]*?\n\}/);
  assert.ok(applyM && refreshM, "view.ts must define applySnapshot and refreshSnapshot");

  let renderedTokens = 100000;
  let renderCount = 0;
  const calls: Array<{ name: string; args: Record<string, unknown>; opts?: { timeout?: number } }> = [];
  const replyQueue: Array<Record<string, unknown>> = [];

  const sandbox = {
    DB: "dashboard", D: { hidden: false }, DE: { lang: "en" }, M: Math,
    performance: { now: () => 100 }, now: () => 1000, st: () => 1, ct: () => {},
    num: (v: unknown) => Number(v) || 0, tr: (e: string) => e, L: (i: number) => `L${i}`, parseLoc: () => "",
    K_AAH: "allow_auto_handoff", K_ST: "settings", K_PG: "pending_grant", K_DIG: "digest",
    K_AR: "archived", K_SN0: "snapshot", K_PF: "context_radar_", K_SC2: "structuredContent",
    K_SM: "server_ms", K_ERR: "isError", K_GA: "generated_at", K_PG2: "pending_grant",
    K_US: "ui_settings", K_TH: "theme", K_LHT: "last_host_theme", themeLocked: true, themePref: "system", lastHostTheme: "dark", bridge: {},
    parseTheme: (v: unknown) => (v === "light" || v === "dark" ? v : "system"),
    parseHostTheme: (v: unknown) => (v === "light" ? "light" : "dark"),
    viewMode: "dashboard", canCallTools: true, inFlightPoll: false, queuedForce: false, pollSeq: 0, inFlightSeq: 0,
    refreshing: false, showSpinner: false, spinTimer: null, filterTab: "active",
    lastDigest: "d1",
    snapshot: { mode: "snapshot", digest: "d1", sessions: [{ id: "c1", latest_context_tokens: 100000 }] },
    loadingInitial: false, errorText: "", serverMs: 0, ewmaRttMs: null,
    pollErrors: 0, lastSyncTs: 0, unchangedHits: 0, langLocked: true, lang: "en", allowAutoHandoff: true,
    cancelPoll: () => {}, scheduleNextPoll: () => {}, maybeAutoRelay: () => {}, flashMicro: () => {},
    render: () => {
      renderCount += 1;
      renderedTokens = sandbox.snapshot?.sessions?.[0]?.latest_context_tokens ?? renderedTokens;
    },
    callTool: async (name: string, args: Record<string, unknown>, opts?: { timeout?: number }) => {
      calls.push({ name, args, opts });
      return replyQueue.shift();
    },
    refreshSnapshot: null as unknown as (force: boolean) => Promise<void>,
  };

  vm.runInNewContext(stripTs(`${applyM[0]}\n${refreshM[0]}`) + `\nthis.refreshSnapshot = refreshSnapshot;`, sandbox);

  replyQueue.push({
    isError: false,
    structuredContent: { mode: "snapshot", digest: "d2", server_ms: 4, sessions: [{ id: "c1", latest_context_tokens: 245000 }] },
  });
  await sandbox.refreshSnapshot(false);
  assert.equal(calls[0].name, "context_radar_overview");
  assert.equal(calls[0].args.if_digest, "d1");
  assert.equal(calls[0].opts?.timeout, 15000);
  assert.equal(renderCount, 1);
  assert.equal(renderedTokens, 245000);
  assert.equal(sandbox.lastDigest, "d2");

  replyQueue.push({ isError: false, structuredContent: { mode: "snapshot", unchanged: true, digest: "d2", server_ms: 2 } });
  await sandbox.refreshSnapshot(false);
  assert.equal(renderCount, 1);
  assert.equal(sandbox.unchangedHits, 1);

  sandbox.errorText = "Sync: timeout";
  replyQueue.push({ isError: false, structuredContent: { mode: "snapshot", unchanged: true, digest: "d2", server_ms: 2 } });
  await sandbox.refreshSnapshot(false);
  assert.equal(sandbox.errorText, "");
  assert.equal(renderCount, 2);
});

test("kept-alive pane reveal hooks (ResizeObserver, IntersectionObserver, onhostcontextchanged, pointerenter) trigger fresh overview refresh", () => {
  const viewSrc = fs.readFileSync(VIEW_TS, "utf8");
  const canForceM = viewSrc.match(/const canForceDb = [\s\S]*?;\n/);
  const forceNowM = viewSrc.match(/const forceNow = [\s\S]*?;\n/);
  const setupObsM = viewSrc.match(/function setupRevealObservers\([\s\S]*?\n\}/);
  const hostChgM = viewSrc.match(/bridge\.onhostcontextchanged = [\s\S]*?;\n/);
  const ptrM = viewSrc.match(/onD\("pointerenter"[\s\S]*?\);\n/);
  assert.ok(canForceM && forceNowM && setupObsM && hostChgM && ptrM);

  type RoCb = (es: Array<{ contentRect: { width: number; height: number } }>) => void;
  type IoCb = (es: Array<{ isIntersecting: boolean }>) => void;
  let roCb: RoCb | null = null;
  let ioCb: IoCb | null = null;
  let ptrCb: (() => void) | null = null;
  let fakeNow = 1000;
  const refreshes: Array<{ force: boolean; showSynced: boolean }> = [];
  const listeners: Record<string, { fn: () => void; opts?: { passive?: boolean } }> = {};
  const sandbox = {
    DB: "dashboard", D: { hidden: false }, DE: { clientWidth: 420, clientHeight: 800 },
    viewMode: "dashboard", canCallTools: true, lastForceTs: 0, lastSyncTs: 0,
    obsRo: null, obsIo: null, now: () => fakeNow,
    onD: (ev: string, fn: () => void, opts?: { passive?: boolean }) => { listeners[ev] = { fn, opts }; if (ev === "pointerenter") ptrCb = fn; },
    ResizeObserver: class { constructor(cb: RoCb) { roCb = cb; } observe() {} disconnect() {} },
    IntersectionObserver: class { constructor(cb: IoCb) { ioCb = cb; } observe() {} disconnect() {} },
    bridge: {} as { onhostcontextchanged?: (ctx: unknown) => void }, syncHostContext: () => {},
    refreshSnapshot: (force: boolean, showSynced: boolean) => { refreshes.push({ force, showSynced }); },
  };

  vm.runInNewContext(
    stripTs(`${canForceM[0]}\n${forceNowM[0]}\n${setupObsM[0]}\n${hostChgM[0]}\n${ptrM[0]}`) + `\nsetupRevealObservers();`,
    sandbox
  );

  (roCb as RoCb | null)?.([{ contentRect: { width: 0, height: 0 } }]);
  assert.equal(refreshes.length, 0);
  fakeNow += 500;
  (roCb as RoCb | null)?.([{ contentRect: { width: 420, height: 800 } }]);
  assert.deepEqual(refreshes, [{ force: true, showSynced: false }]);

  (ioCb as IoCb | null)?.([{ isIntersecting: false }]);
  assert.equal(refreshes.length, 1);
  fakeNow += 500;
  (ioCb as IoCb | null)?.([{ isIntersecting: true }]);
  assert.equal(refreshes.length, 2);

  fakeNow += 500;
  sandbox.bridge.onhostcontextchanged?.({ containerDimensions: { width: 420, height: 800 } });
  assert.equal(refreshes.length, 3);

  assert.equal(listeners.pointerenter?.opts?.passive, true);
  sandbox.lastSyncTs = fakeNow;
  fakeNow += 400;
  (ptrCb as (() => void) | null)?.();
  assert.equal(refreshes.length, 3);
  fakeNow += 600;
  (ptrCb as (() => void) | null)?.();
  assert.equal(refreshes.length, 4);
});

interface RenderState {
  uH: [MockEl, MockEl, MockEl, MockEl, MockEl, MockEl, MockEl, MockEl, unknown[], MockEl, MockEl, MockEl, unknown[]];
  uF: [MockEl, MockEl, MockEl, MockEl[], MockEl, MockEl];
  uPG: MockEl;
  uPGh: MockEl;
  uPLs: MockEl;
  uRG: MockEl;
  uRGh: MockEl;
  uLs: MockEl;
  uCap: MockEl;
  uSet: MockEl;
  uB: MockEl[];
  ui: unknown;
  rowNodes: Map<string, [MockEl, MockEl, MockEl[], MockEl, unknown[]]>;
  pinNodes: Map<string, unknown>;
  heroChipNodes: Map<string, unknown>;
  openTrays: Map<string, string>;
  cTurns: Map<string, unknown>;
  cHot: Map<string, unknown>;
}

interface RenderSandbox {
  render: () => void;
  fmtDur: (s: number) => string;
  errTxt: (r: unknown) => string;
  getLiveDot: (o: Record<string, unknown>) => string;
  getLivePhaseBadge: (o: Record<string, unknown>) => { cls: string; text: string } | null;
  coldKind: (t: Record<string, unknown>) => string;
  getCold: (o: Record<string, unknown>) => { t: number; m: number; p: number; s: number; r: number; w: number };
  buildSubTray: (o: Record<string, unknown>) => MockEl;
  patchHeroSlot: (o: Record<string, unknown>) => void;
  patchSessionList: (items: Array<[Record<string, unknown>, boolean]>) => void;
  setLang: (l: string) => void;
  setTab: (t: string) => void;
  setSnap: (s: Record<string, unknown>) => void;
  setOpen: (id: string) => void;
  setSettingsOpen: (v: boolean) => void;
  getState: () => RenderState;
}

function createRenderSandbox(initialLang = "en"): { sandbox: RenderSandbox; root: MockEl } {
  const viewSrc = fs.readFileSync(VIEW_TS, "utf8");
  const root = new MockEl("div");
  const docEl = new MockEl("html");
  const slice = viewSrc.slice(viewSrc.indexOf("// Shared DOM builder"), viewSrc.indexOf("const flashMicro ="));
  const sandbox = {
    D: {
      getElementById: (id: string) => (id === "app" ? root : null),
      createElement: (t: string) => new MockEl(t),
      createElementNS: (_ns: string, t: string) => new MockEl(t),
      createTextNode: (t: unknown) => new MockText(t),
      documentElement: docEl,
    },
    DE: docEl, M: Math, S: String, now: () => 10_000_000,
    NS: "svg",
    boot: { mode: "snapshot", lang: initialLang },
    st: () => 1, ct: () => {},
    bridge: {}, navigator: { language: initialLang },
    localStorage: { getItem: () => initialLang, setItem: () => {} },
    console,
  } as unknown as RenderSandbox;
  vm.runInNewContext(
    stripTs(slice) +
      `
this.render=render;
this.fmtDur=fmtDur;
this.errTxt=errTxt;
this.getLiveDot=getLiveDot;
this.getLivePhaseBadge=getLivePhaseBadge;
this.coldKind=coldKind;
this.getCold=getCold;
this.buildSubTray=buildSubTray;
this.patchHeroSlot=patchHeroSlot;
this.patchSessionList=patchSessionList;
this.setLang=(l)=>{lang=l;DE.lang=l;};
this.setTab=(t)=>{filterTab=t;};
this.setSnap=(s)=>{snapshot=s;};
this.setOpen=(id)=>{openRowId=id;};
this.setSettingsOpen=(v)=>{settingsOpen=!!v;settingsSig="";};
this.getState=()=>({uH,uF,uPG,uPGh,uPLs,uRG,uRGh,uLs,uCap,uSet,uB,ui,rowNodes,pinNodes,heroChipNodes,openTrays,cTurns,cHot});`,
    sandbox
  );
  return { sandbox, root };
}

const mkSess = (id: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title, level: "ok", is_active: false, pinned: false, archived: false,
  latest_context_tokens: 50000, context_limit: 512000, context_pct: 9.8,
  cache_hit_rate: 95, median_stream_tps: 120, latest_stream_tps: 999, e2e_tps: 60,
  cost_usd: 1.0, cost_cny: 7.2, turns: 10, subagents: [], ...extra,
});

test("rich live telemetry: 4-state dots, phase badges, headroom, KV cache meter, hotspots mini-bars, whisper notices, and backward compat", () => {
  const cssSrc = fs.readFileSync(THEME_CSS, "utf8");
  for (const cls of [".dt.run", ".dt.wait", ".dt.err"]) {
    assert.ok(cssSrc.includes(cls), `theme.css must style ${cls}`);
  }
  assert.ok(cssSrc.includes(".dt.run,.dt.wait{animation:kp"), "pulse animation must target .dt.run and .dt.wait");

  const { sandbox } = createRenderSandbox("en");

  // 1. 4-state live dot + backward-compat fallback
  assert.equal(sandbox.getLiveDot({ live_status: "ready", is_active: true }), "idle");
  assert.equal(sandbox.getLiveDot({ live_status: "running", is_active: false }), "run");
  assert.equal(sandbox.getLiveDot({ live_status: "waiting" }), "wait");
  assert.equal(sandbox.getLiveDot({ live_status: "error" }), "err");
  assert.equal(sandbox.getLiveDot({ is_active: true }), "run");
  assert.equal(sandbox.getLiveDot({ is_active: false }), "idle");

  // 2. Phase badges (EN + zh-CN)
  const pb = (o: Record<string, unknown>) => { const r = sandbox.getLivePhaseBadge(o); return r ? { cls: r.cls, text: r.text } : null; };
  assert.deepEqual(pb({ live_status: "running", live_phase: "compacting", live_elapsed_sec: 12 }), { cls: "in", text: "Compacting · 12s" });
  assert.deepEqual(pb({ live_status: "waiting", live_phase: "compacting", live_elapsed_sec: 0 }), { cls: "wn", text: "Compacting" });
  assert.deepEqual(pb({ live_status: "waiting", live_phase: "llm", live_elapsed_sec: 50 }), { cls: "wn", text: "Waiting · 50s" });
  assert.deepEqual(pb({ live_status: "error" }), { cls: "er", text: "Error" });
  assert.equal(pb({ live_status: "running", live_phase: "llm", live_elapsed_sec: 5 }), null);
  assert.equal(pb({ is_active: false }), null);

  sandbox.setLang("zh-CN");
  assert.deepEqual(pb({ live_status: "running", live_phase: "compacting", live_elapsed_sec: 8 }), { cls: "in", text: "正在压缩 · 8 秒" });
  assert.deepEqual(pb({ live_status: "waiting", live_elapsed_sec: 50 }), { cls: "wn", text: "等待中 · 50 秒" });
  assert.deepEqual(pb({ live_status: "error" }), { cls: "er", text: "出错" });

  // 3. Render rich Hero with parallel concurrency badge folded into hero header
  sandbox.setLang("en");
  const richHero = {
    id: "c-rich", title: "Rich Session", level: "ok", is_active: true,
    live_status: "waiting", live_phase: "compacting", live_elapsed_sec: 50,
    cross_model_compact: true,
    latest_context_tokens: 244000, context_limit: 512000, context_pct: 48.0,
    remaining_context_tokens: 268000, peak_context_tokens: 340000,
    just_compacted: true, pre_compact_tokens: 340000, compact_summary_kb: 21.9,
    cache_hit_rate: 92.5, cold_cache_count: 0,
    latest_ttft_ms: 1400, latest_stream_tps: 64, e2e_tps: 41, checkpoint_count: 2,
    total_thinking_tokens: 9656, total_response_tokens: 4544, thinking_share_pct: 68,
    last_loop_steps: 6, last_loop_output_tokens: 4800, last_loop_thinking_tokens: 3200,
    last_loop_cost_usd: 0.42, last_loop_cost_cny: 3.02,
    cost_usd: 1.85, cost_cny: 13.32, turns: 14, subagents: [],
  };
  sandbox.setSnap({
    mode: "snapshot", generated_at: "2026-11-24T18:15:27Z",
    summary: { shown_main_count: 1, running_main_count: 1, active_carbon_count: 3, carbon_concurrency_warning: true },
    sessions: [richHero], orphan_subagents: [],
  });
  sandbox.render();
  const st = sandbox.getState();
  const [, hDt, , , hPh, hCw, , , hBlk] = st.uH;
  assert.equal(hDt.className, "dt wait");
  assert.equal(hPh.hidden, false);
  assert.equal(hPh.className, "bd wn");
  assert.equal(hPh.textContent, "Compacting · 50s");
  assert.equal(hCw.hidden, false);
  assert.equal(hCw.textContent, "3 in parallel");
  assert.ok(hCw.title.includes("more than 2 large agents"));

  const [, hn, hs, , , , g1, g2, , k1, k2, ws, tmEl, wnEl] = hBlk as [
    MockEl, MockEl, MockEl, MockEl, MockEl, MockEl[], MockEl, MockEl, MockEl, MockEl, MockEl, MockEl[][], MockEl, MockEl
  ];
  assert.equal(hn.textContent, "48.0%");
  assert.equal(hs.textContent, "244.0k / 512.0k");
  assert.equal(g1.textContent, "268.0k left");
  assert.equal(g2.textContent, "Before compact 340.0k · ~21.9 KB");
  assert.equal(k1.textContent, "Cache hit 92.5%");
  assert.equal(k2.textContent, "$1.85 · 64/41 tok/s");
  assert.equal(ws[2][2].textContent, "TTFT 1.4s · 64/41 tok/s");
  assert.ok(ws[2][0].title.includes("Output 64 · Overall 41 tok/s"));
  assert.equal(tmEl.hidden, false);
  assert.equal(tmEl.textContent, "Output 14.2k (68% thinking) · 6 steps this turn · 4.8k · $0.42");
  assert.equal(wnEl.hidden, false);
  assert.equal(wnEl.getAttribute("data-k"), "wn");
  assert.equal(wnEl.textContent, "Compacting with a different model can't reuse the cache, so it'll be slower.");

  // 4. zh-CN formatting + XSS-safe live_error notice with Details disclosure
  sandbox.setLang("zh-CN");
  const errRow = mkSess("c-err", "Broken Run", {
    level: "critical", live_status: "error",
    live_error: '<script>alert("xss")</script> Upstream 429',
    latest_context_tokens: 100000, context_limit: 512000, context_pct: 19.5,
    total_thinking_tokens: 680, total_response_tokens: 320,
    last_loop_steps: 6, last_loop_output_tokens: 4800, last_loop_cost_usd: 0.42, last_loop_cost_cny: 3.02,
    turns: 4,
  });
  sandbox.setOpen("c-err");
  sandbox.patchSessionList([[errRow, false]]);
  const rec = st.rowNodes.get("c-err")!;
  const [, , [, rDot, , , , rPhase], trBox] = rec;
  assert.equal(rDot.className, "dt err");
  assert.equal(rPhase.hidden, false);
  assert.equal(rPhase.className, "bd er");
  assert.equal(rPhase.textContent, "出错");
  const rowD = rec[4] as MockEl[];
  assert.equal(rowD[6].textContent, "剩 412.0k");
  assert.equal(rowD[12].textContent, "输出 1.0k（思考 68%） · 本轮 6 步 · 4.8k · ¥3.02");
  assert.equal(rowD[13].hidden, false);
  assert.equal(rowD[13].getAttribute("data-k"), "er");
  assert.ok(rowD[13].textContent.includes("有一步执行失败。"));
  assert.ok(rowD[13].textContent.includes("详情"));
  assert.ok(rowD[13].textContent.includes('<script>alert("xss")</script> Upstream 429'));
  assert.equal(trBox.hidden, false);

  // 5. Backward compatibility when optional fields are absent
  sandbox.setLang("en");
  const legacySession = {
    id: "c-old", title: "Legacy", level: "ok", is_active: false,
    latest_context_tokens: 120000, context_limit: 500000, context_pct: 24.0,
    cache_hit_rate: 80, median_ttft_ms: 900, median_stream_tps: 55,
    cost_usd: 0.5, cost_cny: 3.6, turns: 5,
  };
  sandbox.patchHeroSlot(legacySession);
  assert.equal(hDt.className, "dt idle");
  assert.equal(hPh.hidden, true);
  assert.equal(hn.textContent, "24.0%");
  assert.equal(hs.textContent, "120.0k / 500.0k");
  assert.equal(g1.textContent, "380.0k left");
  assert.equal(g2.textContent, "5 turns");
  assert.equal(ws[2][2].textContent, "TTFT 900ms · 55 tok/s");
  assert.equal(tmEl.hidden, true);
  assert.equal(wnEl.hidden, true);

  // 6. Turns & Hotspots sub-trays built with DOM nodes (zero <table>)
  st.openTrays.set("c-rich", "turns");
  st.cTurns.set("c-rich", {
    total_turns: 2,
    turns: [
      { turn: 2, time_iso: "2026-11-24T08:50:00Z", context_tokens: 244000, cache_hit_rate: 95, ttft_ms: 1400, stream_tps: 64, e2e_tps: 41, thinking_tokens: 680, response_tokens: 320, cost_usd: 0.12, cost_cny: 0.86 },
      { turn: 1, time_iso: "2026-11-24T08:48:00Z", context_tokens: 120000, cache_hit_rate: 50, ttft_ms: 900, stream_tps: 50, thinking_tokens: 717, response_tokens: 0, cost_usd: 0.05, cost_cny: 0.36 },
    ],
  });
  const turnsEl = sandbox.buildSubTray(richHero);
  assert.equal(turnsEl.findAll((e) => e.tag === "table").length, 0, "turns tray must not render <table>");
  assert.ok(turnsEl.textContent.includes("T68%"));
  assert.ok(turnsEl.textContent.includes("thinking 717"));
  assert.ok(turnsEl.textContent.includes("1.4s · 64/41"));

  st.openTrays.set("c-rich", "hotspots");
  st.cHot.set("c-rich", {
    found: true,
    recommended_distill_range: [10, 24],
    hotspots: [
      { turn: 8, step_idx: 19, delta_tokens: 42000, context_after: 210000, cause: "large_read" },
      { turn: 5, step_idx: 12, delta_tokens: 18000, context_after: 150000, cause: "tool_dump" },
    ],
  });
  const hotEl = sandbox.buildSubTray(richHero);
  assert.equal(hotEl.findAll((e) => e.tag === "table").length, 0, "hotspots tray must use mini-bars, never <table>");
  assert.ok(hotEl.findAll((e) => e.className.includes("bf")).length === 2, "hotspots tray must render 2 mini-bar fills");
  assert.ok(hotEl.textContent.includes("#8") && hotEl.textContent.includes("+42.0k"));

  // 7. Bilingual mid-loop sub-reasons & getCold
  sandbox.setLang("en");
  assert.equal(sandbox.coldKind({ cold_cache_kind: "mid_loop_cold", cold_cache_sub_reason: "slow_turn_self_expiry" }), "Cache expired");
  assert.equal(sandbox.coldKind({ cold_cache_kind: "mid_loop_cold", cold_cache_sub_reason: "replica_spillover" }), "Cache dropped");
  assert.equal(sandbox.coldKind({ cold_cache_kind: "mid_loop_cold", cold_cache_sub_reason: "model_switch_cold" }), "Model switched");
  sandbox.setLang("zh-CN");
  assert.equal(sandbox.coldKind({ cold_cache_kind: "mid_loop_cold", cold_cache_sub_reason: "slow_turn_self_expiry" }), "缓存过期");
  assert.equal(sandbox.coldKind({ cold_cache_kind: "mid_loop_cold", cold_cache_sub_reason: "replica_spillover" }), "缓存被清");
  assert.equal(sandbox.coldKind({ cold_cache_kind: "mid_loop_cold", cold_cache_sub_reason: "model_switch_cold" }), "换了模型");
  const parsedCold = sandbox.getCold({
    cold_cache_breakdown: { turn_start_cold: 1, mid_loop_cold: 3, post_compact_cold: 0 },
    mid_loop_breakdown: { slow_turn_self_expiry: 1, replica_spillover: 1, model_switch_cold: 1 },
  });
  assert.deepEqual({ t: parsedCold.t, m: parsedCold.m, p: parsedCold.p, s: parsedCold.s, r: parsedCold.r, w: parsedCold.w }, { t: 1, m: 3, p: 0, s: 1, r: 1, w: 1 });

  // 8. Panel gauge tone follows backend level 1:1 (no premature red at 85% when urgent_ctx is 440k/460k)
  sandbox.setLang("en");
  sandbox.patchHeroSlot(mkSess("c-warn-86", "Flagship 438k", {
    level: "warn", suggest_compact: true, latest_context_tokens: 438000, context_limit: 512000, context_pct: 85.5,
    min_compact_tokens: 310000, recommend_compact_tokens: 370000, urgent_compact_tokens: 440000,
  }));
  assert.equal(hn.className, "hn wn", "438k/512k warn session below 440k urgent_ctx must stay warn, not red");
  assert.equal((hBlk[4] as MockEl).className, "bf wn");
  sandbox.patchHeroSlot(mkSess("c-crit-440", "Flagship 440k", {
    level: "critical", suggest_compact: true, latest_context_tokens: 440000, context_limit: 512000, context_pct: 85.9,
    min_compact_tokens: 310000, recommend_compact_tokens: 370000, urgent_compact_tokens: 440000,
  }));
  assert.equal(hn.className, "hn er", "440k/512k critical session at urgent_ctx must render red");
  assert.equal((hBlk[4] as MockEl).className, "bf er");
});

test("hero docks subagents inside .hero without negative margins, separates Pinned vs Recent cards cleanly, and preserves tab counts", () => {
  const cssSrc = fs.readFileSync(THEME_CSS, "utf8");
  assert.ok(/\.dl\b[^{]*\{display:flex;flex-direction:column\}/.test(cssSrc), ".dl must have display:flex;flex-direction:column");
  assert.equal(cssSrc.includes("-12px"), false, "Subagent Dock must have zero negative margins");
  assert.ok(cssSrc.includes(".rw.sub{margin-left:12px;border-left:2px solid var(--l2)}"), "subagent rows must indent 12px with --l2 rule");

  const { sandbox } = createRenderSandbox("zh-CN");
  const subHero = mkSess("sub-hero", "release-pool-v0264", { is_active: true, is_subagent: true, latest_context_tokens: 166600 });
  const subHeroOld = mkSess("sub-hero-old", "old-worker", { is_active: false, is_subagent: true, latest_context_tokens: 40000 });
  const subOther = mkSess("sub-other", "glm-rollout-wave1", { is_active: true, is_subagent: true, latest_context_tokens: 293600 });

  sandbox.setSnap({
    mode: "snapshot",
    generated_at: "2026-11-24T18:15:27Z",
    summary: { shown_main_count: 4, running_main_count: 2, shown_subagent_count: 2, history_subagents_hidden_count: 8, archived_hidden_count: 12 },
    sessions: [
      mkSess("p1", "T7 Disk", { pinned: true }),
      mkSess("p2", "Shared Memory", { pinned: true }),
      mkSess("hero", "Swarm & Sub", { is_active: true, model_short: "Gemini 4 Standard XH", running_subagent_count: 1, subagents: [subHero, subHeroOld] }),
      mkSess("m2", "AI Interaction Review", { is_active: true, running_subagent_count: 1, subagents: [subOther] }),
    ],
    orphan_subagents: [],
  });

  // 1. Sessions tab with BOTH pinned & unpinned non-hero sessions -> TWO separate cards with quiet group headers!
  sandbox.render();
  const st = sandbox.getState();
  const [he, , , hMd, , , , , , hDk, hCh, hST] = st.uH;
  const [, , , tabs] = st.uF;
  assert.equal(he.hidden, false);
  assert.equal(hMd.className, "bd t3");
  assert.equal(hDk.hidden, false, "hero Subagent Dock must be visible inside .hero");
  assert.deepEqual(hCh.children.map((e) => e.dataset.i), ["sub-hero"], "only hero's active subagent docks as chip in .hero");

  // Pinned group vs Recent group separated cleanly
  assert.equal(st.uPG.hidden, false, "Pinned card group must be visible when both pinned and unpinned exist");
  assert.equal(st.uPGh.hidden, false);
  assert.equal(st.uPGh.textContent, "置顶 · 2");
  assert.deepEqual(st.uPLs.children.map((e) => e.dataset.i), ["p1", "p2"]);

  assert.equal(st.uRG.hidden, false, "Recent card group must be visible");
  assert.equal(st.uRGh.hidden, false);
  assert.equal(st.uRGh.textContent, "最近 · 1");
  assert.deepEqual(st.uLs.children.map((e) => e.dataset.i), ["m2", "sub-other"], "hero's subagent MUST NOT leak into list, nested subagent stays under parent");

  // Check EN group headers too
  sandbox.setLang("en");
  sandbox.render();
  assert.equal(st.uPGh.textContent, "Pinned · 2");
  assert.equal(st.uRGh.textContent, "Recent · 1");

  sandbox.setLang("zh-CN");
  sandbox.render();
  assert.equal(tabs[0].textContent, "会话 (4)");
  assert.equal(tabs[1].textContent, "子代理 (10)");
  assert.equal(tabs[2].textContent, "已归档 (12)");

  // 2. Clicking a docked hero subagent chip expands its detail tray inside .hero
  sandbox.setOpen("sub-hero");
  sandbox.render();
  assert.equal(hST.hidden, false, "clicking docked hero subagent chip must expand detail tray inside hero");
  assert.ok(((st.uH[12][11] as MockEl[][])[2][2]).textContent.includes("120/60 tok/s"), "must prefer steady median_stream_tps over spiky latest_stream_tps");

  // 3. When ONLY unpinned sessions exist -> hide Pinned group & redundant Recent header (single clean card)
  sandbox.setSnap({
    mode: "snapshot", generated_at: "2026-11-24T18:15:27Z",
    summary: { shown_main_count: 2, running_main_count: 1, shown_subagent_count: 0, history_subagents_hidden_count: 0, archived_hidden_count: 0 },
    sessions: [mkSess("hero", "Active Hero", { is_active: true }), mkSess("m2", "Only Recent")],
    orphan_subagents: [],
  });
  sandbox.render();
  assert.equal(st.uPG.hidden, true, "Pinned group hides when no pinned sessions");
  assert.equal(st.uRG.hidden, false);
  assert.equal(st.uRGh.hidden, true, "Recent group header hides when only one group exists");
  assert.deepEqual(st.uLs.children.map((e) => e.dataset.i), ["m2"]);

  // 4. When ONLY pinned sessions exist -> single clean card, no redundant group headers
  sandbox.setSnap({
    mode: "snapshot", generated_at: "2026-11-24T18:15:27Z",
    summary: { shown_main_count: 2, running_main_count: 1, shown_subagent_count: 0, history_subagents_hidden_count: 0, archived_hidden_count: 0 },
    sessions: [mkSess("hero", "Active Hero", { is_active: true }), mkSess("p1", "Only Pinned", { pinned: true })],
    orphan_subagents: [],
  });
  sandbox.render();
  assert.equal(st.uPG.hidden, true);
  assert.equal(st.uRG.hidden, false);
  assert.equal(st.uRGh.hidden, true);
  assert.deepEqual(st.uLs.children.map((e) => e.dataset.i), ["p1"]);

  // 5. Subagents tab: hides Hero & group headers, shows parents with subagents
  sandbox.setSnap({
    mode: "snapshot", generated_at: "2026-11-24T18:15:27Z",
    summary: { shown_main_count: 4, running_main_count: 2, shown_subagent_count: 2, history_subagents_hidden_count: 8, archived_hidden_count: 12 },
    sessions: [
      mkSess("p1", "T7 Disk", { pinned: true }),
      mkSess("hero", "Swarm & Sub", { is_active: true, subagents: [subHero, subHeroOld] }),
      mkSess("m2", "AI Review", { is_active: true, subagents: [subOther] }),
    ],
    orphan_subagents: [],
  });
  sandbox.setTab("subs");
  sandbox.render();
  assert.equal(he.hidden, true);
  assert.equal(st.uPG.hidden, true);
  assert.equal(st.uRGh.hidden, true);
  assert.deepEqual(st.uLs.children.map((e) => e.dataset.i), ["hero", "sub-hero", "sub-hero-old", "m2", "sub-other"]);

  // 6. Archived tab: hides Hero & group headers, preserves tab counts
  sandbox.setSnap({
    mode: "snapshot", generated_at: "2026-11-24T18:15:27Z",
    summary: { shown_main_count: 5, running_main_count: 1, shown_subagent_count: 0, history_subagents_hidden_count: 0, archived_hidden_count: 0 },
    sessions: [
      mkSess("p1", "T7 Disk", { pinned: true }),
      mkSess("arch1", "Old Task", { archived: true }),
      mkSess("arch2", "Old Task 2", { archived: true }),
    ],
    orphan_subagents: [],
  });
  sandbox.setTab("archived");
  sandbox.render();
  assert.equal(he.hidden, true);
  assert.equal(st.uPG.hidden, true);
  assert.equal(st.uRGh.hidden, true);
  assert.deepEqual(st.uLs.children.map((e) => e.dataset.i), ["arch1", "arch2"]);
  assert.equal(tabs[0].textContent, "会话 (1)");
  assert.equal(tabs[2].textContent, "已归档 (2)");

  // 7. Pinned-only mains + active orphan subagent: stays single card (no bogus "Recent · 1") and keeps orphan visible
  const orphan = mkSess("orp-1", "Orphan Worker", { is_active: true, is_subagent: true });
  sandbox.setLang("en");
  sandbox.setTab("active");
  sandbox.setSnap({
    mode: "snapshot", generated_at: "2026-11-24T18:15:27Z",
    summary: { shown_main_count: 2, running_main_count: 1, shown_subagent_count: 1, history_subagents_hidden_count: 0, archived_hidden_count: 0 },
    sessions: [mkSess("hero", "Active Hero", { is_active: true }), mkSess("p1", "Only Pinned", { pinned: true })],
    orphan_subagents: [orphan],
  });
  sandbox.render();
  assert.equal(st.uPG.hidden, true, "must not split into Pinned + bogus Recent card when only orphan subagents exist");
  assert.equal(st.uRGh.hidden, true);
  assert.deepEqual(st.uLs.children.map((e) => e.dataset.i), ["p1", "orp-1"]);
});

test("Astra P1/P2 & 440px visual QA: default canCallTools=false, set_prefs isError revert, Closed zh-CN localization, handshake retry, and 480px responsive wrap", async () => {
  const viewSrc = fs.readFileSync(VIEW_TS, "utf8");
  const cssSrc = fs.readFileSync(THEME_CSS, "utf8");

  // 1. canCallTools defaults to false and requires explicit serverTools capability
  assert.match(viewSrc, /let\s+canCallTools\s*=\s*false\b/, "canCallTools must default to false");
  assert.match(viewSrc, /canCallTools\s*=\s*!!caps\?\.serverTools\b/, "canCallTools must require explicit hostCapabilities.serverTools");

  // 2. 440px visual QA CSS & DOM invariants (480px breakpoint, hero wrap, 3-column compact KPI strip, docked subagent wrap)
  assert.ok(cssSrc.includes("@media(max-width:480px)"), "narrow-pane breakpoint must be raised to 480px");
  assert.ok(cssSrc.includes(".hero>.jb{flex-wrap:wrap}"), "hero header must wrap cleanly <=480px");
  assert.equal(cssSrc.includes(".pls>.pl:last-child{grid-column:1/-1}"), false, "3-pill KPI strip must never leave an orphan full-row pill <=480px");
  assert.ok(cssSrc.includes(".pls{grid-template-columns:repeat(3,minmax(0,1fr))"), "3-pill KPI strip must stay 3 columns down to 350px");
  assert.ok(viewSrc.includes('hCh = dv("r w")'), "docked subagent pill row must wrap cleanly");

  // 3. Closed status localizes cleanly with Details disclosure
  const { sandbox } = createRenderSandbox("zh-CN");
  sandbox.setSnap({ mode: "snapshot", generated_at: "2026-11-24T18:15:27Z", summary: { shown_main_count: 1 }, sessions: [mkSess("h", "Hero", { is_active: true })], orphan_subagents: [] });
  vm.runInNewContext('errorText = "Closed"; render();', sandbox);
  const st = sandbox.getState();
  assert.equal(st.uB[2].textContent, "与 Antigravity 的连接已断开。");
  assert.ok(st.uB[6].textContent.includes("详情") && st.uB[6].textContent.includes("Closed"));
  sandbox.setLang("en");
  sandbox.render();
  assert.equal(st.uB[2].textContent, "Lost connection to Antigravity.");
  assert.ok(st.uB[6].textContent.includes("Details") && st.uB[6].textContent.includes("Closed"));

  // 4. toggleAutoHandoff reverts on isError:true from set_prefs
  const toggleM = viewSrc.match(/const toggleAutoHandoff = async \(\)[\s\S]*?\n\};/);
  assert.ok(toggleM, "view.ts must define toggleAutoHandoff");
  let flashed = "";
  const tBox = {
    allowAutoHandoff: true, canCallTools: true,
    K_SP: "set_prefs", K_AAH: "allow_auto_handoff", K_SC2: "structuredContent", K_ST: "settings", K_ERR: "isError",
    L: (i: number) => `L${i}`, tr: (e: string) => e, cancelAutoCmp: () => {}, render: () => {}, pg: () => null, maybeAutoRelay: () => {},
    flashMicro: (m: string) => { flashed = m; },
    uiAct: async () => ({ isError: true, content: [{ text: "storage failed" }], structuredContent: { reason: "storage_error" } }),
    toggleAutoHandoff: null as unknown as () => Promise<void>,
  };
  vm.runInNewContext(stripTs(toggleM[0]) + `; this.toggleAutoHandoff = toggleAutoHandoff;`, tBox);
  await tBox.toggleAutoHandoff();
  assert.equal(tBox.allowAutoHandoff, true, "toggleAutoHandoff must revert when set_prefs returns isError:true");
  assert.equal(flashed, "storage failed");

  // 5. kit/bridge.ts reconnects cleanly after a failed first handshake
  const { App, LATEST_PROTOCOL_VERSION } = await import(BRIDGE_TS);
  const listeners = new Map<string, (ev: unknown) => void>();
  let attempt = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  const origWin = g.window;
  const origDoc = g.document;
  const parentTarget = {
    postMessage(msg: { method?: string; id?: unknown }) {
      if (msg.method === "ui/initialize") {
        attempt += 1;
        queueMicrotask(() => {
          const cb = listeners.get("message");
          cb?.({
            source: parentTarget,
            data: attempt === 1
              ? { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "not ready" } }
              : { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: LATEST_PROTOCOL_VERSION, hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark" } } },
          });
        });
      }
    },
  };
  g.window = {
    parent: parentTarget, innerWidth: 440,
    addEventListener(t: string, fn: (ev: unknown) => void) { listeners.set(t, fn); },
    removeEventListener(t: string) { listeners.delete(t); },
  };
  g.document = { documentElement: { style: {}, getAttribute: () => null, setAttribute: () => {} }, body: { style: {} } };
  try {
    const bridge = new App({ name: "context-radar-mcp", version: "1.0.0" }, {});
    await assert.rejects(() => bridge.connect(), /not ready/);
    assert.equal(bridge.isConnected(), false);
    assert.equal(listeners.has("message"), false, "failed handshake must clean up listener");
    await bridge.connect();
    assert.equal(bridge.isConnected(), true, "retry handshake must re-attach listener and succeed");
    assert.equal(listeners.has("message"), true);
    bridge.close();
  } finally {
    g.window = origWin;
    g.document = origDoc;
  }
});

test("side questions render 顺便问 / Aside badge under parent while normal subagents keep 子代理 / Subagent", () => {
  const { sandbox } = createRenderSandbox("zh-CN");
  const normSub = mkSess("sub-1", "worker-alpha", { is_active: false, is_subagent: true, is_side_question: false });
  const sideQ = mkSess("btw-1", "Check Progress", { is_active: false, is_subagent: true, is_side_question: true });

  sandbox.setSnap({
    mode: "snapshot",
    generated_at: "2026-11-27T07:00:00Z",
    summary: { shown_main_count: 1, running_main_count: 0, shown_subagent_count: 2, history_subagents_hidden_count: 0, archived_hidden_count: 0 },
    sessions: [mkSess("main-1", "Primary Chat", { is_active: false, subagents: [normSub, sideQ] })],
    orphan_subagents: [],
  });
  sandbox.setTab("subs");
  sandbox.render();

  const st = sandbox.getState();
  const rows = st.uLs.children;
  assert.deepEqual(rows.map((e) => e.dataset.i), ["main-1", "sub-1", "btw-1"]);
  const getSubBadge = (itemEl: MockEl): MockEl => itemEl.children[0].children[3];
  const getTitleEl = (itemEl: MockEl): MockEl => itemEl.children[0].children[4];
  assert.equal(getSubBadge(rows[1]).hidden, false);
  assert.equal(getSubBadge(rows[1]).textContent, "子代理");
  assert.equal(getSubBadge(rows[2]).hidden, false);
  assert.equal(getSubBadge(rows[2]).textContent, "顺便问");
  assert.equal(getTitleEl(rows[2]).textContent, "Check Progress");

  sandbox.setLang("en");
  sandbox.render();
  assert.equal(getSubBadge(rows[1]).textContent, "Subagent");
  assert.equal(getSubBadge(rows[2]).textContent, "Aside");
});

test("fmtDur humanizes seconds/minutes/hours/days without overflow, tab totals stay invariant with cap footer, and settings drawer renders cleanly", () => {
  const { sandbox } = createRenderSandbox("en");

  assert.equal(sandbox.fmtDur(45), "45s");
  assert.equal(sandbox.fmtDur(420), "7m");
  assert.equal(sandbox.fmtDur(7500), "2h 5m");
  assert.equal(sandbox.fmtDur(55390), "15h 23m");
  assert.equal(sandbox.fmtDur(273600), "3d 4h");
  assert.equal(sandbox.fmtDur(3_000_000_000), "34722d 5h");

  sandbox.setLang("zh-CN");
  assert.equal(sandbox.fmtDur(45), "45 秒");
  assert.equal(sandbox.fmtDur(420), "7 分钟");
  assert.equal(sandbox.fmtDur(7500), "2 小时 5 分");
  assert.equal(sandbox.fmtDur(55390), "15 小时 23 分");
  assert.equal(sandbox.fmtDur(273600), "3 天 4 小时");

  // Invariant tab totals + cap footer when capped at 75 of 247
  const sub = mkSess("sub-1", "worker", { is_subagent: true });
  sandbox.setSnap({
    mode: "snapshot",
    generated_at: "2026-11-27T10:00:00Z",
    settings_path: "~/.gemini/antigravity/plugin_data/context-radar-mcp/settings.json",
    settings_error: "invalid_json",
    ui_settings: { lang: "zh-CN", currency_code: "CNY", fx_rate: 7.2, poll_interval_sec: 5, bg_poll_interval_sec: 15, allow_auto_handoff: true, compact_threshold: 360000 },
    summary: {
      shown_main_count: 1, running_main_count: 1, shown_subagent_count: 75,
      history_subagents_hidden_count: 172, archived_hidden_count: 18,
      total_main_count: 14, total_subagent_count: 247, total_archived_count: 18,
    },
    sessions: [mkSess("main-1", "Primary", { is_active: true, subagents: [sub] })],
    orphan_subagents: [],
  });
  sandbox.setTab("subs");
  sandbox.setSettingsOpen(true);
  sandbox.render();
  const st = sandbox.getState();
  const [, , , tabs] = st.uF;
  assert.equal(tabs[0].textContent, "会话 (14)");
  assert.equal(tabs[1].textContent, "子代理 (247)");
  assert.equal(tabs[2].textContent, "已归档 (18)");
  assert.equal(st.uCap.hidden, false);
  assert.equal(st.uCap.textContent, "显示最近 75 个，共 247 个");
  assert.equal(st.uSet.hidden, false);
  assert.ok(st.uSet.textContent.includes("配置文件有误，暂时沿用上次的有效设置。"));
  assert.ok(st.uSet.textContent.includes("~/.gemini/antigravity/plugin_data/context-radar-mcp/settings.json"));

  sandbox.setLang("en");
  sandbox.render();
  assert.equal(st.uCap.textContent, "Showing latest 75 of 247");
  assert.ok(st.uSet.textContent.includes("settings.json has an error. Using your last good settings."));
});

test("weak-net SWR boot: localStorage hydration/redaction, fresh-boot coalescing, RTT adaptive backoff, document.hidden pause, and pollSeq out-of-order drop", async () => {
  const viewSrc = fs.readFileSync(VIEW_TS, "utf8");

  // 1. Frame-0 localStorage hydration, schema validation, digest redaction, startup entry & handoff isolation
  const runBootSlice = async (opts: {
    boot: Record<string, unknown> | null;
    storedRaw: string | null;
    nowMs: number;
  }) => {
    const store = new Map<string, string>();
    if (opts.storedRaw !== null) store.set("cr_snap_v1", opts.storedRaw);
    const sliceStart = viewSrc.indexOf("let viewMode: string =");
    const sliceEnd = viewSrc.indexOf("let refreshing =");
    const slice = viewSrc.slice(sliceStart, sliceEnd);
    const applyM = viewSrc.match(/function applySnapshot\([\s\S]*?\n\}/)!;
    const skipM = viewSrc.match(/const shouldSkipBootRefresh = [^\n]+;\n/)!;
    const bootFnM = viewSrc.match(/const bootPanel = async [\s\S]*?\n\};/)!;
    let refreshCalls = 0;
    const box = {
      boot: opts.boot,
      HC: "handoff_card", DB: "dashboard", K_SN0: "snapshot", K_DIG: "digest", K_PG: "pending_grant",
      K_ST: "settings", K_AAH: "allow_auto_handoff", K_US: "ui_settings", K_TH: "theme", K_LHT: "last_host_theme",
      themeLocked: true, themePref: "system", lastHostTheme: "dark", bridge: {},
      parseTheme: (v: unknown) => (v === "light" || v === "dark" ? v : "system"),
      parseHostTheme: (v: unknown) => (v === "light" ? "light" : "dark"),
      DE: { lang: "en" }, langLocked: true, lang: "en",
      now: () => opts.nowMs,
      parseLoc: () => "",
      maybeAutoRelay: () => {},
      setupRevealObservers: () => {},
      render: () => {},
      ensureConnected: async () => true,
      refreshSnapshot: () => { refreshCalls += 1; },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
      getState: null as unknown as () => Record<string, unknown>,
      applySnapshot: null as unknown as (s: Record<string, unknown>, persist?: boolean) => void,
      saveCachedSnap: null as unknown as (s: Record<string, unknown> | null, ts?: number) => void,
      shouldSkipBootRefresh: null as unknown as () => boolean,
      bootPanel: null as unknown as () => Promise<void>,
      getRefreshCalls: () => refreshCalls,
      store,
    };
    vm.runInNewContext(
      stripTs(`${slice}\n${applyM[0]}\n${skipM[0]}\n${bootFnM[0]}`) +
        `\nthis.applySnapshot=applySnapshot;this.saveCachedSnap=saveCachedSnap;this.shouldSkipBootRefresh=shouldSkipBootRefresh;this.bootPanel=bootPanel;this.getState=()=>({viewMode,snapshot,lastDigest,loadingInitial,bootOverridden});`,
      box
    );
    await box.bootPanel();
    return box;
  };

  // 1a. Missing boot + valid cached snapshot -> immediate Frame-0 hydration, loadingInitial=false, 1 initial refresh
  const cachedPayload = JSON.stringify({
    v: 1,
    savedAt: 5000,
    data: { mode: "snapshot", digest: "d-cached", sessions: [{ id: "c-cached", title: "Cached" }] },
  });
  const coldReopen = await runBootSlice({ boot: null, storedRaw: cachedPayload, nowMs: 6000 });
  assert.deepEqual(coldReopen.getState().loadingInitial, false);
  assert.equal(coldReopen.getState().lastDigest, "d-cached");
  assert.equal((coldReopen.getState().snapshot as { sessions: Array<{ id: string }> }).sessions[0].id, "c-cached");
  assert.equal(coldReopen.shouldSkipBootRefresh(), false);
  assert.equal(coldReopen.getRefreshCalls(), 1, "cold reopen without boot must trigger 1 initial refresh");

  // 1a-ii. Corrupt cached snapshot (non-array sessions) is rejected cleanly
  const corruptReopen = await runBootSlice({
    boot: null,
    storedRaw: JSON.stringify({ v: 1, savedAt: 5000, data: { mode: "snapshot", digest: "bad", sessions: {} } }),
    nowMs: 6000,
  });
  assert.equal(corruptReopen.getState().snapshot, null);
  assert.equal(corruptReopen.getState().loadingInitial, true);
  assert.equal(corruptReopen.getRefreshCalls(), 1);

  // 1b. Fresh SSR boot (<2500ms, newer than cache) -> uses boot and coalesces (0 initial refresh calls)
  const freshSsr = await runBootSlice({
    boot: { mode: "snapshot", digest: "d-ssr", bootTs: 9000, sessions: [{ id: "c-ssr", title: "SSR" }] },
    storedRaw: cachedPayload,
    nowMs: 9200,
  });
  assert.equal(freshSsr.getState().bootOverridden, false);
  assert.equal(freshSsr.getState().lastDigest, "d-ssr");
  assert.equal(freshSsr.shouldSkipBootRefresh(), true);
  assert.equal(freshSsr.getRefreshCalls(), 0, "fresh SSR boot (<2500ms) must coalesce with 0 t=0 refresh calls");

  // 1c. Stale SSR boot overridden by newer localStorage -> hydrates newer cache & runs 1 initial refresh
  const newerCache = JSON.stringify({
    v: 1,
    savedAt: 9500,
    data: { mode: "snapshot", digest: "d-newer", sessions: [{ id: "c-newer", title: "Newer" }] },
  });
  const overridden = await runBootSlice({
    boot: { mode: "snapshot", digest: "d-old-ssr", bootTs: 9000, sessions: [{ id: "c-old", title: "Old" }] },
    storedRaw: newerCache,
    nowMs: 9600,
  });
  assert.equal(overridden.getState().bootOverridden, true);
  assert.equal(overridden.getState().lastDigest, "d-newer");
  assert.equal(overridden.shouldSkipBootRefresh(), false);
  assert.equal(overridden.getRefreshCalls(), 1, "overridden SSR boot must run 1 live refresh");

  // 1d. Stale SSR boot (>=2500ms) -> runs 1 initial refresh
  const staleSsr = await runBootSlice({
    boot: { mode: "snapshot", digest: "d-ssr", bootTs: 5000, sessions: [{ id: "c-ssr", title: "SSR" }] },
    storedRaw: null,
    nowMs: 7500,
  });
  assert.equal(staleSsr.shouldSkipBootRefresh(), false);
  assert.equal(staleSsr.getRefreshCalls(), 1, "SSR boot >=2500ms must run 1 live refresh");

  // 1e. applySnapshot strips pending_grant AND digest when pending_grant existed so reopen restores live grant
  freshSsr.applySnapshot({
    mode: "snapshot",
    digest: "d-with-grant",
    sessions: [{ id: "c-ssr", title: "SSR" }],
    pending_grant: { grant_id: "secret-grant", handoff_prompt: "secret" },
  });
  const savedAfterRaw = freshSsr.store.get("cr_snap_v1")!;
  const savedAfter = JSON.parse(savedAfterRaw);
  assert.equal(savedAfter.v, 1);
  assert.equal("pending_grant" in savedAfter.data, false, "pending_grant must be redacted from localStorage");
  assert.equal("digest" in savedAfter.data, false, "digest must be cleared when pending_grant was redacted");
  const reopenAfterGrant = await runBootSlice({ boot: null, storedRaw: savedAfterRaw, nowMs: 12000 });
  assert.equal(reopenAfterGrant.getState().lastDigest, "", "reopen after grant redaction must not suppress live grant");

  const handoffBoot = await runBootSlice({
    boot: { view: "handoff", lang: "en" },
    storedRaw: cachedPayload,
    nowMs: 6000,
  });
  assert.equal(handoffBoot.getState().viewMode, "handoff_card");
  assert.equal(handoffBoot.getState().snapshot, null, "handoff view must never hydrate dashboard snapshot");
  handoffBoot.saveCachedSnap({ mode: "snapshot", digest: "should-not-save", sessions: [] }, 6000);
  assert.equal(handoffBoot.store.get("cr_snap_v1"), cachedPayload, "handoff view must never overwrite localStorage");

  // 2. RTT adaptive polling, document.hidden pause/resume (throttled & eligible reveal), and pollSeq out-of-order drop
  const applyM = viewSrc.match(/function applySnapshot\([\s\S]*?\n\}/)!;
  const nextPollM = viewSrc.match(/const nextPollMs = [\s\S]*?\n\};/)!;
  const cancelPollM = viewSrc.match(/const cancelPoll = [^\n]+;\n/)!;
  const schedPollM = viewSrc.match(/const scheduleNextPoll = [\s\S]*?\n\};/)!;
  const refreshM = viewSrc.match(/async function refreshSnapshot\([\s\S]*?\n\}/)!;
  const setTabM = viewSrc.match(/const setFilterTab = [\s\S]*?\n/)!;
  const forceNowM = viewSrc.match(/const forceNow = [\s\S]*?\n/)!;
  const kickM = viewSrc.match(/const kickRelay = [^\n]+;\n/)!;
  const syncNowM = viewSrc.match(/const syncNow = [\s\S]*?\n\};/)!;

  let cancelledCount = 0;
  let scheduledTimers: Array<{ fn: () => void; ms: number }> = [];
  let clockNow = 1000;
  const sentCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const pendingResolvers: Array<(v: Record<string, unknown>) => void> = [];
  const netBox = {
    DB: "dashboard", HC: "handoff_card", D: { hidden: false, querySelector: () => null }, DE: { lang: "en" }, M: Math, rd: Math.round,
    performance: { now: () => 100 }, now: () => clockNow,
    st: (fn: () => void, ms: number) => { const h = { fn, ms }; scheduledTimers.push(h); return h; },
    ct: () => { cancelledCount += 1; },
    num: (v: unknown) => Number(v) || 0, tr: (e: string) => e, L: (i: number) => `L${i}`, parseLoc: () => "",
    K_AAH: "allow_auto_handoff", K_ST: "settings", K_US: "ui_settings", K_PI: "poll_interval_sec",
    K_TH: "theme", K_LHT: "last_host_theme", themeLocked: true, themePref: "system", lastHostTheme: "dark", bridge: {},
    parseTheme: (v: unknown) => (v === "light" || v === "dark" ? v : "system"),
    parseHostTheme: (v: unknown) => (v === "light" ? "light" : "dark"),
    K_PG: "pending_grant", K_DIG: "digest", K_AR: "archived", K_SN0: "snapshot",
    K_SC2: "structuredContent", K_SM: "server_ms", K_ERR: "isError", K_GA: "generated_at",
    viewMode: "dashboard", autoRefresh: true, canCallTools: true,
    inFlightPoll: false, queuedForce: false, pollSeq: 0, inFlightSeq: 0,
    pollTimer: null as unknown, pollMs: 1000, refreshing: false, showSpinner: false, spinTimer: null,
    filterTab: "active", lastDigest: "", snapshot: null as Record<string, unknown> | null,
    handoffCard: null, loadingInitial: true, errorText: "", serverMs: 0,
    ewmaRttMs: null as number | null, pollErrors: 0, lastSyncTs: 0, lastForceTs: 1000, unchangedHits: 0,
    langLocked: true, lang: "en", allowAutoHandoff: true,
    pg: () => null, maybeAutoRelay: () => {}, flashMicro: () => {}, render: () => {},
    callTool: (name: string, args: Record<string, unknown>) => {
      sentCalls.push({ name, args });
      return new Promise<Record<string, unknown>>((resolve) => { pendingResolvers.push(resolve); });
    },
    nextPollMs: null as unknown as () => number,
    scheduleNextPoll: null as unknown as () => number,
    syncNow: null as unknown as () => number | void,
    setFilterTab: null as unknown as (next: string) => void,
    refreshSnapshot: null as unknown as (f?: boolean) => Promise<void>,
  };

  vm.runInNewContext(
    stripTs(`${applyM[0]}\n${nextPollM[0]}\n${cancelPollM[0]}\n${schedPollM[0]}\n${refreshM[0]}\n${setTabM[0]}\n${forceNowM[0]}\n${kickM[0]}\n${syncNowM[0]}`) +
      `\nthis.nextPollMs=nextPollMs;this.scheduleNextPoll=scheduleNextPoll;this.syncNow=syncNow;this.setFilterTab=setFilterTab;this.refreshSnapshot=refreshSnapshot;`,
    netBox
  );

  // Adaptive RTT cadence
  assert.equal(netBox.nextPollMs(), 1000);
  netBox.ewmaRttMs = 300;
  assert.ok(netBox.nextPollMs() >= 900 && netBox.nextPollMs() === 1000, "300ms RTT must clamp to >=900ms (1000ms floor)");
  netBox.ewmaRttMs = 450;
  assert.equal(netBox.nextPollMs(), 1350, "450ms RTT * 3 = 1350ms");
  netBox.ewmaRttMs = 7000;
  assert.equal(netBox.nextPollMs(), 15000, "adaptive poll must cap at 15000ms");
  netBox.snapshot = { mode: "snapshot", ui_settings: { poll_interval_sec: 4 } };
  assert.equal(netBox.nextPollMs(), 4000, "explicit poll_interval_sec > 0 must override adaptive RTT");
  netBox.snapshot = { mode: "snapshot", ui_settings: { poll_interval_sec: 0 } };
  netBox.ewmaRttMs = 400;

  // document.hidden pause & resume (throttled reveal schedules immediately; eligible reveal schedules on settle)
  assert.equal(netBox.scheduleNextPoll(), 1200);
  assert.equal(scheduledTimers.length, 1);
  netBox.D.hidden = true;
  assert.equal(netBox.nextPollMs(), 0);
  assert.equal(netBox.scheduleNextPoll(), 0, "scheduleNextPoll must cancel and return 0 when D.hidden");
  assert.equal(cancelledCount, 1);
  assert.equal(netBox.pollTimer, null);

  netBox.D.hidden = false;
  assert.equal(netBox.scheduleNextPoll(), 1200);
  netBox.D.hidden = true;
  assert.equal(netBox.syncNow(), 0, "syncNow must cancel active timer and return 0 when D.hidden");
  assert.equal(cancelledCount, 2);
  assert.equal(netBox.pollTimer, null);
  assert.equal(sentCalls.length, 0);

  // Throttled reveal (within 250ms of lastForceTs=1000) resumes timer immediately without RPC
  netBox.D.hidden = false;
  clockNow = 1100;
  netBox.syncNow();
  assert.equal(sentCalls.length, 0);
  assert.equal(scheduledTimers.length, 3, "throttled reveal must resume poll timer immediately");

  // Eligible reveal (>250ms past lastForceTs) resets pollErrors backoff and fires 1 fresh RPC
  netBox.D.hidden = true;
  netBox.syncNow();
  const pollTimers = () => scheduledTimers.filter((t) => t.ms >= 1000);
  const timersBeforeEligible = pollTimers().length;
  netBox.pollErrors = 3;
  netBox.D.hidden = false;
  clockNow = 2000;
  netBox.syncNow();
  assert.equal(netBox.pollErrors, 0, "visible reveal must reset pollErrors backoff to base cadence");
  assert.equal(sentCalls.length, 1, "eligible reveal must fire 1 RPC via real forceNow");
  assert.equal(sentCalls[0].args.fresh, true, "visible reveal must request fresh:true");
  assert.equal(netBox.inFlightPoll, true);
  assert.equal(netBox.pollTimer, null, "no poll timer scheduled while RPC is pending");
  assert.equal(pollTimers().length, timersBeforeEligible, "no poll timer created while RPC is pending");
  pendingResolvers.shift()!({ isError: false, structuredContent: { mode: "snapshot", digest: "d-reveal", server_ms: 1, sessions: [] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(pollTimers().length, timersBeforeEligible + 1, "poll timer must be scheduled after reveal RPC settles");
  assert.notEqual(netBox.pollTimer, null);
  assert.equal(netBox.lastDigest, "d-reveal");

  // Real tab change while poll is pending bumps pollSeq, drops stale previous-tab reply, and queues new tab RPC
  const pActive = netBox.refreshSnapshot(false);
  assert.equal(sentCalls.length, 2);
  assert.equal(sentCalls[1].args.include_archived, false);
  netBox.setFilterTab("archived");
  // Resolve stale active-tab reply after tab changed to archived
  pendingResolvers.shift()!({ isError: false, structuredContent: { mode: "snapshot", digest: "d-stale-tab", server_ms: 1, sessions: [{ id: "stale", title: "Stale" }] } });
  await pActive;
  assert.equal(netBox.lastDigest, "", "stale reply from prior tab must be dropped");
  assert.equal(sentCalls.length, 3, "queued force refresh for new tab must dispatch");
  assert.equal(sentCalls[2].args.include_archived, true, "queued RPC must carry archived tab arguments");
  pendingResolvers.shift()!({ isError: false, structuredContent: { mode: "snapshot", digest: "d-arch", server_ms: 1, sessions: [] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(netBox.lastDigest, "d-arch");
});
