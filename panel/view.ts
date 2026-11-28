import {
  App,
  type HostContext,
  type ThemePreference,
  type ToolCallOptions,
  type ToolCallResult,
} from "./kit/bridge.ts";

interface ColdBreakdown {
  turn_start_cold?: number;
  mid_loop_cold?: number;
  post_compact_cold?: number;
}

interface MidLoopBreakdown {
  slow_turn_self_expiry?: number;
  replica_spillover?: number;
  model_switch_cold?: number;
}

interface SessionItem {
  id: string;
  title: string;
  level?: string;
  is_active?: boolean;
  pinned?: boolean;
  archived?: boolean;
  is_subagent?: boolean;
  is_side_question?: boolean;
  agent_name?: string;
  model_short?: string;
  model_display?: string;
  workspace?: string;
  workspaces?: string[];
  live_status?: string;
  live_phase?: string;
  live_elapsed_sec?: number;
  live_error?: string;
  cross_model_compact?: boolean;
  latest_context_tokens?: number;
  context_limit?: number;
  context_pct?: number;
  remaining_context_tokens?: number;
  peak_context_tokens?: number;
  min_compact_tokens?: number;
  recommend_compact_tokens?: number;
  urgent_compact_tokens?: number;
  just_compacted?: boolean;
  pre_compact_tokens?: number;
  compact_summary_kb?: number;
  suggest_compact?: boolean;
  cache_hit_rate?: number;
  cold_cache_count?: number;
  cold_cache_breakdown?: ColdBreakdown;
  mid_loop_breakdown?: MidLoopBreakdown;
  turn_start_cold_count?: number;
  mid_loop_cold_count?: number;
  post_compact_cold_count?: number;
  latest_ttft_ms?: number;
  median_ttft_ms?: number;
  latest_stream_tps?: number;
  median_stream_tps?: number;
  e2e_tps?: number;
  checkpoint_count?: number;
  total_thinking_tokens?: number;
  total_response_tokens?: number;
  thinking_share_pct?: number;
  last_loop_steps?: number;
  last_loop_output_tokens?: number;
  last_loop_thinking_tokens?: number;
  last_loop_cost_usd?: number;
  last_loop_cost_cny?: number;
  cost_usd?: number;
  cost_cny?: number;
  turns?: number;
  pricing_known?: boolean;
  sidebar_sort_ts?: number;
  effective_last_active_ts?: number;
  last_active_ts?: number;
  running_subagent_count?: number;
  subagents?: SessionItem[];
}

interface PendingGrant {
  grant_id?: string;
  kind?: string;
  conversation_id?: string;
  handoff_conversation_id?: string;
  workspace?: string;
  workspaces?: string[];
  compact_command?: string;
  compact_status?: string;
  handoff_prompt?: string;
  allow_auto_handoff?: boolean;
  auto_fire?: boolean;
  acp_proxy_active?: boolean;
  claimed?: boolean;
  running_subagent_count?: number;
  preserve_points?: string;
  resume_task?: string;
  scratch_note_path?: string;
  mode?: string;
  blocked?: boolean;
  reasons?: string[];
  lang?: string;
}

interface SummaryData {
  shown_main_count?: number;
  total_main_count?: number;
  running_main_count?: number;
  shown_subagent_count?: number;
  history_subagents_hidden_count?: number;
  total_subagent_count?: number;
  archived_hidden_count?: number;
  total_archived_count?: number;
  active_carbon_count?: number;
  carbon_concurrency_warning?: boolean;
}

interface UiSettings {
  lang?: string;
  currency_code?: string;
  fx_rate?: number;
  poll_interval_sec?: number;
  bg_poll_interval_sec?: number;
  allow_auto_handoff?: boolean;
  compact_threshold?: number;
  theme?: string;
  last_host_theme?: string;
}

interface SnapshotData {
  mode?: string;
  view?: string;
  bootTs?: number;
  lang?: string;
  digest?: string;
  unchanged?: boolean;
  server_ms?: number;
  generated_at?: string;
  daemon_workspace?: string;
  currency_code?: string;
  currency_explicit?: boolean;
  currency_symbol?: string;
  thresholds?: { max?: number };
  settings?: UiSettings;
  ui_settings?: UiSettings;
  settings_path?: string;
  settings_error?: string;
  summary?: SummaryData;
  sessions?: SessionItem[];
  orphan_subagents?: SessionItem[];
  pending_grant?: PendingGrant;
}

interface TurnItem {
  turn?: number;
  time_iso?: string;
  context_tokens?: number;
  is_checkpoint?: boolean;
  thinking_tokens?: number;
  response_tokens?: number;
  stream_tps?: number;
  e2e_tps?: number;
  cache_hit_rate?: number;
  ttft_ms?: number;
  is_cold_cache?: boolean;
  cold_cache_kind?: string;
  cold_cache_sub_reason?: string;
  cold_cache_reason?: string;
  is_partial_cold?: boolean;
  cost_usd?: number;
  cost_cny?: number;
}

interface TurnsPayload {
  total_turns?: number;
  turns?: TurnItem[];
}

interface HotspotItem {
  turn?: number;
  step_idx?: number;
  delta_tokens?: number;
  context_after?: number;
  cause?: string;
}

interface HotspotsPayload {
  found?: boolean;
  error?: string;
  recommended_distill_range?: [number, number] | number[];
  hotspots?: HotspotItem[];
}

interface AdvicePayload {
  found?: boolean;
  reason?: string;
  gate_allowed?: boolean;
  break_even_turns?: number;
  pricing_known?: boolean;
  compact_overhead_usd?: number;
  compact_overhead_cny?: number;
  per_turn_saving_usd?: number;
  per_turn_saving_cny?: number;
  headline?: string;
  gate_reasons?: string[];
}

interface DistillPayload {
  saved_note_path?: string;
  error?: string;
}

interface ClaimGrantPayload {
  claimed?: boolean;
  reason?: string;
  handoff_conversation_id?: string;
}

interface CreateHandoffPayload extends PendingGrant {
  blocked?: boolean;
  mode?: string;
  reasons?: string[];
}

interface SetPrefsPayload {
  settings?: UiSettings;
  ui_settings?: UiSettings;
}

interface UiMessageResponse {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  error?: { message?: string };
  _meta?: {
    [key: string]: unknown;
  };
}

type TrayTab = "turns" | "hotspots" | "advice";
type FilterTab = "active" | "subs" | "archived";
type LevelTone = "ok" | "wn" | "er";
type SafeLevel = "ok" | "warn" | "critical";
type TimerHandle = ReturnType<typeof setTimeout>;
type BootWindow = Window & { __CONTEXT_RADAR_BOOT__?: SnapshotData | null };

interface DomChildArray extends Array<DomChild> {}
type DomChild = Node | string | number | boolean | null | undefined | DomChildArray;
type AttrMap = Record<string, string | number | boolean | null | undefined> | 0 | null | undefined;

type PillTuple = [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
type DetailBlock = [
  HTMLElement,
  HTMLElement,
  HTMLElement,
  HTMLElement,
  HTMLElement,
  HTMLElement[],
  HTMLElement,
  HTMLElement,
  HTMLElement,
  HTMLElement,
  HTMLElement,
  PillTuple[],
  HTMLElement,
  HTMLElement,
  HTMLElement,
  HTMLElement[],
  HTMLElement,
  HTMLElement,
  string,
  string,
];
type RowEntry = [HTMLElement, HTMLElement, HTMLElement[], HTMLElement, DetailBlock | null];
type HeroChipEntry = [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
type BannerState = [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, string];
type HeroState = [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, DetailBlock, HTMLElement, HTMLElement, HTMLElement, DetailBlock | null];
type FilterState = [HTMLElement, HTMLElement, HTMLElement, HTMLElement[], HTMLElement, HTMLElement];
type EmptyState = [HTMLElement, HTMLElement, HTMLElement];

const D = document, DE = D.documentElement, M = Math;
const st = (fn: (...a: unknown[]) => void, ms?: number): TimerHandle => setTimeout(fn, ms);
const ct = (i: TimerHandle | null | undefined): void => { if (i != null) clearTimeout(i); };
const now = Date.now, S = String;
const onD = <K extends keyof DocumentEventMap>(e: K, f: (ev: DocumentEventMap[K]) => void, o?: AddEventListenerOptions): void => D.addEventListener(e, f, o);
const bridge = App({ name: "context-radar-mcp", version: "1.0.0" }, {}, { autoResize: true });
const boot = typeof window < "u" ? (window as BootWindow).__CONTEXT_RADAR_BOOT__ ?? null : null;
const NS = DE.namespaceURI?.replace("1999/xhtml", "2000/svg") || "";

// Shared DOM builder: pure createElement / textContent only
const rd = M.round, fl = M.floor;
const h = <K extends keyof HTMLElementTagNameMap>(t: K, c?: string, a?: AttrMap, ...ch: DomChild[]): HTMLElementTagNameMap[K] => {
  const n = D.createElement(t);
  if (c) n.className = c;
  if (a) for (const k in a) {
    const v = a[k]; if (v == null || v === false) continue;
    k === "h" ? (n.hidden = true) : k === "s" ? (n.style.cssText = S(v)) : (n.setAttribute(k, v === true ? "" : S(v)), k[4] === "-" && k[0] === "d" && n.dataset && (n.dataset[k.slice(5)] = S(v)));
  }
  const add = (x: DomChild): void => { if (x != null && x !== false) Array.isArray(x) ? x.forEach(add) : n.appendChild(typeof x === "object" ? x : D.createTextNode(S(x))); };
  add(ch); return n;
};
const dv = (c: string, ...x: DomChild[]): HTMLDivElement => h("div", c, 0, ...x);
const sp = (c: string, ...x: DomChild[]): HTMLSpanElement => h("span", c, 0, ...x);
const hd0 = <K extends keyof HTMLElementTagNameMap>(t: K, c: string, ...x: DomChild[]): HTMLElementTagNameMap[K] => h(t, c, { h: 1 }, ...x);
const hdv = (c = "", ...x: DomChild[]): HTMLDivElement => hd0("div", c, ...x);
const hb = (c = ""): HTMLSpanElement => hd0("span", `bd${c ? ` ${c}` : ""}`);
const al = (v: string): Record<string, string> => ({ "aria-label": v });
const bt = (c: string, a: string, tx: DomChild, id?: string, ex?: Record<string, string | number | boolean | null | undefined>): HTMLButtonElement => h("button", c, { "data-a": a, ...(id ? { "data-i": id } : {}), ...ex }, tx);
const setCh = (e: HTMLElement, a: Array<Node | null | undefined | false>): void => { while (e.firstChild) e.firstChild.remove(); a.forEach((n) => n && e.appendChild(n)); };
const sv = (z: number, ps: string[], c0?: boolean | number): SVGSVGElement => {
  const mk = (t: string, a: Record<string, string | number>): SVGElement => { const n = D.createElementNS(NS, t) as SVGElement; for (const k in a) n.setAttribute(k, S(a[k])); return n; };
  const s = mk("svg", { width: z, height: z, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "aria-hidden": 1 }) as SVGSVGElement;
  ps.forEach((d, i) => s.appendChild(mk("path", c0 && i === 1 ? { d, opacity: .55 } : { d })));
  if (c0) s.appendChild(mk("circle", { cx: 8, cy: 8, r: 1, fill: "currentColor", stroke: "none" }));
  return s;
};
const mkEmb = (dc?: string | 0, big?: boolean | number): [HTMLSpanElement, HTMLSpanElement] => { const d = sp(`dt ${dc || "idle"}`); return [h("span", "eb", big ? { s: "width:32px;height:32px;border-radius:8px" } : 0, sv(big ? 18 : 14, ["M3.2 12.8A6.5 6.5 0 1 1 13.4 4.4", "M5.6 10.4A3.4 3.4 0 1 1 10.8 5.9", "M8 8l4.4-4.4"], 1), d), d]; };

const I18N = `Loading…|正在加载…
✓ Copied|✓ 已复制
Copy /compact|复制 /compact
Keep going|先不压缩
Ready|就绪
Opening…|正在打开…
Auto handoff|自动接续
Auto (no subagents running)|无子代理时自动
✓ Reminder copied|✓ 提醒已复制
Subagents running|子代理运行中
Compacting…|正在压缩…
Copy ID|复制 ID
New chat|开新会话
Can't hand off yet|暂不能接续
Used|已用
✓ New chat opened|✓ 已开新会话
✓ /compact sent|✓ 已发送 /compact
Ready to compact|可以压缩了
Ready for a new chat|可开启新会话
Error|出错
Refresh|刷新
Dismiss|关闭
Send /compact|发送 /compact
Other workspaces|其他工作区
No sessions|暂无会话
Pinned|置顶
Recent|最近
Failed|失败
Context|上下文
Subagent|子代理
Aside|顺便问
Settings|设置
Save|保存
Saving…|正在保存…
✓ Saved|✓ 已保存
Couldn't save|保存失败
Details|详情
Auto|自动
Waiting|等待中
✓ Done|✓ 已完成
Cancel|取消
Hotspots|热点
Handoff|接续`.split("\n").map((r) => r.split("|"));

const K_SN0 = "snapshot", K_SP = "set_prefs", K_ERR = "isError", K_DIG = "digest", K_SM = "server_ms", K_HP = "handoff_prompt", K_RC = "record_compact", K_HS = "hotspots", K_MLC = "mid_loop_cold", K_PCC = "post_compact_cold";
const ls0 = (v?: string): string | null | undefined => { try { if (v) localStorage.setItem("cr_lang", v); else return localStorage.getItem("cr_lang"); } catch {} return undefined; };
const parseLoc = (r: unknown): string => { const s = S(r || "").trim().toLowerCase(); return !s || s === "auto" ? "" : s.startsWith("zh") ? "zh-CN" : "en"; };
const p0 = ls0(), pLang = p0 === "en" || p0 === "zh-CN" ? p0 : "";
let langLocked = !!(pLang || boot?.settings?.lang), lang = pLang || parseLoc(boot?.settings?.lang) || parseLoc(typeof navigator < "u" ? navigator.language : "") || parseLoc(boot?.lang) || "en";
DE.lang = lang;

const isZh = (): boolean => lang === "zh-CN", L = (i: number): string => I18N[i][+isZh()], tr = (e: string): string => e.split("|")[+isZh()];
const subTxt = (n: number): string => (isZh() ? `${n} 个子代理` : `${n} subagent${n === 1 ? "" : "s"}`);

const CM = "cr-cap-msg", HC = "handoff_card", HB = "handoff_blocked", DB = "dashboard", AG_M = "com.google.antigravity/message";
const K_CID = "conversation_id", K_HCID = "handoff_conversation_id", K_AAH = "allow_auto_handoff", K_RSC = ["running", "subagent", "count"].join("_") as "running_subagent_count", K_LCT = "latest_context_tokens";
const K_CC = "compact_command", K_CS = "compact_status", K_SC = "suggest_compact", K_IS = "is_subagent";
const K_SC2 = "structuredContent", K_GID = "grant_id", K_SN = "saved_note_path", K_SA = "subagents", K_AR = "archived";
const K_WS = "workspace", K_WSS = "workspaces", K_CT = "context_tokens", K_RCT = "recommend_compact_tokens";
const K_ST = "settings", K_US = "ui_settings", K_ACT = "is_active", K_PG = "pending_grant", K_DW = "daemon_workspace", K_GA = "generated_at", K_PK = "pricing_known", K_PF = "context_radar_";
const K_CC2 = "currency_code", K_FX = "fx_rate", K_PI = "poll_interval_sec", K_BP = "bg_poll_interval_sec", K_CTH = "compact_threshold", K_TH = "theme", K_LHT = "last_host_theme";
const THS: readonly ThemePreference[] = ["system", "light", "dark"];
const parseTheme = (v: unknown): ThemePreference => (v === "light" || v === "dark" ? v : "system");
const parseHostTheme = (v: unknown): "light" | "dark" => (v === "light" ? "light" : "dark");
const DEF_T: [number, number, number] = [30e4, 36e4, 43e4], thrs = (it: SessionItem): [number | undefined, number | undefined, number | undefined] => [it.min_compact_tokens, it[K_RCT], it.urgent_compact_tokens], TABS: readonly TrayTab[] = ["turns", K_HS, "advice"], FIDS: readonly FilterTab[] = ["active", "subs", K_AR];

let viewMode: string = boot?.view === "handoff" ? HC : DB;
interface CachedSnap { v: number; savedAt: number; data: SnapshotData; }
const K_SNAP_LS = "cr_snap_v1";
const loadCachedSnap = (): CachedSnap | null => {
  try {
    const raw = typeof localStorage < "u" ? localStorage.getItem(K_SNAP_LS) : null;
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CachedSnap>;
    const d = p?.data;
    const validSess = (x: unknown): boolean => !!x && typeof x === "object" && typeof (x as SessionItem).id === "string" && typeof (x as SessionItem).title === "string";
    if (p?.v === 1 && typeof p.savedAt === "number" && Number.isFinite(p.savedAt) && d && typeof d === "object" && d.mode === K_SN0 && Array.isArray(d.sessions) && d.sessions.every(validSess) && (!d.orphan_subagents || Array.isArray(d.orphan_subagents))) {
      return p as CachedSnap;
    }
  } catch {}
  return null;
};
const saveCachedSnap = (snap: SnapshotData | null, ts = now()): void => {
  if (viewMode !== DB || !snap || snap.mode !== K_SN0) return;
  try {
    if (typeof localStorage < "u") {
      const rest: SnapshotData = { ...snap };
      delete rest[K_PG];
      if (snap[K_PG]) delete rest[K_DIG];
      localStorage.setItem(K_SNAP_LS, JSON.stringify({ v: 1, savedAt: ts, data: rest }));
    }
  } catch {}
};
const cachedBoot = viewMode === DB ? loadCachedSnap() : null;
const bootOverridden = !!(viewMode === DB && cachedBoot && (!boot || boot.mode !== K_SN0 || cachedBoot.savedAt > (boot.bootTs ?? 0)));
let snapshot: SnapshotData | null = bootOverridden ? cachedBoot!.data : boot?.mode === K_SN0 ? boot : null, lastDigest = snapshot?.[K_DIG] || "";
let handoffCard: PendingGrant | null = null, handoffStatus = "pending", loadingInitial = viewMode === DB ? !snapshot : true;
let refreshing = false, autoRefresh = true, filterTab: FilterTab = "active", allowAutoHandoff = snapshot?.[K_ST]?.[K_AAH] ?? true;
let busyGrantId: string | null = null, errorText = "", canMessage = false, ownerCid = "", copiedId: string | null = null, confirmSendId: string | null = null, microMsg = "";
let ewmaRttMs: number | null = null, serverMs: number | null = snapshot?.[K_SM] ?? null, pollMs = 1e3, unchangedHits = 0, pollErrors = 0;
let lastSyncTs = !bootOverridden && boot?.mode === K_SN0 ? now() : 0, lastForceTs = 0, spinTimer: TimerHandle | null = null, showSpinner = false;
let openRowId: string | null = null, loadingKey = "", subTrayRev = 0, bnrPri = false, mountedMode = "", ui: { he: HTMLElement | null } | null = null, lastHandoffSig = "";
let settingsOpen = false, settingsSaving = false, settingsSig = "";
let themePref: ThemePreference = parseTheme(snapshot?.[K_US]?.[K_TH] ?? (boot as { theme?: unknown } | null)?.theme), lastHostTheme: "light" | "dark" = parseHostTheme(snapshot?.[K_US]?.[K_LHT] ?? (boot as { lastHostTheme?: unknown } | null)?.lastHostTheme), themeLocked = 0;
const openTrays = new Map<string, TrayTab>(), cTurns = new Map<string, TurnsPayload>(), cHot = new Map<string, HotspotsPayload>(), cDist = new Map<string, DistillPayload>(), cAdv = new Map<string, AdvicePayload>(), attemptedGrants = new Set<string>(), rowNodes = new Map<string, RowEntry>(), pinNodes = new Map<string, RowEntry>(), heroChipNodes = new Map<string, HeroChipEntry>();
const trayMap: Record<TrayTab, Map<string, unknown>> = { turns: cTurns, hotspots: cHot, advice: cAdv };
let canCallTools = false, inFlightPoll = false, queuedForce = false, pollSeq = 0, inFlightSeq = 0, pollTimer: TimerHandle | null = null, microTimer: TimerHandle | null = null, copiedTimer: TimerHandle | null = null, autoCmpTimer: TimerHandle | null = null;
let uDot!: HTMLElement, uSwp!: HTMLElement, uMi!: HTMLElement, uMt!: HTMLElement, uAb!: HTMLElement, uGear!: HTMLElement, uRb!: HTMLElement, uRi!: SVGSVGElement, uB!: BannerState, uSet!: HTMLElement, uThInd!: HTMLElement, uThBtns: HTMLButtonElement[] = [], uH!: HeroState, uF!: FilterState, uGr!: HTMLElement, uPG!: HTMLElement, uPGh!: HTMLElement, uPLs!: HTMLElement, uRG!: HTMLElement, uRGh!: HTMLElement, uLs!: HTMLElement, uCap!: HTMLElement, uEm!: EmptyState, uHl!: HTMLElement;
const pg = (): PendingGrant | undefined => snapshot?.[K_PG], cancelAutoCmp = (): void => { if (autoCmpTimer !== null) { ct(autoCmpTimer); autoCmpTimer = null; } };

const callTool = <T = ToolCallResult>(name: string, args: Record<string, unknown>, opts?: ToolCallOptions): Promise<T> => bridge.callServerTool<T>({ name, arguments: args }, opts);
const uiAct = (args: Record<string, unknown>): Promise<ToolCallResult & { isError?: boolean; content?: Array<{ text?: string }> }> => callTool(`${K_PF}ui_action`, args);
const uiSc = async <T = Record<string, unknown>>(a: Record<string, unknown>): Promise<T | undefined> => (await uiAct(a))?.[K_SC2] as T | undefined;
const sendTxt = (text: string, meta?: Record<string, unknown> | 0): Promise<UiMessageResponse> => bridge.request<UiMessageResponse>("ui/message", { role: "user", content: [{ type: "text", text }], ...(meta ? { _meta: meta } : {}) }, { timeoutMs: 3e4 });
const num = (v: unknown): number => Number(v) || 0, fx = (n: unknown, d = 0): string => num(n).toFixed(d), clm = (v: number, a: number, b: number): number => M.min(b, M.max(a, v)), clp = (v: number): number => clm(v, 0, 100);
const safeLvl = (l: unknown): SafeLevel => (l === "critical" || l === "warn" ? l : "ok"), lvlTone = (l: SafeLevel): LevelTone => (l === "critical" ? "er" : l === "warn" ? "wn" : "ok"), lvlCls = (l: SafeLevel): string => (l === "critical" ? " lc" : l === "warn" ? " lw" : "");
const setCls = (e: Element | null | undefined, c: string): void => { if (e && e.className !== c) e.className = c; };
const setTxt = (e: Node | null | undefined, v: unknown): void => { const s = S(v ?? ""); if (e && e.textContent !== s) e.textContent = s; };
const sa = (e: Element | null | undefined, k: string, v: unknown): void => { const s = S(v); if (e && e.getAttribute?.(k) !== s) e.setAttribute(k, s); };
const ar = (e: Element | null | undefined, k: string, v: unknown): void => sa(e, `aria-${k}`, v);
const hd = (e: HTMLElement | null | undefined, b: unknown): void => { if (e) e.hidden = !!b; };
const hdA = (...a: Array<HTMLElement | null | undefined>): void => a.forEach((e) => hd(e, 1));
const cl = (e: Element | null | undefined, c: string, b: unknown): void => { e?.classList?.toggle(c, !!b); };

const fmtK = (n: unknown): string => { const v = num(n); return v >= 1e6 ? `${fx(v / 1e6, 2)}M` : v >= 1e3 ? `${fx(v / 1e3, 1)}k` : S(v); };
const fmtMs = (v: unknown): string => { const n = num(v); return !n ? "—" : n >= 1e3 ? `${fx(n / 1e3, 1)}s` : `${n}ms`; };
const fmtClock = (iso: unknown): string => { const d = iso ? new Date(S(iso)) : null; return !d || Number.isNaN(d.getTime()) ? "—" : d.toTimeString().slice(0, 8); };
const fmtDur = (sec: unknown): string => {
  const s = M.max(0, fl(num(sec))), m = fl(s / 60), hr = fl(m / 60), p = (a: number, ua: string, b: number, ub: string): string => `${a}${tr(ua)}${b ? ` ${b}${tr(ub)}` : ""}`;
  return s < 60 ? `${s}${tr("s| 秒")}` : m < 60 ? `${m}${tr("m| 分钟")}` : hr < 24 ? p(hr, "h| 小时", m % 60, "m| 分") : p(fl(hr / 24), "d| 天", hr % 24, "h| 小时");
};
const fmtAge = (ts: unknown): string => {
  if (!ts) return tr("Idle|空闲");
  const d = M.max(0, fl(now() / 1e3 - num(ts)));
  if (d < 60) return isZh() ? "刚刚" : `${d}s ago`;
  const [n, u]: [number, string] = d < 3600 ? [fl(d / 60), "m| 分钟"] : d < 86400 ? [fl(d / 3600), "h| 小时"] : [fl(d / 86400), "d| 天"];
  return `${n}${tr(u)}${tr(" ago|前")}`;
};
const fmtMoney = (u: unknown, c: unknown, d = 2, k = true): string => { const s = snapshot, z = isZh(); return k === false && !num(u) && !num(c) ? tr("Unpriced|未定价") : s?.currency_explicit ? `${s.currency_symbol || "$"}${fx(S(s[K_CC2]).toUpperCase() === "USD" ? u : c, d)}` : `${z ? "¥" : "$"}${fx(z ? c : u, d)}`; };
const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id), jDot = (a: string, b: string): string => (a && b ? `${a} · ${b}` : a || b);

const normWs = (r: unknown): string => { let s = S(r || "").trim(); if (s.startsWith("file://")) { s = s.slice(7); try { s = decodeURIComponent(s); } catch {} } return s.length > 1 ? s.replace(/\/+$/, "") : s; };
const sameWs = (ws: unknown, allWs?: unknown[]): boolean => { const dws = normWs(snapshot?.[K_DW]); return !dws || [ws, ...(Array.isArray(allWs) ? allWs : [])].map(normWs).filter(Boolean).some((w) => w === dws || w.startsWith(`${dws}/`) || dws.startsWith(`${w}/`)); };
const getHero = (): SessionItem | null => { const m = (snapshot?.sessions || []).filter((x) => !x[K_AR]); return m.find((x) => x[K_ACT]) || m[0] || null; };
const canDirectCid = (cid: string | undefined, ws: unknown, allWs?: unknown[]): boolean => !canMessage || !cid ? false : ownerCid ? ownerCid === cid : !!(getHero()?.id === cid && sameWs(ws, allWs) && num(snapshot?.summary?.running_main_count) <= 1);
const canDirectMsg = (it: SessionItem | null | undefined): boolean => !!(it && !it[K_IS] && canDirectCid(it.id, it[K_WS], it[K_WSS]));
const getCold = ({ cold_cache_breakdown: c, mid_loop_breakdown: mb, turn_start_cold_count: t, mid_loop_cold_count: m, post_compact_cold_count: p }: SessionItem): { t: number; m: number; p: number; s: number; r: number; w: number } =>
  ({ t: num(c?.turn_start_cold ?? t), m: num(c?.[K_MLC] ?? m), p: num(c?.[K_PCC] ?? p), s: num(mb?.slow_turn_self_expiry), r: num(mb?.replica_spillover), w: num(mb?.model_switch_cold) });

const getVerdict = (it: SessionItem): { cls: string; text: string } => {
  const lvl = safeLvl(it.level);
  if (it.just_compacted) return { cls: "in", text: tr("Compacted|已压缩") };
  if (it[K_SC] || lvl === "critical") return { cls: lvl === "critical" ? "er" : "wn", text: L(18) };
  const ctx = num(it[K_LCT]);
  return ctx >= (num(it.min_compact_tokens) || DEF_T[0]) * .72 || (ctx >= 12e4 && getCold(it).m > 0) ? { cls: "wn", text: tr("Notes ready|可存要点") } : { cls: "ok", text: "" };
};

const DOT_CLS: Record<string, string> = { running: "run", waiting: "wait", error: "err", ready: "idle" };
const getLiveDot = (it: SessionItem | null | undefined): string => (it?.live_status ? DOT_CLS[it.live_status] : undefined) || (it?.[K_ACT] ? "run" : "idle");
const getLivePhaseBadge = (it: SessionItem | null | undefined): { cls: string; text: string } | null => {
  const s = it?.live_status, p = it?.live_phase, sec = M.max(0, fl(num(it?.live_elapsed_sec))), el = sec > 0 ? ` · ${fmtDur(sec)}` : "";
  return p === "compacting" ? { cls: s === "waiting" ? "wn" : "in", text: `${tr("Compacting|正在压缩")}${el}` } : s === "waiting" ? { cls: "wn", text: `${L(38)}${el}` } : s === "error" ? { cls: "er", text: L(19) } : null;
};

const SUB_L: Record<string, string> = { slow_turn_self_expiry: "Cache expired|缓存过期", replica_spillover: "Cache dropped|缓存被清", model_switch_cold: "Model switched|换了模型" };
const coldKind = (t: TurnItem): string => { const k = t.cold_cache_kind, sr = t.cold_cache_sub_reason; return k === K_MLC ? tr((sr ? SUB_L[sr] : undefined) || (t.is_partial_cold ? "Partly reused|部分复用" : "Lost mid-turn|中途失效")) : tr(k === K_PCC ? "After compact|压缩后重建" : "New-turn miss|新一轮未命中"); };

const mkB = (c: string, a: string, tx: DomChild, id?: string, ex?: Record<string, string | number | boolean | null | undefined>): HTMLButtonElement => bt(`bt${c ? ` ${c}` : ""}`, a, tx, id, ex), pc0 = (p: boolean): string => `${p ? "p" : "s"} ${CM}`, idTxt = (id: string, cmp?: boolean | number): string => copiedId === id ? L(1) : cmp ? L(11) : shortId(id);
const mkId = (id: string | undefined, cmp?: boolean | number): HTMLButtonElement | null => id ? bt(`id${copiedId === id ? " ok" : ""}`, "ci", idTxt(id, cmp), id, { title: id }) : null;
const mkSw = (lbl = ""): HTMLButtonElement => bt(`sw ${CM}${allowAutoHandoff ? " on" : ""}`, "aho", [sp("tk", sp("th")), sp("", lbl)], "", { role: "switch", "aria-checked": S(allowAutoHandoff), title: L(7) });
const mkSeg = (fn: (i: number) => HTMLButtonElement): [HTMLDivElement, HTMLSpanElement, HTMLButtonElement[]] => { const sth = sp("sth"), bs = [0, 1, 2].map(fn); return [h("div", "sg ct0", { role: "tablist" }, sth, ...bs), sth, bs]; };
const wr = (l: string, v: string | undefined): HTMLDivElement | "" | undefined => v && dv("wr", `${tr(l)} ${v}`);
const relayNotes = (g: PendingGrant, sl?: string): HTMLElement[] => [g[K_HCID] && dv("ac", sp("", tr("New chat:|新会话：")), mkId(g[K_HCID])), wr("Keep:|保留：", g.preserve_points), wr("Next:|下一步：", g.resume_task), wr("Notes:|要点：", sl)].filter((x): x is HTMLDivElement => Boolean(x));
const relayBtns = (g: PendingGrant, isIn: boolean, canC: boolean, canN: boolean, id?: string): HTMLButtonElement[] => {
  const p = canC && g.kind === "compact";
  return [g[K_CC] ? mkB("s", isIn ? "ccc" : "cpc", L(2), id) : null, canC ? mkB(pc0(p), isIn ? "c0" : "c1", L(22), id) : null, canN ? mkB(pc0(!p), isIn ? "r0" : "r1", L(12), id) : null].filter((x): x is HTMLButtonElement => x !== null);
};
const patchId = (el: HTMLElement, cid: string | undefined, show: boolean, cmp = true): void => { if (!show || !cid) return hd(el, 1); hd(el, 0); el.dataset.i = cid; setCls(el, `id${copiedId === cid ? " ok" : ""}`); setTxt(el, idTxt(cid, cmp)); el.title = cid; };
const patchBdg = (el: HTMLElement, cls: string, txt: string | undefined, tip = ""): void => { hd(el, !txt); if (txt) { setCls(el, `bd ${cls}`); setTxt(el, txt); if (tip || el.title) el.title = tip; } };

const mkDetails = (raw: string): HTMLDetailsElement => h("details", "edet", 0, h("summary", "", 0, L(36)), h("code", "", 0, raw));
const ERRS: Array<[RegExp, string]> = [
  [/^(Closed|Not con)/i, "Lost connection to Antigravity.|与 Antigravity 的连接已断开。"],
  [/^(Timeout:|ui\/|tools\/)/i, "Antigravity didn't respond. Try again.|Antigravity 没有响应，请重试。"],
  [/^(Bad |Unsup|Parent |Init:)/i, "Couldn't start the panel. Reopen it.|面板启动失败，请重新打开。"],
  [/^No (server|tool)/i, "This panel can't run actions here.|当前环境不支持面板操作。"],
];
const errTxt = (raw: unknown): string => tr(ERRS.find(([r]) => r.test(S(raw || "").trim()))?.[1] || "Something went wrong. Try again.|操作失败，请重试。");

const buildSubTray = (it: SessionItem): HTMLDivElement | null => {
  const cid = it.id, tab = openTrays.get(cid), msg = (s: string): HTMLDivElement => dv("bx", dv("t2", s));
  if (!tab) return null;
  if (loadingKey === `${tab}:${cid}`) return msg(L(0));
  const rawD = trayMap[tab].get(cid), nd = tr("No data|暂无数据");
  if (tab === "turns") {
    const d = rawD as TurnsPayload | undefined;
    if (!d?.turns?.length) return msg(nd);
    const ts = d.turns;
    const ch = ts.slice(0, 24).reverse(), mx = M.max(1, ...ch.map((t) => num(t[K_CT])));
    return dv("bx", dv("t2", `${ch.length}/${num(d.total_turns)}`),
      dv("sk", ch.map((t) => h("span", `sr${t.is_checkpoint ? " in" : t.is_cold_cache ? " er" : ""}`, { s: `height:${M.max(12, rd((num(t[K_CT]) / mx) * 100))}%`, title: `#${num(t.turn)} · ${fmtK(t[K_CT])}` }))),
      dv("c g4", ts.slice(0, 10).map((t) => {
        const { is_checkpoint: ck, thinking_tokens: tk, response_tokens: rk, stream_tps: stp, e2e_tps: etp, cold_cache_kind: cck } = t;
        const hr = fx(t.cache_hit_rate), k = num(tk), r = num(rk), s0 = num(stp), e0 = num(etp), tt = fmtMs(t.ttft_ms);
        const cc: DomChild[] = t.is_cold_cache ? [sp("er tc", `${hr}%`), " ", h("span", `bd s ${cck === K_MLC ? "er" : cck === K_PCC ? "in" : "wn"}`, { title: t.cold_cache_reason }, coldKind(t))] : [`${hr}%`];
        return dv("tr", sp("", `#${num(t.turn)}${ck ? "·C" : ""}`), sp("", fmtClock(t.time_iso)), sp("e", h("b", "", 0, fmtK(t[K_CT])), k > 0 ? (r > 0 ? ` ${tr("T|思")}${rd((k / (k + r)) * 100)}%` : ` ${tr("thinking|思考")} ${fmtK(k)}`) : "", " · ", ...cc), sp("", ck ? tr("Checkpoint|压缩点") : s0 > 0 ? `${tt}${e0 > 0 ? ` · ${fx(s0)}/${fx(e0)}` : `/${fx(s0)}`}` : `${tt}/—`), sp("", fmtMoney(t.cost_usd, t.cost_cny, 2, it[K_PK])));
      })));
  }
  if (tab === K_HS) {
    const d = rawD as HotspotsPayload | undefined;
    if (!d?.found) return msg(d?.error || nd);
    const list = (d[K_HS] || []).slice(0, 5), rec = d.recommended_distill_range, spath = cDist.get(cid)?.[K_SN], busy = loadingKey === `distill:${cid}`, mx = M.max(1, ...list.map((x) => num(x.delta_tokens)));
    const rows = list.length ? list.map((x) => { const dl = num(x.delta_tokens), r = dl / mx; return h("div", "r g8", { title: fmtK(x.context_after) }, sp("m s b k", `#${num(x.turn)}`), sp("f e t2", `s${num(x.step_idx)} · ${x.cause || ""}`), sp("ht", h("span", `bf${r >= .85 ? " er" : r >= .6 ? " wn" : ""}`, { s: `width:${M.max(8, rd(r * 100))}%` })), sp("m s b cx", `+${fmtK(dl)}`)); }) : [dv("t2", "—")];
    return dv("bx", dv("kl", L(41)), ...rows, spath && dv("wr ok tc", "✓ ", h("code", "", 0, spath)), dv("ac ct0 abg", mkB("s", "dst", busy ? L(0) : rec ? (isZh() ? `保存第 ${rec[0]}–${rec[1]} 轮要点` : `Save turns ${rec[0]}–${rec[1]}`) : L(32), cid, { disabled: busy }), spath && mkB("", "cdp", tr("Copy|复制"), cid)));
  }
  const d = rawD as AdvicePayload | undefined;
  if (!d?.found) return msg(d?.reason || "—");
  const ok = !!d.gate_allowed, rs = num(it[K_RSC]), ds = loadingKey === `handoff:${cid}`;
  return dv("bx", dv("ac", sp(`bd ${ok ? "ok" : "wn"}`, L(ok ? 4 : 3)), sp(`bd ${rs > 0 ? "wn" : "ok"}`, subTxt(rs))),
    dv("t2", `${thrs(it).map((v, i) => `${((num(v) || DEF_T[i]) / 1e3) | 0}k`).join("/")} · >=${num(d.break_even_turns)}${tr("t| 轮")}${d[K_PK] !== false ? ` · ${fmtMoney(d.compact_overhead_usd, d.compact_overhead_cny)} / -${fmtMoney(d.per_turn_saving_usd, d.per_turn_saving_cny, 3)}/${tr("t|轮")}` : ""}`),
    ...[d.headline && dv("wr", d.headline), ...(d.gate_reasons || []).map((r) => dv("t2 wr", `· ${r}`))].filter(Boolean),
    dv("ac abg", ok ? mkB("s", "up", L(ds ? 0 : 22), cid, { disabled: ds }) : mkB("s", "cc", L(2)), ok && canMessage && !rs && sameWs(it[K_WS], it[K_WSS]) && mkB(pc0(!bnrPri), "ul", L(12), cid, { disabled: ds }), mkSw(L(6))));
};

const getLim = (it: SessionItem): number => num(it.context_limit || snapshot?.thresholds?.max) || 512e3;
const mountDetailBlock = (): DetailBlock => {
  const hn = dv("hn", "0%"), hs = dv("m s t3"), gf = dv("bf"), tks = [sp("gk"), sp("gk"), sp("gk er")];
  const gt = h("div", "gt", { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, gf, ...tks);
  const g1 = sp("e"), g2 = sp("k"), kf = dv("bf"), k1 = sp("e"), k2 = sp("m k");
  const ws: PillTuple[] = [0, 1, 2].map(() => { const a = sp("kl"), b = sp("m b e"), c = sp("m s t2 e"); return [dv("pl", a, b, c), a, b, c]; });
  const tm = hdv("t2 wr"), wn = hdv("bnr wr"), [sg, sth, tbs] = mkSeg((i) => bt("sb", `t-${TABS[i]}`, "")), trE = hdv(), ft = hdv("ac je bt0 abg");
  return [dv("dl", dv("hb", dv("c hl k", hn, hs), dv("f c g6", dv("c g4", gt, dv("jb s t3", g1, g2)), dv("c g4", dv("kt", kf), dv("jb s t2", k1, k2)))), dv("pls", ws[0][0], ws[1][0], ws[2][0]), tm, wn, sg, trE, ft), hn, hs, gt, gf, tks, g1, g2, kf, k1, k2, ws, tm, wn, sth, tbs, trE, ft, "", ""];
};

const patchDetailBlock = (d: DetailBlock, it: SessionItem, showId: boolean, isHero = false): void => {
  const cid = it.id || "", lvl = safeLvl(it.level), rs = num(it[K_RSC]), pk = it[K_PK], m0 = (a: keyof SessionItem, b: keyof SessionItem): number => num(it[a]) || num(it[b]);
  const lim = getLim(it), ctx = num(it[K_LCT]), ck = fmtK(ctx), ckc = num(it.checkpoint_count);
  const pct = clp((ctx / lim) * 100), cpct = fx(it.context_pct ?? pct, 1), rem = num(it.remaining_context_tokens ?? M.max(0, lim - ctx)), tn = lvlTone(lvl), tc = tn !== "ok" ? ` ${tn}` : "";
  const [, hn, hs, gt, gf, tks, g1, g2, kf, k1, k2, ws, tm, wn, sth, tbs, trE, ft] = d;
  setTxt(hn, `${cpct}%`); setCls(hn, `hn${tc}`); setTxt(hs, `${ck} / ${fmtK(lim)}`);
  ar(gt, "label", L(28)); ar(gt, "valuenow", rd(pct)); setCls(gf, `bf${tc}`); gf.style.width = `${fx(pct, 1)}%`;
  thrs(it).forEach((v, i) => { const n = num(v) || DEF_T[i]; tks[i].style.left = `${fx(M.min(100, (n / lim) * 100), 1)}%`; tks[i].title = `${(n / 1e3) | 0}k`; });
  setTxt(g1, isZh() ? `剩 ${fmtK(rem)}` : `${fmtK(rem)} left`);
  const jc = !!it.just_compacted, kb = jc && num(it.compact_summary_kb) > 0 ? `~${fx(it.compact_summary_kb, 1)} KB` : "", pc = it.pre_compact_tokens;
  setTxt(g2, jc && (pc || kb) ? jDot(pc ? `${tr("Before compact|压缩前")} ${fmtK(pc)}` : "", kb) : `${num(it.turns)} ${tr("turns|轮")}`);

  const chr = clp(num(it.cache_hit_rate)), cf = fx(chr, 1), ttft = m0("latest_ttft_ms", "median_ttft_ms"), stps = m0("median_stream_tps", "latest_stream_tps"), etps = num(it.e2e_tps);
  const s0 = fx(stps), e0 = fx(etps), sp0 = stps > 0 ? (etps > 0 ? `${s0}/${e0}` : s0) : "", spd = sp0 ? `${sp0} tok/s` : "—", cost = fmtMoney(it.cost_usd, it.cost_cny, 2, pk);
  setCls(kf, `bf${chr >= 80 ? "" : chr >= 50 ? " wn" : " er"}`); kf.style.width = `${fx(chr, 1)}%`;
  setTxt(k1, `${tr("Cache hit|缓存命中")} ${cf}%`); setTxt(k2, `${cost} · ${spd}`);

  const c = getCold(it), cN = num(it.cold_cache_count), mid = c.m > 0 && (c.s || c.r || c.w) ? `(${c.s}/${c.r}/${c.w})` : "";
  const pW = (i: number, lb: string, v1: string, v2: string, cl0: string | 0, tp = ""): void => { const [el, l, a, b] = ws[i]; setTxt(l, lb); setTxt(a, v1); setTxt(b, v2); setCls(b, cl0 || "m s t2 e"); if (tp || el.title) el.title = tp; };
  pW(0, L(28), `${ck} · ${cpct}%`, `${tr("Peak|峰值")} ${fmtK(it.peak_context_tokens || ctx)}`, 0);
  pW(1, tr("KV Cache|KV Cache"), `${cf}%`, cN ? `${cN}${tr(" miss| 次缓存失配")}${!isZh() && cN !== 1 ? "es" : ""}` : "0", `m s e${cN && c.m > 0 ? " er tc" : " t2"}`, cN ? `${c.t}/${c.m}${mid}/${c.p}` : "");
  pW(2, tr("Speed & Cost|速度与费用"), `TTFT ${fmtMs(ttft)} · ${spd}`, cost, 0, jDot(stps > 0 && etps > 0 ? `${tr("Output|输出")} ${s0} · ${tr("Overall|整体")} ${e0} tok/s` : "", ckc ? `C×${ckc}` : ""));

  const thk = num(it.total_thinking_tokens), outT = thk + num(it.total_response_tokens), ls = num(it.last_loop_steps), tp = rd(num(it.thinking_share_pct ?? (outT > 0 ? (thk / outT) * 100 : 0)));
  const mt = jDot(thk > 0 ? `${tr("Output|输出")} ${fmtK(outT)}${isZh() ? `（思考 ${tp}%）` : ` (${tp}% thinking)`}` : "", ls > 0 ? `${isZh() ? `本轮 ${ls} 步` : `${ls} steps this turn`} · ${fmtK(m0("last_loop_output_tokens", "last_loop_thinking_tokens"))} · ${fmtMoney(it.last_loop_cost_usd, it.last_loop_cost_cny, 2, pk)}` : "");
  hd(tm, !mt); if (mt) setTxt(tm, mt);

  const rawEm = S(it.live_error || "").trim(), xmod = it.cross_model_compact ? tr("Compacting with a different model can't reuse the cache, so it'll be slower.|换模型压缩用不上已有缓存，会慢一些。") : "", rawEn = rawEm && isZh() && !/[\u4e00-\u9fff]/.test(rawEm), stepF = /^(A step failed\.|Step error)$/.test(rawEm), nm = jDot(rawEm ? (stepF || rawEn ? tr("A step failed.|有一步执行失败。") : rawEm) : "", xmod);
  hd(wn, !nm);
  if (nm) { const k0 = rawEm ? "er" : "wn"; setCls(wn, `bnr wr ${k0}`); sa(wn, "data-k", k0); rawEn && !stepF ? setCh(wn, [dv("", nm), mkDetails(rawEm)]) : setTxt(wn, nm); }

  const cur = openTrays.get(cid), ti = cur ? TABS.indexOf(cur) : -1;
  hd(sth, ti < 0); if (ti >= 0) sth.style.transform = `translateX(${ti * 100}%)`;
  [tr("Turns|轮次"), L(41), L(42)].forEach((lb, i) => { setTxt(tbs[i], lb); tbs[i].dataset.i = cid; cl(tbs[i], "on", cur === TABS[i]); ar(tbs[i], "selected", S(cur === TABS[i])); });

  const tSig = cur ? S([lang, cid, cur, loadingKey, subTrayRev, rs, allowAutoHandoff, canMessage, bnrPri]) : "";
  if (tSig !== d[18]) { d[18] = tSig; hd(trE, !cur); setCh(trE, cur ? [buildSubTray(it)] : []); }
  const dm = canDirectMsg(it), fSig = S([lang, cid, lvl, !!it[K_SC], jc, !!it[K_IS], dm, confirmSendId === cid, showId, copiedId === cid, bnrPri, isHero]);
  if (fSig !== d[19]) {
    d[19] = fSig;
    const ccB = mkB("s", "cc", L(2));
    const a: HTMLButtonElement[] = (it[K_SC] || lvl === "critical") && !jc ? (it[K_IS] ? [mkB("s", "csr", tr("Copy handoff note|复制接续说明"), cid)] : !dm ? [ccB, mkB("", "crm", tr("Copy reminder|复制提醒"), cid)] : confirmSendId === cid ? [mkB("", "ask", L(40)), ccB, mkB(pc0(!bnrPri), "yes", tr("Confirm|确认"), cid)] : [ccB, mkB(`s ${CM}`, "ask", tr("Remind|提醒"), cid), mkB(pc0(isHero && !bnrPri), "up", L(22), cid)]) : [];
    if (showId && cid) a.push(mkB("", "ci", L(copiedId === cid ? 1 : 11), cid, { title: cid }));
    hd(ft, !a.length); setCh(ft, a);
  }
};

const reconcile = <T, R extends [HTMLElement, ...unknown[]]>(box: HTMLElement, map: Map<string, R>, list: T[], getId: (item: T) => string, mk: (id: string) => R, patch: (rec: R, item: T) => void): void => {
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const id = getId(item); seen.add(id);
    let rec = map.get(id); if (!rec) { rec = mk(id); map.set(id, rec); }
    patch(rec, item);
    if (box.children[i] !== rec[0]) box.insertBefore(rec[0], box.children[i] || null);
  });
  for (const [k, rec] of map) if (!seen.has(k)) { rec[0].remove(); map.delete(k); }
};

const patchOpen = <T extends unknown[]>(box: HTMLElement, arr: T, idx: number, it: SessionItem | null): void => { if (it) { if (!arr[idx]) { arr[idx] = mountDetailBlock(); box.appendChild((arr[idx] as DetailBlock)[0]); } hd(box, 0); patchDetailBlock(arr[idx] as DetailBlock, it, true, false); } else if (!box.hidden) hd(box, 1); };
const clearMaps = (): void => { rowNodes.clear(); pinNodes.clear(); heroChipNodes.clear(); };
const dt0 = (): HTMLSpanElement => sp("dt idle"), id0 = (): HTMLButtonElement => bt("id", "ci", "", "", { h: 1 });
const ensureDashboardMount = (root: HTMLElement): void => {
  if (mountedMode === DB && ui) return;
  clearMaps(); mountedMode = DB; settingsSig = ""; uThBtns = [];
  const [emb, dot] = mkEmb(), mkG = (): [HTMLDivElement, HTMLDivElement, HTMLDivElement] => { const gh = hdv("kl"), ls = dv("cd ls"); return [hdv("c g6", gh, ls), gh, ls]; };
  uDot = dot; uSwp = hdv("swp"); uMi = hd0("span", "mi e"); uMt = sp("m s t3 e"); uAb = bt("id ct0", "aut", "");
  uGear = bt("ib ct0", "cfg", sv(14, ["M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z", "M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8"]));
  uRi = sv(14, ["M13 8a5 5 0 1 1-1.3-3.4M13 2.5v2.6h-2.6"]); uRb = bt("ib", "ref", uRi);
  const hdEl = h("header", "hd", 0, emb, h("h1", "wm", 0, "Context Radar"), dv("r f", uMi, uMt), dv("r k", uAb, uGear, uRb), uSwp);

  const bDt = dt0(), bTt = sp("b e"), bId = id0(), bBg = hb("in"), bDs = bt("ib", "dis", "×", "", al(L(21))), bBd = hdv("c g4 t2"), bAc = hdv("ac je abg");
  const bnr = h("div", "bnr", { "data-k": "in", h: 1 }, dv("jb", dv("r f", bDt, bTt, bId), dv("r k", bBg, bDs)), bBd, bAc);
  uB = [bnr, bDt, bTt, bId, bBg, bDs, bBd, bAc, ""];
  uSet = hdv("cd");

  const hDt = dt0(), hTt = sp("wm e"), hMd = hb("t3"), hPh = hb(), hCw = hb("wn"), hVd = hb(), hId = id0();
  const hBlk = mountDetailBlock(), hCh = dv("r w"), hST = hdv("ty"), hDk = hdv("dk bt0", hCh, hST);
  const he = hd0("section", "cd hero", dv("jb", dv("r f", hDt, hTt), dv("ac je", hMd, hPh, hCw, hVd, hId)), hBlk[0], hDk);
  uH = [he, hDt, hTt, hMd, hPh, hCw, hVd, hId, hBlk, hDk, hCh, hST, null];

  const [sg, sth, tabs] = mkSeg((i) => bt("sb", "tab", "", FIDS[i], { role: "tab" })), sw = mkSw(""), br = hdv("jb w", sg, sw);
  uF = [br, sg, sth, tabs, sw, sw.lastElementChild as HTMLElement];
  [uPG, uPGh, uPLs] = mkG(); [uRG, uRGh, uLs] = mkG(); uCap = hdv("cf"); uRG.appendChild(uCap);
  const emP = dv(""), emB = mkB("s", "ref", L(20)), em = hdv("cd em", mkEmb(0, 1)[0], emP, emB);
  uEm = [em, emP, emB]; uGr = dv("gd", uPG, uRG); setCh(root, [dv("c sh", hdEl, bnr, uSet, he, br, uGr, em)]); ui = { he };
};

const ensureHandoffMount = (root: HTMLElement): void => { if (mountedMode === HC && ui) return; clearMaps(); lastHandoffSig = ""; mountedMode = HC; uHl = dv(""); setCh(root, [h("div", "c sh", { s: "padding:4px" }, uHl)]); ui = { he: null }; };

const patchBannerSlot = (): void => {
  const [bnr, bDt, bTt, bId, bBg, bDs, bBd, bAc] = uB;
  bnrPri = false;
  const g = !errorText && pg();
  if (!errorText && (!g || !sameWs(g[K_WS], g[K_WSS]))) return hd(bnr, 1);
  const setK = (k: string): void => { hd(bnr, 0); setCls(bnr, `bnr ${k}`); sa(bnr, "data-k", k); ar(bDs, "label", L(21)); };
  if (errorText) {
    setK("er"); setCls(bDt, "dt err"); const mp = errTxt(errorText); setTxt(bTt, mp); patchBdg(bBg, "er", L(19)); bDs.dataset.i = ""; hdA(bId, bAc);
    const sig = `e:${lang}:${errorText}`;
    if (sig !== uB[8]) { uB[8] = sig; const sd = errorText !== mp; hd(bBd, !sd); setCh(bBd, sd ? [mkDetails(errorText)] : []); }
    return;
  }
  if (!g) return;
  const gid = g[K_GID] || "", nc = g[K_HCID] || "", cs = g[K_CS] || "", cid = g[K_CID], isCmp = g.kind === "compact";
  const busy = busyGrantId === gid, rs = num(g[K_RSC]), cDone = cs === "sent" || cs === "acp_compacted", done = !!(nc || cDone);
  const canN = !done && !rs && !busy && canCallTools && !!gid, canC = canN && !!g[K_CC] && canDirectCid(cid, g[K_WS], g[K_WSS]);
  bnrPri = canC || canN; setK(done ? "ok" : rs > 0 ? "wn" : "ac"); setCls(bDt, `dt ${done || !rs ? "run" : "wait"}`);
  setTxt(bTt, L(nc ? 15 : cDone ? 16 : isCmp ? 17 : 18)); patchId(bId, cid, !!cid, true);
  patchBdg(bBg, done ? "ok" : rs > 0 ? "wn" : "in", done ? L(39) : rs > 0 ? subTxt(rs) : busy ? L(isCmp ? 10 : 5) : L(38));
  bDs.dataset.i = gid;
  const sig = S([lang, gid, nc, cs, busy, rs, canC, canN, copiedId, g.preserve_points, g.resume_task]);
  if (sig !== uB[8]) { uB[8] = sig; const ls = relayNotes(g), bs = relayBtns(g, false, canC, canN, gid); hd(bBd, !ls.length); setCh(bBd, ls); hd(bAc, !bs.length); setCh(bAc, bs); }
};

const mkSel = (k: string, opts: Array<[string | number, string]>, cur: string | number): HTMLSelectElement => { const s = h("select", "si", { "data-s": k }, ...opts.map(([v, t]) => h("option", "", { value: v }, t))); s.value = S(cur); return s; };
const numI = (k: string, v: number, stp: number, mn: number, mx: number): HTMLInputElement => h("input", "si", { "data-s": k, type: "number", step: stp, min: mn, max: mx, value: S(v) });
const syncThemeUi = (): void => {
  if (!uThInd || !uThBtns.length) return;
  uThInd.style.transform = `translateX(${M.max(0, THS.indexOf(themePref)) * 100}%)`;
  uThBtns.forEach((b, i) => { const on = themePref === THS[i]; cl(b, "on", on); ar(b, "checked", S(on)); });
};
const patchSettingsDrawer = (): void => {
  if (!uSet) return;
  hd(uSet, !settingsOpen); cl(uGear, "on", settingsOpen); ar(uGear, "label", L(31)); ar(uGear, "expanded", S(settingsOpen));
  if (!settingsOpen) return;
  const u = snapshot?.[K_US] || {}, spath = snapshot?.settings_path || "", serr = snapshot?.settings_error || "";
  const sig = S([lang, settingsSaving, spath, serr, JSON.stringify(u), allowAutoHandoff, canCallTools]);
  if (sig === settingsSig) { syncThemeUi(); return; }
  settingsSig = sig;
  const fd = (l: string, c: HTMLElement): HTMLLabelElement => h("label", "sf", 0, sp("s t2", tr(l)), c), dOpt = (v: number): [number, string] => [v, v < 0 ? tr("Paused|暂停") : v ? fmtDur(v) : L(37)], z = isZh();
  const [tsg, tsth, tbs] = mkSeg((i) => bt(`sb${themePref === THS[i] ? " on" : ""}`, "thm", tr(["Follow Agy|跟随 Agy", "Light|浅色", "Dark|深色"][i]), THS[i], { role: "radio", "aria-checked": S(themePref === THS[i]) }));
  tsg.className = "sg"; tsg.setAttribute("role", "radiogroup"); ar(tsg, "label", tr("Theme|外观")); uThInd = tsth; uThBtns = tbs; syncThemeUi();
  const sels: Array<[string, string, Array<[string | number, string]>, string | number]> = [
    ["lang", "Language|语言", [["auto", L(37)], ["en", "English"], ["zh-CN", "简体中文"]], u.lang || "auto"],
    [K_CC2, "Currency|货币", [["auto", L(37)], ["USD", "USD $"], ["CNY", "CNY ¥"]], u[K_CC2] || "auto"],
    [K_PI, "Refresh rate|刷新频率", [0, 2, 5, 10, 30].map(dOpt), num(u[K_PI])],
    [K_BP, "Background refresh|后台刷新", [0, 5, 15, 30, 60, -1].map(dOpt), u[K_BP] ?? 0],
  ];
  setCh(uSet, [
    dv("jb", sp("wm", L(31)), bt("ib", "cfg", "×", "", al(L(21)))),
    serr ? dv("bnr wn wr", tr("settings.json has an error. Using your last good settings.|配置文件有误，暂时沿用上次的有效设置。")) : null,
    dv("sf", sp("s t2", tr("Theme|外观")), tsg),
    dv("sgr", ...sels.map(([k, l, o, c]) => fd(l, mkSel(k, o, c))),
      fd("FX rate (1 USD)|汇率（1 USD）", numI(K_FX, u[K_FX] || 7.2, .01, .01, 1e3)),
      fd("Suggest /compact (K Tokens)|建议 /compact 阈值（万 Token）", numI(K_CTH, rd((u[K_CTH] || 36e4) / (z ? 1e4 : 1e3)), z ? 1 : 10, z ? 10 : 100, z ? 200 : 2e3))),
    h("label", "r", 0, h("input", "", { "data-s": K_AAH, type: "checkbox", ...((u[K_AAH] ?? allowAutoHandoff) ? { checked: 1 } : {}) }), sp("b", L(6)), sp("s t3", L(7))),
    dv("jb bt0 w", spath ? bt("id", "csp", spath, spath, { title: spath }) : sp(""), mkB("p", "svs", L(settingsSaving ? 33 : 32), "", { disabled: settingsSaving || !canCallTools })),
  ]);
};

const createRowEntry = (cid: string): RowEntry => {
  const cs = [sp("t3 s k", "▸"), dt0(), hb("ac"), hb("t3"), sp("rt e"), hb(), hb(), sp("cx"), sp("ag")];
  const r = h("div", "rw", { role: "button", tabindex: 0, "data-a": "row", "data-i": cid }, ...cs), trB = hdv("ty");
  return [h("div", "it", { "data-i": cid }, r, trB), r, cs, trB, null];
};

const patchRowList = (box: HTMLElement | null | undefined, items: Array<[SessionItem, boolean]>, map: Map<string, RowEntry>): void => {
  if (!box) return;
  hd(box, !items.length);
  reconcile(box, map, items, ([it]) => it.id, createRowEntry, (rec, [it, isSub]) => {
    const [, r, [c, d, p, sb, t, pEl, vEl, x, a], trB] = rec, cid = it.id, lvl = safeLvl(it.level), tn = lvlTone(lvl), open = openRowId === cid, v = getVerdict(it), pb = getLivePhaseBadge(it);
    setCls(r, `rw${isSub ? " sub" : ""}${lvlCls(lvl)}`); ar(r, "expanded", S(open));
    setTxt(c, open ? "▾" : "▸"); setCls(d, `dt ${getLiveDot(it)}`); patchBdg(pEl, pb?.cls || "", pb?.text || "");
    patchBdg(p, "ac", !isSub && it.pinned ? L(25) : ""); patchBdg(sb, "t3", isSub ? L(it.is_side_question ? 30 : 29) : "");
    setTxt(t, it.title); t.title = `${it.title} (${cid})`;
    patchBdg(vEl, v.cls, v.text); setCls(x, `cx${tn !== "ok" ? ` ${tn}` : ""}`);
    setTxt(x, fmtK(it[K_LCT])); setTxt(a, fmtAge(it.sidebar_sort_ts || it.effective_last_active_ts || it.last_active_ts));
    patchOpen(trB, rec, 4, open ? it : null);
  });
};

const patchHeroDock = (subs: SessionItem[]): void => {
  hd(uH[9], !subs.length);
  let openSub: SessionItem | null = null;
  reconcile(uH[10], heroChipNodes, subs, (s) => s.id, (cid) => { const dt = dt0(), nm = sp("e"), pc = sp("m"); return [bt("id sc", "row", [dt, nm, pc], cid), dt, nm, pc]; }, (rec, sub) => {
    const cid = sub.id, open = openRowId === cid, pct = sub.context_pct ?? clp((num(sub[K_LCT]) / getLim(sub)) * 100);
    if (open) openSub = sub;
    setCls(rec[1], `dt ${getLiveDot(sub)}`); setTxt(rec[2], sub.agent_name || sub.title); setTxt(rec[3], `${fx(pct, 0)}%`);
    rec[0].title = `${sub.title} · ${fmtK(sub[K_LCT])}`; cl(rec[0], "on", open); ar(rec[0], "expanded", S(open));
  });
  patchOpen(uH[11], uH, 12, openSub);
};

const patchHeroSlot = (hero: SessionItem | null, heroSubs: SessionItem[] = [], cwN = 0, showCw = false): void => {
  const [he, hDt, hTt, hMd, hPh, hCw, hVd, hId, hBlk] = uH;
  if (!hero) { hd(he, 1); return patchHeroDock([]); }
  const cid = hero.id || "", lvl = safeLvl(hero.level), v = getVerdict(hero), pb = getLivePhaseBadge(hero);
  hd(he, 0); ar(he, "label", tr("Current session|当前会话")); setCls(he, `cd hero${lvlCls(lvl)}`);
  setCls(hDt, `dt ${getLiveDot(hero)}`); patchBdg(hPh, pb?.cls || "", pb?.text || ""); setTxt(hTt, hero.title); hTt.title = `${hero.title} (${cid})`;
  patchBdg(hMd, "t3", hero.model_short || hero.model_display);
  patchBdg(hCw, "wn", showCw ? (isZh() ? `并行 ${cwN}` : `${cwN} in parallel`) : "", showCw ? tr("Running more than 2 large agents at once slows them all down.|同时运行超过 2 个大型 Agent 会互相拖慢。") : "");
  patchBdg(hVd, v.cls, v.text); patchId(hId, cid, true, false);
  patchDetailBlock(hBlk, hero, false, true); patchHeroDock(heroSubs);
};

const patchSessionList = (items: Array<[SessionItem, boolean]>): void => patchRowList(uLs, items, rowNodes);

const isHandoffLocked = (): boolean => /^(sen|com|old)/.test(handoffStatus);
const patchHandoffView = (): void => {
  const c = handoffCard, sig = c ? S([lang, c.mode, c.blocked, c[K_GID], handoffStatus, c[K_HCID], c[K_CS], copiedId, microMsg, canCallTools]) : lang;
  if (sig === lastHandoffSig) return;
  lastHandoffSig = sig;
  if (!c) return setCh(uHl, [dv("cd em", mkEmb(0, 1)[0], dv("", L(0)))]);
  const card = (dc: string | 0, tt: string, bc: string, bt0: string, ns: DomChild[], as: DomChild[]): HTMLDivElement => dv("cd", dv("jb", dv("r f", mkEmb(dc)[0], sp("wm e", tt), mkId(c[K_CID], 1)), sp(`bd ${bc}`, bt0)), ns.length && dv("pl g4 t2", ...ns), as.length && dv("ac je bt0 abg", ...as));
  if (c.mode === HB || c.blocked) return setCh(uHl, [card(0, L(13), "in", L(3), (c.reasons || []).map((r) => dv("wr", `· ${r}`)), [])]);
  const rs = num(c[K_RSC]), done = handoffStatus === "sent" || handoffStatus === "compacted", isCmp = c.kind === "compact", rL = L(isCmp ? 10 : 5);
  const [bCls, bTxt] = ({ sending: ["wn", rL], sent: ["ok", L(15)], compacted: ["ok", L(16)], old: ["t3", L(14)] } as Record<string, [string, string]>)[handoffStatus] || ["in", handoffStatus === "pending" && c[K_AAH] ? rL : rs > 0 ? subTxt(rs) : L(4)];
  const canA = !c[K_HCID] && !rs && !isHandoffLocked() && canCallTools && !!c[K_GID];
  setCh(uHl, [card(done ? "run" : "wait", isCmp ? L(17) : L(42), bCls, bTxt, relayNotes(c, c.scratch_note_path), [...relayBtns(c, true, canA && !!c[K_CC], canA), microMsg && sp("mi", microMsg)].filter(Boolean))]);
};

const render = (): void => {
  const root = D.getElementById("app"); if (!root) return;
  if (viewMode === HC) { ensureHandoffMount(root); return patchHandoffView(); }

  ensureDashboardMount(root);
  const snap = snapshot, pollSec = rd(pollMs / 1e3), [br, sg, sth, tabs, sw, swL] = uF, [em, emP, emB] = uEm;
  const clk = snap ? fmtClock(snap[K_GA]) : loadingInitial ? L(0) : "—";
  ar(uRb, "label", L(20)); hd(uMi, !microMsg); if (microMsg) setTxt(uMi, microMsg);
  setTxt(uMt, clk); uAb.title = uMt.title = uRb.title = `${clk} · ${fmtDur(pollSec)} · ${serverMs ?? "—"}/${ewmaRttMs ?? "—"}ms`; cl(uRi, "spn", showSpinner);
  setTxt(uAb, autoRefresh ? `${L(37)} · ${fmtDur(pollSec)}` : tr("Manual|手动")); cl(uAb, "ac", autoRefresh);
  hd(uSwp, !(loadingInitial || (refreshing && !snap)));

  patchBannerSlot(); patchSettingsDrawer();
  if (!snap) { setCls(uDot, `dt ${errorText ? "err" : "idle"}`); hdA(ui?.he, br, uPG, uRG); hd(em, 0); setTxt(emP, L(loadingInitial ? 0 : 24)); setTxt(emB, L(20)); hd(emB, loadingInitial); return; }

  const s = snap.summary || {}, mains = snap.sessions || [], isAct = filterTab === "active", showSubs = filterTab === "subs", isArch = filterTab === K_AR;
  const hero = isAct ? getHero() : null, heroSubs = hero ? (hero[K_SA] || []).filter((x) => x[K_ACT]) : [], cwN = num(s.active_carbon_count);
  setCls(uDot, `dt ${errorText ? "err" : hero ? getLiveDot(hero) : mains.some((x) => x[K_ACT]) ? "run" : "idle"}`);

  const pinItems: Array<[SessionItem, boolean]> = [], recItems: Array<[SessionItem, boolean]> = [], orpItems: Array<[SessionItem, boolean]> = [];
  const pushS = (dst: Array<[SessionItem, boolean]>, a: SessionItem[] | undefined): void => (a || []).forEach((x) => { if (showSubs || x[K_ACT]) dst.push([x, true]); });
  let pinCnt = 0, recCnt = 0, arN = 0;
  for (const m of mains) {
    if (m[K_AR]) arN++;
    if (isAct ? m[K_AR] || hero?.id === m.id : showSubs ? m[K_AR] || !m[K_SA]?.length : !m[K_AR]) continue;
    const dst = isAct && m.pinned ? (pinCnt++, pinItems) : (recCnt++, recItems);
    dst.push([m, false]); pushS(dst, m[K_SA]);
  }
  if (!isArch) pushS(orpItems, snap.orphan_subagents);

  patchHeroSlot(hero, heroSubs, cwN, !!(s.carbon_concurrency_warning && cwN >= 3));
  hd(br, 0); ar(sg, "label", tr("Filter|筛选")); sth.style.transform = `translateX(${M.max(0, FIDS.indexOf(filterTab)) * 100}%)`;
  const subTot = s.total_subagent_count ?? num(s.shown_subagent_count) + num(s.history_subagents_hidden_count), archTot = s.total_archived_count ?? (arN || s.archived_hidden_count);
  const cnts = [s.total_main_count ?? (arN ? mains.length - arN : s.shown_main_count), subTot, archTot];
  ["Sessions|会话", "Subagents|子代理", "Archived|已归档"].forEach((lb, i) => { const k = num(cnts[i]), on = filterTab === FIDS[i]; setTxt(tabs[i], `${tr(lb)}${k ? ` (${k})` : ""}`); cl(tabs[i], "on", on); ar(tabs[i], "selected", S(on)); });
  cl(sw, "on", allowAutoHandoff); ar(sw, "checked", S(allowAutoHandoff)); sw.title = L(7); setTxt(swL, L(6));

  const split = isAct && pinCnt > 0 && recCnt > 0, all = split ? [...recItems, ...orpItems] : [...pinItems, ...recItems, ...orpItems];
  cl(uGr, "s2", split);
  hd(uPG, !split); hd(uPGh, !split); if (split) setTxt(uPGh, `${L(25)} · ${pinCnt}`); patchRowList(uPLs, split ? pinItems : [], pinNodes);
  hd(uRG, !all.length); hd(uRGh, !split); if (split) setTxt(uRGh, `${L(26)} · ${recCnt}`); patchSessionList(all);
  const capShown = showSubs ? num(s.shown_subagent_count) : isArch ? arN : 0, capTotal = num(showSubs ? subTot : isArch ? archTot : 0);
  hd(uCap, !(capTotal > capShown && capShown > 0));
  if (capTotal > capShown && capShown > 0) setTxt(uCap, isZh() ? `显示最近 ${capShown} 个，共 ${capTotal} 个` : `Showing latest ${capShown} of ${capTotal}`);
  hd(em, hero || pinItems.length || all.length);
  if (!em.hidden) { setTxt(emP, [L(24), tr("No subagents|暂无子代理"), tr("Nothing archived|暂无归档")][FIDS.indexOf(filterTab)]); setTxt(emB, L(20)); hd(emB, 0); }
};

const flashMicro = (msg: string): void => { if (!msg) return; microMsg = msg; render(); ct(microTimer); microTimer = st(() => { microMsg = ""; render(); }, 2200); };
const copyText = async (text: string, okMsg?: string): Promise<boolean> => {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { const ta = h("textarea", "", { s: "position:fixed;opacity:0" }); ta.value = text; D.body.appendChild(ta); ta.select(); try { ok = D.execCommand("copy"); } catch {} ta.remove(); }
  flashMicro(ok ? okMsg || "" : L(27)); return ok;
};
const cpCompact = (cmd = "/compact"): Promise<boolean> => copyText(cmd, `${L(1)} /compact`);
const copyCid = async (cid: string): Promise<void> => { if (await copyText(cid, `${L(1)} ID`)) { copiedId = cid; render(); ct(copiedTimer); copiedTimer = st(() => { if (copiedId === cid) { copiedId = null; render(); } }, 1500); } };
const findSession = (cid: string): SessionItem | undefined => snapshot ? (snapshot.sessions || []).flatMap((s) => [s, ...(s[K_SA] || [])]).concat(snapshot.orphan_subagents || []).find((x) => x.id === cid) : undefined;
const extractRelayCid = (r: UiMessageResponse | null | undefined): string => {
  const meta = r?._meta?.[AG_M] as { conversationId?: unknown } | undefined;
  return S(meta?.conversationId || "").trim();
};

const recAct = (action: string, gid: string, extra?: Record<string, unknown>): Promise<unknown> | 0 => canCallTools && gid ? uiAct({ action, grant_id: gid, ...extra }).catch(() => {}) : 0;
async function executeDispatch(p: PendingGrant, claimMode: string, isInline: boolean, isCmp = false): Promise<void> {
  cancelAutoCmp();
  const gid = p[K_GID] || "", cmd = p[K_CC] || "/compact", cid = p[K_CID] || "", ws = p[K_WS] || "", dws = snapshot?.[K_DW], txt = isCmp ? cmd : p[K_HP] || "", isMan = claimMode.startsWith("manual");
  if (!txt) return;
  const fail = (m: string): void => { if (isInline) handoffStatus = "manual"; m ? flashMicro(m) : render(); }, mf = (m: string): void => fail(isMan ? m : ""), ow = L(23);
  if (!canMessage || (isCmp && !isInline && !canDirectCid(cid, ws, p[K_WSS]))) { if (isMan) await cpCompact(cmd); return fail(""); }
  if (!isInline && !sameWs(ws, p[K_WSS])) { if (isMan) await copyText(cmd); return mf(ow); }
  if ((p[K_RSC] || 0) > 0) return mf(L(9));
  if (!canCallTools || !gid) { if (isMan) await cpCompact(cmd); return mf(L(14)); }
  try {
    const sc = await uiSc<ClaimGrantPayload>({ action: "claim_grant", [K_GID]: gid, [K_CID]: cid, [K_WS]: isInline ? ws || dws : dws || ws, claim_mode: claimMode });
    if (!sc?.claimed) {
      const r = sc?.reason || "";
      if (isInline) { if (sc?.[K_HCID] && handoffCard) { handoffCard[K_HCID] = sc[K_HCID]; handoffStatus = "sent"; } else { handoffStatus = /^(already_|session_adv)/.test(r) ? "old" : "manual"; } return render(); }
      return mf(r === "running_subagents_active" ? L(9) : r.endsWith("mismatch") ? ow : L(14));
    }
  } catch { return mf(L(27)); }
  isInline ? (handoffStatus = "sending") : (busyGrantId = gid || "pending"); render();
  const dst = isInline ? handoffCard : pg()?.[K_GID] === gid ? pg() : null, rc = (st0: string): Promise<unknown> | 0 => recAct(K_RC, gid, { status: st0 });
  const failCmp = async (st0: string, m: string): Promise<void> => { if (isCmp) { await rc(st0); if (dst) dst[K_CS] = st0; await cpCompact(cmd); } fail(m); }, clip = (v: unknown): string => S(v || "").trim().slice(0, 120);
  try {
    const res = await sendTxt(txt, isCmp ? 0 : { [AG_M]: { target: "new" } });
    if (res?.[K_ERR]) { const d = clip(res?.content?.[0]?.text || res?.error?.message); return await failCmp(`fallback_copied${d ? `:${d}` : ""}`, `${L(1)} /compact`); }
    const newCid = isCmp ? "" : extractRelayCid(res);
    await (isCmp ? rc("sent") : recAct("record_relay", gid, { [K_HCID]: newCid }));
    if (dst) { dst[isCmp ? K_CS : K_HCID] = isCmp ? "sent" : newCid; if (!isInline) dst.claimed = true; }
    if (isInline) handoffStatus = isCmp ? "compacted" : "sent";
    flashMicro(L(isCmp ? 16 : 15));
  } catch (err: unknown) { await failCmp(`error:${clip((err as { message?: unknown } | null)?.message || err || "failed")}`, L(27)); }
  finally { busyGrantId = null; render(); }
}

function canAutoRelay(p: PendingGrant | null | undefined, isInline: boolean): string {
  if (!p?.[K_GID] || !canMessage || !canCallTools || D.hidden) return "";
  const isCmp = p.kind === "compact", gid = p[K_GID], cid = p[K_CID];
  if (isCmp ? (!p[K_CC] || p.acp_proxy_active) : !p[K_HP]) return "";
  if (!isInline && (isCmp ? !canDirectCid(cid, p[K_WS], p[K_WSS]) : (!sameWs(p[K_WS], p[K_WSS]) || (ownerCid ? ownerCid !== cid : (!snapshot?.[K_DW] || num(snapshot?.summary?.running_main_count) > 1))))) return "";
  if (!(isInline ? !!p[K_AAH] : !!(allowAutoHandoff && p[K_AAH] !== false)) || p.auto_fire === false || p.claimed || p[K_HCID] || p[K_CS] || (p[K_RSC] ?? 0) > 0 || attemptedGrants.has(gid)) return "";
  return isCmp ? "auto_compact" : "auto_handoff";
}

function maybeAutoRelay(p: PendingGrant | null | undefined, isInline: boolean): void {
  const mode = canAutoRelay(p, isInline);
  if (!mode || !p?.[K_GID]) return;
  const gid = p[K_GID], isCmp = mode === "auto_compact";
  attemptedGrants.add(gid);
  if (!isCmp) return void executeDispatch(p, mode, isInline, false);
  cancelAutoCmp();
  autoCmpTimer = st(() => {
    autoCmpTimer = null;
    const cur = isInline ? handoffCard : pg();
    if (!cur || cur[K_GID] !== gid || cur.claimed || cur[K_CS] || cur[K_HCID] || (cur[K_RSC] ?? 0) > 0 || (isInline && isHandoffLocked())) return;
    if (D.hidden) { attemptedGrants.delete(gid); return; }
    void executeDispatch(cur, mode, isInline, true);
  }, isInline ? 1500 : 2000);
}

function applySnapshot(snap: SnapshotData, persist = true): void {
  if (typeof snap[K_ST]?.[K_AAH] === "boolean") allowAutoHandoff = snap[K_ST][K_AAH];
  if (!langLocked && snap[K_ST]?.lang) { const p = parseLoc(snap[K_ST].lang); if (p) DE.lang = lang = p; }
  if (!themeLocked && snap[K_US]?.[K_TH]) { themePref = parseTheme(snap[K_US][K_TH]); bridge.setThemePreference?.(themePref); }
  if (snap[K_US]?.[K_LHT]) lastHostTheme = parseHostTheme(snap[K_US][K_LHT]);
  if (snap[K_DIG]) lastDigest = snap[K_DIG];
  snapshot = snap;
  if (persist && viewMode === DB && snap.mode === K_SN0) {
    try {
      if (typeof localStorage < "u") {
        const rest: SnapshotData = { ...snap }; delete rest[K_PG]; if (snap[K_PG]) delete rest[K_DIG];
        localStorage.setItem("cr_snap_v1", JSON.stringify({ v: 1, savedAt: now(), data: rest }));
      }
    } catch {}
  }
  maybeAutoRelay(snap[K_PG], false);
}

const nextPollMs = (): number => {
  if (D.hidden) return 0;
  const f = num(snapshot?.[K_US]?.[K_PI]);
  if (f > 0) return f * 1e3;
  const baseMs = 1000;
  const b = ewmaRttMs !== null ? M.max(baseMs, M.min(15_000, rd(ewmaRttMs * 3))) : baseMs;
  return pollErrors ? M.min(45e3, b << M.min(pollErrors, 3)) : b;
};
const cancelPoll = (): void => { if (pollTimer !== null) { ct(pollTimer); pollTimer = null; } };
const scheduleNextPoll = (): number => {
  cancelPoll();
  if (D.hidden || viewMode !== DB || !autoRefresh || !canCallTools) return 0;
  const nxt = nextPollMs();
  if (nxt) { pollMs = nxt; pollTimer = st(() => { pollTimer = null; void refreshSnapshot(false); }, pollMs); }
  return nxt;
};

async function refreshSnapshot(force = false, showSynced = false): Promise<void> {
  if (viewMode !== DB || !canCallTools) return;
  if (inFlightPoll) { if (force) queuedForce = true; return; }
  cancelPoll(); inFlightPoll = true; const seq = ++pollSeq; inFlightSeq = seq; ct(spinTimer);
  if (force || !snapshot) { refreshing = true; spinTimer = st(() => { if (refreshing) { showSpinner = true; render(); } }, 150); }
  const t0 = performance.now();
  try {
    const isAr = filterTab === K_AR, args: Record<string, unknown> = { action: K_SN0, limit: isAr ? 50 : 25, show_history: filterTab === "subs", include_archived: isAr };
    if (force) args.fresh = true; else if (lastDigest) args.if_digest = lastDigest;
    const res = await callTool("context_radar_overview", args, { timeout: 15e3 });
    if (seq !== pollSeq) return;
    const rz = (x: number): number => M.max(0, M.round(x)), sc = res?.[K_SC2] as SnapshotData | undefined, srvMs = rz(num(sc?.[K_SM])), netRtt = rz(performance.now() - t0 - srvMs);
    serverMs = srvMs; ewmaRttMs = ewmaRttMs === null ? netRtt : M.round(ewmaRttMs * .65 + netRtt * .35);
    pollErrors = 0; lastSyncTs = now(); ct(spinTimer); showSpinner = false;
    const finish = (): void => { refreshing = false; showSynced ? flashMicro(L(39)) : render(); };
    if (res?.[K_ERR]) { errorText = L(27); refreshing = false; render(); }
    else if (sc?.unchanged || (sc?.[K_DIG] && sc[K_DIG] === lastDigest && snapshot)) {
      const hadErr = !!errorText; unchangedHits += 1; errorText = "";
      if (sc?.[K_GA] && snapshot) snapshot[K_GA] = sc[K_GA];
      if (viewMode === DB && snapshot?.mode === K_SN0) {
        try {
          if (typeof localStorage < "u") {
            const rest: SnapshotData = { ...snapshot }; delete rest[K_PG]; if (snapshot[K_PG]) delete rest[K_DIG];
            localStorage.setItem("cr_snap_v1", JSON.stringify({ v: 1, savedAt: now(), data: rest }));
          }
        } catch {}
      }
      if (refreshing) finish(); else if (hadErr) render();
    } else if (sc) { applySnapshot(sc); loadingInitial = false; errorText = ""; finish(); }
  } catch (err: unknown) {
    if (seq !== pollSeq) return;
    pollErrors += 1; errorText = `${(err as { message?: unknown } | null)?.message || err}`; ct(spinTimer); showSpinner = false; refreshing = false; render();
  } finally { if (inFlightSeq === seq) { inFlightPoll = false; queuedForce ? ((queuedForce = false), void refreshSnapshot(true, false)) : scheduleNextPoll(); } }
}

const ERT = { estimated_remaining_turns: 12 };
const withBusy = async (key: string, fn: () => Promise<void>): Promise<void> => { if (!canCallTools) return; loadingKey = key; render(); try { await fn(); } catch { flashMicro(L(27)); } finally { loadingKey = ""; render(); } };
const openTray = (cid: string, tab: TrayTab): Promise<void> | void => {
  if (openTrays.get(cid) === tab) { openTrays.delete(cid); return render(); }
  openTrays.set(cid, tab);
  const cfg: Record<TrayTab, [string, Record<string, unknown>]> = { turns: [`${K_PF}turns`, { limit: 24 }], [K_HS]: [`${K_PF}${K_HS}`, { mode: K_HS, top_k: 5 }], advice: ["radar_prepare_handoff", ERT] };
  const [m, a] = cfg[tab];
  return withBusy(`${tab}:${cid}`, async () => { const res = await callTool(m, { [K_CID]: cid, ...a }); if (!res?.[K_ERR] && res?.[K_SC2]) { trayMap[tab].set(cid, res[K_SC2]); subTrayRev += 1; } });
};
const runDistill = (cid: string): Promise<void> | "" => cid && withBusy(`distill:${cid}`, async () => {
  const rec = cHot.get(cid)?.recommended_distill_range, res = await uiAct({ action: "distill_slice", [K_CID]: cid, ...(rec?.length === 2 ? { start_step: rec[0], end_step: rec[1] } : {}) }), sc = res?.[K_SC2] as DistillPayload | undefined;
  if (!res?.[K_ERR] && sc?.[K_SN]) { cDist.set(cid, sc); subTrayRev += 1; flashMicro(L(34)); } else flashMicro(sc?.error || res?.content?.[0]?.text || L(27));
});
const prepareOrLaunch = (cid: string, launchNow: boolean): Promise<void> | "" => cid && withBusy(`handoff:${cid}`, async () => {
  const sn = cDist.get(cid)?.[K_SN], sc = await uiSc<CreateHandoffPayload>({ action: "create_handoff", kind: launchNow ? "handoff" : "compact", [K_CID]: cid, auto_fire: false, ...ERT, ...(sn ? { scratch_note_path: sn } : {}) });
  if (!sc || sc.blocked || sc.mode === HB) return flashMicro(sc?.reasons?.[0] || L(13));
  if (snapshot) snapshot[K_PG] = sc; subTrayRev += 1;
  if (launchNow) { loadingKey = ""; await executeDispatch(sc, "manual_handoff", false, false); } else await cpCompact(sc[K_CC]);
});
const toggleAutoHandoff = async (): Promise<void> => {
  const prev = allowAutoHandoff, next = !prev;
  allowAutoHandoff = next; if (!next) cancelAutoCmp(); render(); if (!canCallTools) return;
  try {
    const res = await uiAct({ action: K_SP, [K_AAH]: next }), v = (res?.[K_SC2] as SetPrefsPayload | undefined)?.[K_ST]?.[K_AAH];
    if (res?.[K_ERR] || typeof v !== "boolean") throw new Error(res?.content?.[0]?.text || L(27));
    allowAutoHandoff = v; flashMicro(tr(v ? "✓ On|✓ 已开启" : "✓ Off|✓ 已关闭"));
    const curPg = pg();
    if (v && curPg) { curPg[K_AAH] = true; maybeAutoRelay(curPg, false); }
    render();
  } catch (e: unknown) { allowAutoHandoff = prev; flashMicro((e as { message?: string } | null)?.message || L(27)); render(); }
};
const saveSettings = async (): Promise<void> => {
  if (!uSet || !canCallTools || settingsSaving) return;
  const g = (k: string): HTMLInputElement | HTMLSelectElement | null => uSet.querySelector(`[data-s="${k}"]`), gv = (k: string): string | undefined => g(k)?.value, ri = (k: string, a: number, b: number): number => clm(rd(num(gv(k))), a, b), bv = Number(gv(K_BP) ?? 0), z = isZh();
  const args = { action: K_SP, lang: gv("lang") || "auto", [K_TH]: themePref, [K_CC2]: gv(K_CC2) || "auto", [K_FX]: clm(num(gv(K_FX)) || 7.2, .01, 1e3), [K_PI]: ri(K_PI, 0, 300), [K_BP]: bv < 0 ? -1 : ri(K_BP, 0, 3600), [K_AAH]: !!(g(K_AAH) as HTMLInputElement | null)?.checked, [K_CTH]: clm(rd((num(gv(K_CTH)) || (z ? 36 : 360)) * (z ? 1e4 : 1e3)), 1e4, 2e6) };
  settingsSaving = true; settingsSig = ""; render();
  try {
    const res = await uiAct(args), sc = res?.[K_SC2] as SetPrefsPayload | undefined;
    if (res?.[K_ERR] || !sc?.[K_US]) throw new Error(res?.content?.[0]?.text || L(35));
    if (snapshot) Object.assign(snapshot, sc);
    allowAutoHandoff = !!sc[K_US][K_AAH];
    const nl = parseLoc(sc[K_US].lang); nl ? ((DE.lang = lang = nl), (langLocked = true), ls0(lang)) : (langLocked = false);
    settingsOpen = false; ++pollSeq; lastDigest = ""; flashMicro(L(34)); scheduleNextPoll(); void refreshSnapshot(true, false);
  } catch (e: unknown) { flashMicro((e as { message?: string } | null)?.message || L(35)); }
  finally { settingsSaving = false; settingsSig = ""; render(); }
};
const buildReminder = (it: SessionItem): string => `${L(28)} "${it.title}" ${fmtK(it[K_LCT])}/${fmtK(getLim(it))} (>${((num(it[K_RCT]) || 31e4) / 1e3) | 0}k); ${tr("Context nearly full — wrap up or run /compact.|上下文接近上限，请收尾或执行 /compact。")}`;
const setFilterTab = (next: FilterTab, focus = false): void => { if (filterTab === next) return; filterTab = next; ++pollSeq; lastDigest = ""; render(); if (focus) D.querySelector<HTMLElement>(`[data-a="tab"][data-i="${next}"]`)?.focus(); void refreshSnapshot(true, false); };

const ACT: Record<string, (id: string, ev: MouseEvent) => unknown> = {
  ci: (id, ev) => { ev.preventDefault(); return copyCid(id); },
  ref: async () => (await ensureConnected()) && void refreshSnapshot(true, true),
  aut: () => { (autoRefresh = !autoRefresh) ? scheduleNextPoll() : cancelPoll(); render(); },
  cfg: () => { settingsOpen = !settingsOpen; settingsSig = ""; render(); },
  thm: (id) => {
    const next = parseTheme(id);
    themePref = next; bridge.setThemePreference?.(next); syncThemeUi();
    if (!canCallTools) return;
    const g = ++themeLocked;
    void uiAct({ action: K_SP, [K_TH]: next }).then((r) => { const sc = r?.[K_SC2] as SetPrefsPayload | undefined; if (sc?.[K_US] && snapshot) Object.assign(snapshot, sc); }).catch(() => {}).finally(() => { if (themeLocked === g) themeLocked = 0; });
  },
  svs: saveSettings, csp: (p) => p && copyText(p, L(1)), tab: (id) => id && setFilterTab(id as FilterTab),
  aho: toggleAutoHandoff, row: (id) => { if (id) { openRowId = openRowId === id ? null : id; render(); } },
  dst: runDistill, cdp: (id) => ACT.csp(cDist.get(id)?.[K_SN] || "", {} as MouseEvent),
  up: (id) => prepareOrLaunch(id, false), ul: (id) => prepareOrLaunch(id, true),
  dis: (id) => { if (!id) { errorText = ""; return render(); } cancelAutoCmp(); if (snapshot && pg()?.[K_GID] === id) { delete snapshot[K_PG]; render(); } recAct("dismiss_grant", id, {}); },
  ask: (id) => { confirmSendId = id || null; render(); },
};
onD("click", async (ev) => {
  const el = (ev.target as Element | null)?.closest?.<HTMLElement>("[data-a]"); if (!el) return; ev.stopPropagation();
  const { a = "", i: id = "" } = el.dataset;
  if (a.startsWith("t-") && id) return openTray(id, a.slice(2) as TrayTab);
  if (ACT[a]) return ACT[a](id, ev);
  if (/^c[cp]?c$/.test(a)) { const m = a === "cc" ? "/compact" : (a === "ccc" ? handoffCard : pg())?.[K_CC]; return m && cpCompact(m); }
  if (/^[cr][01]$/.test(a)) { const isIn = a[1] === "0", isCmp = a[0] === "c", g = isIn ? handoffCard : pg(); return g && executeDispatch(g, isCmp ? "manual_compact" : "manual_handoff", isIn, isCmp); }
  const it = findSession(id); if (!it) return;
  if (a === "crm") void copyText(buildReminder(it), L(8));
  else if (a === "csr") void copyText(`${L(it.is_side_question ? 30 : 29)} ${it.agent_name || it.title} (${id}) ${fmtK(it[K_LCT])}: ${tr("Context nearly full — start a new chat with handoff note.|上下文接近上限，请携带接续说明开启新会话。")}`, L(1));
  else if (a === "yes" && !it[K_IS]) {
    confirmSendId = null; const msg = buildReminder(it);
    if (canDirectMsg(it)) try { if (!(await sendTxt(msg))?.[K_ERR]) return flashMicro(tr("✓ Sent|✓ 已发送")); } catch {}
    await copyText(msg, L(8)); render();
  }
});
onD("keydown", (ev) => {
  if (ev.key === "Escape") { if (settingsOpen || confirmSendId || openTrays.size || openRowId) { settingsOpen = false; confirmSendId = openRowId = null; openTrays.clear(); render(); } return; }
  const el = (ev.target as Element | null)?.closest?.<HTMLElement>("[data-a]"); if (!el) return;
  if (/^(Enter| )$/.test(ev.key) && el.dataset.a === "row") { ev.preventDefault(); ACT.row(el.dataset.i || "", {} as MouseEvent); }
  else if (/^Arrow(Left|Right)$/.test(ev.key) && el.dataset.a === "tab") { ev.preventDefault(); setFilterTab(FIDS[(FIDS.indexOf(filterTab) + (ev.key === "ArrowRight" ? 1 : 2)) % 3], true); }
});

const canForceDb = (): boolean => !D.hidden && viewMode === DB && canCallTools;
const forceNow = (): void => { const t = now(); if (t - lastForceTs < 250) return; lastForceTs = t; void refreshSnapshot(true, false); };
const kickRelay = (): void => { if (viewMode === HC) { if (handoffCard && !handoffCard.blocked) maybeAutoRelay(handoffCard, true); } else if (pg()) maybeAutoRelay(pg(), false); };
const syncNow = (): number | void => {
  if (D.hidden) { cancelPoll(); return 0; }
  pollErrors = 0;
  kickRelay();
  if (viewMode === DB && canCallTools) {
    pollMs = nextPollMs();
    forceNow();
    if (autoRefresh && pollTimer === null && !inFlightPoll) scheduleNextPoll();
  }
  render();
};
onD("visibilitychange", syncNow);
onD("pointerenter", () => { if (canForceDb() && now() - lastSyncTs > 900) forceNow(); }, { passive: true });
["focus", "pageshow"].forEach((e) => window.addEventListener(e, () => canForceDb() && forceNow()));

let obsRo: ResizeObserver | null = null, obsIo: IntersectionObserver | null = null;
function setupRevealObservers(): void {
  const dim = (): boolean => DE.clientWidth > 0 && DE.clientHeight > 0;
  let col = !dim(), was = !col;
  if (typeof ResizeObserver < "u") {
    obsRo = new ResizeObserver((es) => { const r = es.at(-1)?.contentRect, vis = r ? r.width > 0 && r.height > 0 : dim(); if (col && vis && canForceDb()) forceNow(); col = !vis; });
    obsRo.observe(DE);
  }
  if (typeof IntersectionObserver < "u") {
    obsIo = new IntersectionObserver((es) => { const vis = !!es.at(-1)?.isIntersecting; if (!was && vis && canForceDb()) forceNow(); was = vis; }, { threshold: 0 });
    obsIo.observe(DE);
  }
}

const syncLoc = (r: unknown): number => { const p = !langLocked && r ? parseLoc(r) : ""; return p && p !== lang ? ((DE.lang = lang = p), 1) : 0; };
bridge.ontoolinput = (p) => { const args = p?.arguments as Record<string, unknown> | undefined; const c = typeof args?.[K_CID] === "string" ? args[K_CID].trim() : ""; if (c) ownerCid = c; if (!snapshot && viewMode === DB) { loadingInitial = true; render(); } };
bridge.ontoolresult = (result) => {
  if (result?.[K_ERR]) { errorText = L(27); loadingInitial = false; return render(); }
  const sc = result?.[K_SC2] as (SnapshotData & PendingGrant) | undefined, m = sc?.mode;
  if (sc && (m === HC || m === HB)) {
    viewMode = HC; handoffCard = sc; if (sc[K_CID]) ownerCid = sc[K_CID]; syncLoc(sc.lang);
    if (typeof sc[K_AAH] === "boolean") allowAutoHandoff = sc[K_AAH];
    handoffStatus = m === HB ? "blocked" : sc[K_AAH] && sc.auto_fire !== false && !sc[K_RSC] && !sc.acp_proxy_active ? "pending" : "manual";
    loadingInitial = false; cancelPoll(); render(); if (m === HC) maybeAutoRelay(sc, true);
  } else if (sc && m === K_SN0) {
    viewMode = DB; loadingInitial = false; errorText = ""; lastSyncTs = now(); ++pollSeq;
    if (sc[K_SM] !== undefined) serverMs = M.max(0, rd(num(sc[K_SM])));
    scheduleNextPoll(); if (!(sc.unchanged || (sc[K_DIG] && sc[K_DIG] === lastDigest && snapshot))) { applySnapshot(sc); render(); }
  }
};

const syncHostContext = (ctx: HostContext | null | undefined): void => { if (syncLoc(ctx?.locale)) render(); };
const persistHostTheme = (ht: "light" | "dark"): void => {
  if (!canCallTools || ht === lastHostTheme) return;
  const prev = lastHostTheme;
  lastHostTheme = ht;
  void uiAct({ action: K_SP, [K_LHT]: ht }).catch(() => { if (lastHostTheme === ht) lastHostTheme = prev; });
};
bridge.onhostthemechanged = persistHostTheme;

bridge.onhostcontextchanged = (ctx, fullCtx) => { syncHostContext(fullCtx || ctx); if ((ctx?.containerDimensions || ctx?.displayMode) && canForceDb()) forceNow(); };
bridge.onteardown = () => { cancelPoll(); cancelAutoCmp(); obsRo?.disconnect(); obsIo?.disconnect(); return {}; };

const ensureConnected = async (): Promise<boolean> => {
  if (bridge.isConnected?.()) return canCallTools;
  try {
    await bridge.connect(); syncHostContext(bridge.getHostContext());
    const caps = bridge.getHostCapabilities();
    canMessage = !!caps?.message; canCallTools = !!caps?.serverTools;
    const ht = bridge.getResolvedHostTheme?.(); if (ht) persistHostTheme(ht);
    Object.assign(DE.dataset, { canMsg: S(+canMessage), ct: S(+canCallTools) });
    errorText = ""; render(); scheduleNextPoll(); kickRelay(); return canCallTools;
  } catch (err: unknown) { errorText = `${(err as { message?: unknown } | null)?.message || err}`; loadingInitial = false; render(); return false; }
};

const shouldSkipBootRefresh = (): boolean => !bootOverridden && !!(boot && boot.mode === K_SN0 && typeof boot.bootTs === "number" && now() - boot.bootTs < 2500);
const bootPanel = async (): Promise<void> => {
  setupRevealObservers();
  bridge.setThemePreference?.(themePref);
  if (snapshot) applySnapshot(snapshot, false);
  if (!bootOverridden && boot?.mode === K_SN0) saveCachedSnap(boot, typeof boot.bootTs === "number" ? boot.bootTs : now());
  render();
  if ((await ensureConnected()) && viewMode === DB && !shouldSkipBootRefresh()) void refreshSnapshot(true, false);
};
void bootPanel();
