use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const CONFIG_ENV: &str = "CONTEXT_RADAR_CONFIG";
pub const DATA_ROOT_ENV: &str = "CONTEXT_RADAR_DATA_ROOT";
pub const PLUGIN_DATA_ENV: &str = "CONTEXT_RADAR_PLUGIN_DATA";
pub const DISABLE_DISK_CACHE_ENV: &str = "CONTEXT_RADAR_DISABLE_DISK_CACHE";
pub const INDEX_CACHE_PATH_ENV: &str = "CONTEXT_RADAR_INDEX_PATH";
pub const GRANTS_PATH_ENV: &str = "CONTEXT_RADAR_GRANTS_PATH";
pub const PANEL_HTML_ENV: &str = "CONTEXT_RADAR_PANEL_HTML";
pub const LANG_ENV: &str = "CONTEXT_RADAR_LANG";
pub const WORKSPACE_ENV: &str = "CONTEXT_RADAR_WORKSPACE";
pub const CONVERSATION_ID_ENV: &str = "CONTEXT_RADAR_CONVERSATION_ID";
pub const ACP_PROXY_ENV: &str = "CONTEXT_RADAR_ACP_PROXY";
pub const AGY_AUTO_COMPACT_OVERRIDE_ENV: &str = "AGY_CLI_AUTO_COMPACT_OVERRIDE";
pub const AGY_BIN_ENV: &str = "AGY_BIN";

#[cfg(all(
    unix,
    any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    )
))]
pub(crate) const UNIX_O_NOFOLLOW: i32 = 0x0100;
#[cfg(all(target_os = "linux", any(target_arch = "aarch64", target_arch = "arm")))]
pub(crate) const UNIX_O_NOFOLLOW: i32 = 0o100000;
#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "aarch64", target_arch = "arm"))
))]
pub(crate) const UNIX_O_NOFOLLOW: i32 = 0o400000;

#[cfg(all(
    unix,
    any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    )
))]
pub(crate) const UNIX_O_NONBLOCK: i32 = 0x0004;
#[cfg(target_os = "linux")]
pub(crate) const UNIX_O_NONBLOCK: i32 = 0o4000;

pub(crate) const MAX_CONFIG_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

#[cfg(unix)]
pub(crate) fn current_euid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() }
}

pub(crate) fn is_safe_id(cid: &str) -> bool {
    let b = cid.as_bytes();
    if b.is_empty() || b.len() > 128 {
        return false;
    }
    if b[0] == b'.' || cid.contains("..") {
        return false;
    }
    b.iter()
        .all(|&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
}

/// Read a regular non-symlink file with `O_NOFOLLOW | O_NONBLOCK` and an upper byte bound.
pub(crate) fn read_regular_file_bounded(path: &Path, max_bytes: usize) -> io::Result<String> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    opts.custom_flags(UNIX_O_NOFOLLOW | UNIX_O_NONBLOCK);
    let file = opts.open(path)?;
    let meta = file.metadata()?;
    if !meta.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not a regular file",
        ));
    }
    if meta.len() > max_bytes as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds maximum allowed size",
        ));
    }
    let mut text = String::new();
    file.take((max_bytes + 1) as u64)
        .read_to_string(&mut text)?;
    if text.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds maximum allowed size",
        ));
    }
    Ok(text)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BoundedLine {
    Eof,
    Line(usize),
    Oversized(usize),
}

/// Read one `\n`-terminated line up to `max_bytes`, also reporting whether a terminating `\n`
/// was encountered (`true`) or EOF was reached before `\n` (`false`). If a line exceeds
/// `max_bytes`, drains the remainder up to the next `\n` (or EOF) without buffering it in memory.
pub(crate) fn read_line_bounded_with_term<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<(BoundedLine, bool)> {
    buf.clear();
    let n = reader
        .by_ref()
        .take((max_bytes + 1) as u64)
        .read_until(b'\n', buf)?;
    if n == 0 {
        return Ok((BoundedLine::Eof, false));
    }
    if n <= max_bytes {
        return Ok((BoundedLine::Line(n), buf.ends_with(b"\n")));
    }
    if buf.ends_with(b"\n") {
        return Ok((BoundedLine::Oversized(n), true));
    }
    let mut total = n;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok((BoundedLine::Oversized(total), false));
        }
        if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
            let consume = pos + 1;
            total = total.saturating_add(consume);
            reader.consume(consume);
            return Ok((BoundedLine::Oversized(total), true));
        }
        let len = chunk.len();
        total = total.saturating_add(len);
        reader.consume(len);
    }
}

/// Read one `\n`-terminated line up to `max_bytes`. If a line exceeds `max_bytes`, drains the
/// remainder up to the next `\n` (or EOF) without buffering it in memory.
pub(crate) fn read_line_bounded<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<BoundedLine> {
    read_line_bounded_with_term(reader, buf, max_bytes).map(|(line, _)| line)
}

pub(crate) fn validate_pref_lang(raw: &str) -> Result<Option<&'static str>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    if trimmed.eq_ignore_ascii_case("en") {
        return Ok(Some("en"));
    }
    if trimmed.eq_ignore_ascii_case("zh-cn") {
        return Ok(Some("zh-CN"));
    }
    Err("invalid lang preference; expected auto, en, or zh-CN".to_string())
}

pub(crate) fn validate_pref_currency(raw: &str) -> Result<Option<&'static str>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    if trimmed.eq_ignore_ascii_case("USD") {
        return Ok(Some("USD"));
    }
    if trimmed.eq_ignore_ascii_case("CNY") {
        return Ok(Some("CNY"));
    }
    Err("invalid currency_code; expected auto, USD, or CNY".to_string())
}

pub(crate) fn validate_pref_theme(raw: &str) -> Result<&'static str, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("system") {
        return Ok("system");
    }
    if trimmed.eq_ignore_ascii_case("light") {
        return Ok("light");
    }
    if trimmed.eq_ignore_ascii_case("dark") {
        return Ok("dark");
    }
    Err("invalid theme; expected system, light, or dark".to_string())
}

pub(crate) fn validate_pref_last_host_theme(raw: &str) -> Result<&'static str, String> {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("light") {
        return Ok("light");
    }
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("dark") {
        return Ok("dark");
    }
    Err("invalid last_host_theme; expected light or dark".to_string())
}

pub const DEFAULT_CONTEXT_LIMIT: u64 = 512_000;
pub const DEFAULT_WARN_THRESHOLD: u64 = 300_000;
pub const DEFAULT_COMPACT_THRESHOLD: u64 = 360_000;
pub const DEFAULT_CRITICAL_THRESHOLD: u64 = 430_000;
pub const DEFAULT_POST_COMPACT_BASE: u64 = 20_500;
pub const DEFAULT_SUBAGENT_SILENT_TIMEOUT_SEC: f64 = 3600.0;
pub const DEFAULT_FX_RATE: f64 = 7.2;
pub const DEFAULT_CURRENCY_CODE: &str = "USD";
pub const DEFAULT_CURRENCY_SYMBOL: &str = "$";

const DATA_ROOT_CANDIDATES: &[&str] = &["antigravity", "antigravity-ide", "antigravity-cli"];
const DISABLE_TOKENS: &[&str] = &["none", "off", "disabled", "/dev/null"];

pub fn user_home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn expand_tilde(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed == "~" {
        return user_home_dir().to_string_lossy().into_owned();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return user_home_dir().join(rest).to_string_lossy().into_owned();
    }
    trimmed.to_string()
}

#[inline]
fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Canonical workspace URI/path normalizer shared across ledger, grants, and boot guard:
/// strips `file://`, percent-decodes URI escapes (e.g. `%20`), and trims trailing `/` (preserving `/`).
pub fn normalize_workspace_uri(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let decoded = if let Some(rest) = trimmed.strip_prefix("file://") {
        percent_decode(rest)
    } else {
        trimmed.to_string()
    };
    if decoded.len() > 1 {
        decoded.trim_end_matches('/').to_string()
    } else {
        decoded
    }
}

fn candidate_root_activity_ns(root: &Path) -> Option<i128> {
    if !root.is_dir() {
        return None;
    }
    let mut best_ns: Option<i128> = None;
    let mut bump = |p: &Path| {
        if let Ok(m) = fs::metadata(p) {
            let ns = (m.mtime() as i128) * 1_000_000_000 + (m.mtime_nsec() as i128);
            best_ns = Some(best_ns.map_or(ns, |prev| prev.max(ns)));
        }
    };
    bump(&root.join("conversation_summaries.db"));
    bump(&root.join("conversation_summaries.db-wal"));
    bump(&root.join("conversations"));
    best_ns
}

pub fn select_data_root_from_home(home: &Path) -> PathBuf {
    let gemini_dir = home.join(".gemini");
    let mut best_active: Option<(i128, usize, PathBuf)> = None;
    let mut first_existing_dir: Option<PathBuf> = None;

    for (idx, name) in DATA_ROOT_CANDIDATES.iter().enumerate() {
        let cand = gemini_dir.join(name);
        if cand.is_dir() && first_existing_dir.is_none() {
            first_existing_dir = Some(cand.clone());
        }
        if let Some(ts) = candidate_root_activity_ns(&cand) {
            let take = match &best_active {
                None => true,
                Some((prev_ts, prev_idx, _)) => {
                    ts > *prev_ts || (ts == *prev_ts && idx < *prev_idx)
                }
            };
            if take {
                best_active = Some((ts, idx, cand));
            }
        }
    }

    if let Some((_, _, chosen)) = best_active {
        return chosen;
    }
    first_existing_dir.unwrap_or_else(|| gemini_dir.join("antigravity"))
}

pub fn default_data_root() -> PathBuf {
    default_data_root_for_plugin_data(None)
}

/// Infer the host Antigravity data root from a `--data-dir` path such as
/// `~/.gemini/antigravity-cli/plugin_data/context-radar-mcp`.
pub fn infer_data_root_from_plugin_data(plugin_data_dir: &Path) -> Option<PathBuf> {
    let parent = plugin_data_dir.parent()?;
    if parent.file_name().and_then(|s| s.to_str()) != Some("plugin_data") {
        return None;
    }
    let root = parent.parent()?;
    let root_name = root.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let looks_like_host = DATA_ROOT_CANDIDATES.contains(&root_name)
        || root.join("conversations").is_dir()
        || root.join("conversation_summaries.db").is_file();
    if looks_like_host {
        Some(root.to_path_buf())
    } else {
        None
    }
}

pub fn default_data_root_for_plugin_data(plugin_data_dir: Option<&Path>) -> PathBuf {
    if let Ok(val) = env::var(DATA_ROOT_ENV) {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(expand_tilde(trimmed));
        }
    }
    if let Some(pdd) = plugin_data_dir {
        if let Some(inferred) = infer_data_root_from_plugin_data(pdd) {
            return inferred;
        }
    }
    select_data_root_from_home(&user_home_dir())
}

pub fn resolve_agy_bin(explicit: Option<&str>) -> PathBuf {
    if let Some(raw) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(expand_tilde(raw));
    }
    if let Ok(env_bin) = env::var(AGY_BIN_ENV) {
        let trimmed = env_bin.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(expand_tilde(trimmed));
        }
    }
    if let Ok(path_var) = env::var("PATH") {
        for dir in env::split_paths(&path_var) {
            let cand = dir.join("agy");
            if cand.is_file() {
                return cand;
            }
        }
    }
    let local_bin = user_home_dir().join(".local").join("bin").join("agy");
    if local_bin.is_file() {
        return local_bin;
    }
    PathBuf::from("agy")
}

pub fn default_plugin_data_dir(data_root: &Path) -> PathBuf {
    if let Ok(val) = env::var(PLUGIN_DATA_ENV) {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(expand_tilde(trimmed));
        }
    }
    data_root.join("plugin_data").join("context-radar-mcp")
}

pub fn is_disable_token(val: &str) -> bool {
    let lower = val.trim().to_ascii_lowercase();
    DISABLE_TOKENS.iter().any(|t| *t == lower)
}

pub fn abbreviate_home_path(path: &Path) -> String {
    let home = user_home_dir();
    if let Ok(rel) = path.strip_prefix(&home) {
        if rel.as_os_str().is_empty() {
            "~".to_string()
        } else {
            format!("~/{}", rel.to_string_lossy())
        }
    } else {
        path.to_string_lossy().into_owned()
    }
}

pub fn resolve_settings_path(explicit: Option<&str>) -> Option<PathBuf> {
    resolve_settings_path_with_plugin_data(explicit, None)
}

pub fn resolve_settings_path_with_plugin_data(
    explicit: Option<&str>,
    plugin_data_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(raw) = explicit {
        let trimmed = raw.trim();
        if trimmed.is_empty() || is_disable_token(trimmed) {
            return None;
        }
        return Some(PathBuf::from(expand_tilde(trimmed)));
    }

    if let Ok(env_val) = env::var(CONFIG_ENV) {
        let trimmed = env_val.trim();
        if !trimmed.is_empty() {
            if is_disable_token(trimmed) {
                return None;
            }
            return Some(PathBuf::from(expand_tilde(trimmed)));
        }
    }

    let plugin_cand = plugin_data_dir
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join("settings.json"));
    if let Some(ref p) = plugin_cand {
        if p.is_file() {
            return Some(p.clone());
        }
    }

    if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            let xdg_path = PathBuf::from(expand_tilde(trimmed))
                .join("context-radar-mcp")
                .join("settings.json");
            if xdg_path.is_file() {
                return Some(xdg_path);
            }
        }
    }

    let legacy_path = user_home_dir()
        .join(".config")
        .join("context-radar-mcp")
        .join("settings.json");
    if legacy_path.is_file() {
        return Some(legacy_path);
    }

    Some(plugin_cand.unwrap_or(legacy_path))
}

#[derive(Debug, Clone)]
pub struct ContextConfig {
    pub default_limit: u64,
    pub warn_threshold: u64,
    pub compact_threshold: u64,
    pub critical_threshold: u64,
    pub est_post_compact_base: u64,
    pub subagent_silent_timeout_sec: f64,
    pub enable_disk_cache: bool,
    pub disk_cache_path: String,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            default_limit: DEFAULT_CONTEXT_LIMIT,
            warn_threshold: DEFAULT_WARN_THRESHOLD,
            compact_threshold: DEFAULT_COMPACT_THRESHOLD,
            critical_threshold: DEFAULT_CRITICAL_THRESHOLD,
            est_post_compact_base: DEFAULT_POST_COMPACT_BASE,
            subagent_silent_timeout_sec: DEFAULT_SUBAGENT_SILENT_TIMEOUT_SEC,
            enable_disk_cache: true,
            disk_cache_path: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RateOverrideRule {
    pub match_prefix: Vec<String>,
    pub match_exact: Vec<String>,
    pub match_contains: Vec<String>,
    pub input_per_m: f64,
    pub cache_read_per_m: f64,
    pub cache_write_per_m: f64,
    pub output_per_m: f64,
    pub context_limit: u64,
    pub source: String,
    pub tier_threshold: u64,
    pub tier_input: f64,
    pub tier_cache_read: f64,
    pub tier_cache_write: f64,
    pub tier_output: f64,
}

#[derive(Debug, Clone)]
pub struct ModelRateInput {
    pub input_per_m: f64,
    pub cache_read_per_m: f64,
    pub cache_write_per_m: f64,
    pub output_per_m: f64,
    pub context_limit: u64,
    pub source: String,
    pub tier_threshold: u64,
    pub tier_input: f64,
    pub tier_cache_read: f64,
    pub tier_cache_write: f64,
    pub tier_output: f64,
}

#[derive(Debug, Clone)]
pub struct PricingConfig {
    pub currency_code: String,
    pub currency_symbol: String,
    pub currency_configured: bool,
    pub fx_rate: f64,
    pub fx_rate_configured: bool,
    pub external_fxrate_path: String,
    pub external_models_path: String,
    pub overrides: Vec<RateOverrideRule>,
    pub models: HashMap<String, ModelRateInput>,
    pub short_labels: Vec<(String, String)>,
}

impl Default for PricingConfig {
    fn default() -> Self {
        Self {
            currency_code: String::new(),
            currency_symbol: String::new(),
            currency_configured: false,
            fx_rate: DEFAULT_FX_RATE,
            fx_rate_configured: false,
            external_fxrate_path: String::new(),
            external_models_path: String::new(),
            overrides: Vec::new(),
            models: HashMap::new(),
            short_labels: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetTierSpec {
    pub profile_id: String,
    pub label: String,
    pub min_ctx: u64,
    pub recommend_ctx: u64,
    pub urgent_ctx: u64,
    pub min_turns_since_ckpt: usize,
    pub min_remaining_turns: usize,
}

#[derive(Debug, Clone)]
pub struct TierMatchRule {
    pub profile: String,
    pub match_any: Vec<String>,
    pub require_all: Vec<String>,
    pub exclude_any: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct BudgetsConfig {
    pub default_profile: String,
    pub profiles: HashMap<String, BudgetTierSpec>,
    pub profile_rules: Vec<TierMatchRule>,
}

impl Default for BudgetsConfig {
    fn default() -> Self {
        Self {
            default_profile: "standard".to_string(),
            profiles: HashMap::new(),
            profile_rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct GuardsConfig {
    pub boot: Value,
    pub exec_gate: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiConfig {
    pub poll_interval_sec: u64,
    pub bg_poll_interval_sec: i64,
    pub allow_auto_handoff: Option<bool>,
    pub theme: String,
    pub last_host_theme: String,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            poll_interval_sec: 0,
            bg_poll_interval_sec: 0,
            allow_auto_handoff: None,
            theme: "system".to_string(),
            last_host_theme: "dark".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Settings {
    pub generation: u64,
    pub source_path: String,
    pub settings_error: Option<String>,
    pub lang: String,
    pub context: ContextConfig,
    pub pricing: PricingConfig,
    pub budgets: BudgetsConfig,
    pub guards: GuardsConfig,
    pub ui: UiConfig,
}

#[derive(Debug, Clone, Default)]
pub struct SettingsPatch {
    pub lang: Option<String>,
    pub currency_code: Option<String>,
    pub fx_rate: Option<f64>,
    pub poll_interval_sec: Option<u64>,
    pub bg_poll_interval_sec: Option<i64>,
    pub allow_auto_handoff: Option<bool>,
    pub compact_threshold: Option<u64>,
    pub theme: Option<String>,
    pub last_host_theme: Option<String>,
}

fn val_u64(v: Option<&Value>, default: u64, min: u64) -> u64 {
    let Some(val) = v else { return default };
    let parsed = if let Some(n) = val.as_u64() {
        Some(n)
    } else if let Some(n) = val.as_i64() {
        if n >= 0 {
            Some(n as u64)
        } else {
            None
        }
    } else if let Some(f) = val.as_f64() {
        if f.is_finite() && f >= 0.0 {
            Some(f as u64)
        } else {
            None
        }
    } else {
        None
    };
    match parsed {
        Some(n) if n >= min => n,
        _ => default,
    }
}

fn val_f64(v: Option<&Value>, default: f64, min: f64) -> f64 {
    let Some(val) = v else { return default };
    let parsed = val
        .as_f64()
        .or_else(|| val.as_i64().map(|x| x as f64))
        .or_else(|| val.as_u64().map(|x| x as f64));
    match parsed {
        Some(n) if n.is_finite() && n >= min => n,
        _ => default,
    }
}

fn val_str(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn str_vec_lower(v: Option<&Value>) -> Vec<String> {
    let Some(arr) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn parse_settings_value(raw: &Value, source_path: &str, generation: u64) -> Settings {
    let Some(obj) = raw.as_object() else {
        return Settings {
            generation,
            source_path: source_path.to_string(),
            ..Settings::default()
        };
    };

    let ctx_obj = obj.get("context").and_then(Value::as_object);
    let default_limit = val_u64(
        ctx_obj.and_then(|o| o.get("default_limit")),
        DEFAULT_CONTEXT_LIMIT,
        1000,
    );
    let context = ContextConfig {
        default_limit,
        warn_threshold: val_u64(
            ctx_obj.and_then(|o| o.get("warn_threshold")),
            DEFAULT_WARN_THRESHOLD,
            1000,
        ),
        compact_threshold: val_u64(
            ctx_obj.and_then(|o| o.get("compact_threshold")),
            DEFAULT_COMPACT_THRESHOLD,
            1000,
        ),
        critical_threshold: val_u64(
            ctx_obj.and_then(|o| o.get("critical_threshold")),
            DEFAULT_CRITICAL_THRESHOLD,
            1000,
        ),
        est_post_compact_base: val_u64(
            ctx_obj.and_then(|o| o.get("est_post_compact_base")),
            DEFAULT_POST_COMPACT_BASE,
            0,
        ),
        subagent_silent_timeout_sec: val_f64(
            ctx_obj.and_then(|o| o.get("subagent_silent_timeout_sec")),
            DEFAULT_SUBAGENT_SILENT_TIMEOUT_SEC,
            10.0,
        ),
        enable_disk_cache: ctx_obj
            .and_then(|o| o.get("enable_disk_cache"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        disk_cache_path: expand_tilde(&val_str(ctx_obj.and_then(|o| o.get("disk_cache_path")))),
    };

    let pr_obj = obj.get("pricing").and_then(Value::as_object);
    let fx_configured = pr_obj
        .and_then(|o| o.get("fx_rate"))
        .map(|v| !v.is_null())
        .unwrap_or(false);
    let fx_rate = if fx_configured {
        val_f64(
            pr_obj.and_then(|o| o.get("fx_rate")),
            DEFAULT_FX_RATE,
            0.0001,
        )
    } else {
        DEFAULT_FX_RATE
    };

    let mut overrides = Vec::new();
    if let Some(arr) = pr_obj
        .and_then(|o| o.get("overrides"))
        .and_then(Value::as_array)
    {
        for item in arr {
            let Some(item_obj) = item.as_object() else {
                continue;
            };
            let in_p = val_f64(item_obj.get("input_per_m"), -1.0, 0.0);
            let out_p = val_f64(item_obj.get("output_per_m"), -1.0, 0.0);
            if in_p < 0.0 || out_p < 0.0 {
                continue;
            }
            let mp = str_vec_lower(item_obj.get("match_prefix"));
            let me = str_vec_lower(item_obj.get("match_exact"));
            let mc = str_vec_lower(item_obj.get("match_contains"));
            if mp.is_empty() && me.is_empty() && mc.is_empty() {
                continue;
            }
            let src = val_str(item_obj.get("source"));
            overrides.push(RateOverrideRule {
                match_prefix: mp,
                match_exact: me,
                match_contains: mc,
                input_per_m: in_p,
                cache_read_per_m: val_f64(item_obj.get("cache_read_per_m"), in_p * 0.1, 0.0),
                cache_write_per_m: val_f64(item_obj.get("cache_write_per_m"), in_p, 0.0),
                output_per_m: out_p,
                context_limit: val_u64(item_obj.get("context_limit"), default_limit, 1000),
                source: if src.is_empty() {
                    "user-override".to_string()
                } else {
                    src
                },
                tier_threshold: val_u64(item_obj.get("tier_threshold"), 0, 0),
                tier_input: val_f64(item_obj.get("tier_input"), 0.0, 0.0),
                tier_cache_read: val_f64(item_obj.get("tier_cache_read"), 0.0, 0.0),
                tier_cache_write: val_f64(item_obj.get("tier_cache_write"), 0.0, 0.0),
                tier_output: val_f64(item_obj.get("tier_output"), 0.0, 0.0),
            });
        }
    }

    let mut models = HashMap::new();
    if let Some(m_obj) = pr_obj
        .and_then(|o| o.get("models"))
        .and_then(Value::as_object)
    {
        for (k, v) in m_obj {
            let key = k.trim().to_ascii_lowercase();
            let Some(vo) = v.as_object() else { continue };
            if key.is_empty() {
                continue;
            }
            let in_p = val_f64(vo.get("input_per_m"), -1.0, 0.0);
            let out_p = val_f64(vo.get("output_per_m"), -1.0, 0.0);
            if in_p < 0.0 || out_p < 0.0 {
                continue;
            }
            let src = val_str(vo.get("source"));
            models.insert(
                key,
                ModelRateInput {
                    input_per_m: in_p,
                    cache_read_per_m: val_f64(vo.get("cache_read_per_m"), in_p * 0.1, 0.0),
                    cache_write_per_m: val_f64(vo.get("cache_write_per_m"), in_p, 0.0),
                    output_per_m: out_p,
                    context_limit: val_u64(vo.get("context_limit"), default_limit, 1000),
                    source: if src.is_empty() {
                        "user-config".to_string()
                    } else {
                        src
                    },
                    tier_threshold: val_u64(vo.get("tier_threshold"), 0, 0),
                    tier_input: val_f64(vo.get("tier_input"), 0.0, 0.0),
                    tier_cache_read: val_f64(vo.get("tier_cache_read"), 0.0, 0.0),
                    tier_cache_write: val_f64(vo.get("tier_cache_write"), 0.0, 0.0),
                    tier_output: val_f64(vo.get("tier_output"), 0.0, 0.0),
                },
            );
        }
    }

    let mut short_labels = Vec::new();
    if let Some(arr) = pr_obj
        .and_then(|o| o.get("short_labels"))
        .and_then(Value::as_array)
    {
        for item in arr {
            let Some(io) = item.as_object() else { continue };
            let contains = val_str(io.get("contains")).to_ascii_lowercase();
            let label = val_str(io.get("label"));
            if !contains.is_empty() && !label.is_empty() {
                short_labels.push((contains, label));
            }
        }
    }

    let lang = val_str(obj.get("lang").or_else(|| obj.get("locale")));
    let raw_c_code = val_str(pr_obj.and_then(|o| o.get("currency_code")));
    let c_code = if raw_c_code.eq_ignore_ascii_case("auto") {
        String::new()
    } else {
        raw_c_code
    };
    let c_sym = if c_code.is_empty()
        && pr_obj
            .and_then(|o| o.get("currency_code"))
            .and_then(Value::as_str)
            .is_some_and(|s| s.trim().eq_ignore_ascii_case("auto"))
    {
        String::new()
    } else {
        val_str(pr_obj.and_then(|o| o.get("currency_symbol")))
    };
    let currency_configured = !c_code.is_empty() || !c_sym.is_empty();
    let pricing = PricingConfig {
        currency_code: c_code,
        currency_symbol: c_sym,
        currency_configured,
        fx_rate,
        fx_rate_configured: fx_configured,
        external_fxrate_path: expand_tilde(&val_str(
            pr_obj.and_then(|o| o.get("external_fxrate_path")),
        )),
        external_models_path: expand_tilde(&val_str(
            pr_obj.and_then(|o| o.get("external_models_path")),
        )),
        overrides,
        models,
        short_labels,
    };

    let bud_obj = obj
        .get("budgets")
        .or_else(|| obj.get("compaction"))
        .and_then(Value::as_object);
    let mut profiles = HashMap::new();
    if let Some(p_obj) = bud_obj
        .and_then(|o| o.get("tiers").or_else(|| o.get("profiles")))
        .and_then(Value::as_object)
    {
        for (pid, pval) in p_obj {
            let key = pid.trim();
            let Some(po) = pval.as_object() else { continue };
            if key.is_empty() {
                continue;
            }
            let lbl = val_str(po.get("label"));
            profiles.insert(
                key.to_string(),
                BudgetTierSpec {
                    profile_id: key.to_string(),
                    label: if lbl.is_empty() { key.to_string() } else { lbl },
                    min_ctx: val_u64(po.get("min_ctx"), DEFAULT_WARN_THRESHOLD, 1000),
                    recommend_ctx: val_u64(
                        po.get("recommend_ctx"),
                        DEFAULT_COMPACT_THRESHOLD,
                        1000,
                    ),
                    urgent_ctx: val_u64(po.get("urgent_ctx"), DEFAULT_CRITICAL_THRESHOLD, 1000),
                    min_turns_since_ckpt: val_u64(po.get("min_turns_since_ckpt"), 18, 1) as usize,
                    min_remaining_turns: val_u64(po.get("min_remaining_turns"), 8, 1) as usize,
                },
            );
        }
    }

    let mut profile_rules = Vec::new();
    if let Some(arr) = bud_obj
        .and_then(|o| o.get("rules").or_else(|| o.get("profile_rules")))
        .and_then(Value::as_array)
    {
        for item in arr {
            let Some(io) = item.as_object() else { continue };
            let target = val_str(io.get("tier").or_else(|| io.get("profile")));
            if target.is_empty() {
                continue;
            }
            profile_rules.push(TierMatchRule {
                profile: target,
                match_any: str_vec_lower(io.get("match_any")),
                require_all: str_vec_lower(io.get("require_all")),
                exclude_any: str_vec_lower(io.get("exclude_any")),
            });
        }
    }

    let def_prof =
        val_str(bud_obj.and_then(|o| o.get("default_tier").or_else(|| o.get("default_profile"))));
    let budgets = BudgetsConfig {
        default_profile: if def_prof.is_empty() {
            "standard".to_string()
        } else {
            def_prof
        },
        profiles,
        profile_rules,
    };

    let guards_obj = obj
        .get("guards")
        .or_else(|| obj.get("hooks"))
        .and_then(Value::as_object);
    let boot = guards_obj
        .and_then(|o| o.get("boot").or_else(|| o.get("session_start")))
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    let exec_gate = guards_obj
        .and_then(|o| o.get("exec_gate").or_else(|| o.get("pre_run_command")))
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));

    let ui_obj = obj.get("ui").and_then(Value::as_object);
    let poll_interval_sec = val_u64(ui_obj.and_then(|o| o.get("poll_interval_sec")), 0, 0).min(300);
    let bg_poll_interval_sec = ui_obj
        .and_then(|o| o.get("bg_poll_interval_sec"))
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
        })
        .map(|v| if v < 0 { -1 } else { v.min(3600) })
        .unwrap_or(0);
    let allow_auto_handoff = ui_obj
        .and_then(|o| o.get("allow_auto_handoff"))
        .and_then(Value::as_bool);
    let theme = ui_obj
        .and_then(|o| o.get("theme"))
        .or_else(|| obj.get("theme"))
        .and_then(Value::as_str)
        .and_then(|raw| validate_pref_theme(raw).ok())
        .unwrap_or("system")
        .to_string();
    let last_host_theme = ui_obj
        .and_then(|o| o.get("last_host_theme"))
        .or_else(|| obj.get("last_host_theme"))
        .and_then(Value::as_str)
        .and_then(|raw| validate_pref_last_host_theme(raw).ok())
        .unwrap_or("dark")
        .to_string();

    Settings {
        generation,
        source_path: source_path.to_string(),
        settings_error: None,
        lang,
        context,
        pricing,
        budgets,
        guards: GuardsConfig { boot, exec_gate },
        ui: UiConfig {
            poll_interval_sec,
            bg_poll_interval_sec,
            allow_auto_handoff,
            theme,
            last_host_theme,
        },
    }
}

pub fn load_settings_once(explicit: Option<&str>) -> Settings {
    let Some(path) = resolve_settings_path(explicit) else {
        return Settings::default();
    };
    let Ok(raw_text) = read_regular_file_bounded(&path, MAX_CONFIG_BYTES) else {
        return Settings::default();
    };
    let Ok(raw_val) = serde_json::from_str::<Value>(&raw_text) else {
        return Settings::default();
    };
    parse_settings_value(&raw_val, &path.to_string_lossy(), 1)
}

#[cfg(unix)]
struct SettingsFileLock {
    file: File,
}

#[cfg(unix)]
impl SettingsFileLock {
    fn acquire(target: &Path) -> io::Result<Self> {
        const LOCK_EX: i32 = 2;
        extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        if !parent.as_os_str().is_empty() {
            if let Ok(meta) = fs::symlink_metadata(parent) {
                if meta.file_type().is_symlink() {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "settings directory must not be a symlink",
                    ));
                }
            }
            fs::create_dir_all(parent)?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
        let lock_path = parent.join("settings.lock");
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(UNIX_O_NOFOLLOW)
            .open(&lock_path)?;
        loop {
            let rc = unsafe { flock(file.as_raw_fd(), LOCK_EX) };
            if rc == 0 {
                return Ok(Self { file });
            }
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
    }
}

#[cfg(unix)]
impl Drop for SettingsFileLock {
    fn drop(&mut self) {
        const LOCK_UN: i32 = 8;
        extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        unsafe {
            let _ = flock(self.file.as_raw_fd(), LOCK_UN);
        }
    }
}

/// Atomically merge a partial UI patch into `settings.json` (`0600` + `flock`),
/// preserving all untouched advanced keys (`pricing.models`, `budgets`, `guards`, etc.).
/// Refuses symlinks and refuses to overwrite a syntactically corrupt `settings.json`.
pub fn update_settings_file_atomic(target: &Path, patch: &SettingsPatch) -> Result<(), String> {
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    if target.as_os_str().is_empty() {
        return Err("missing settings path".into());
    }
    if let Ok(meta) = fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            return Err("settings file must not be a symlink".into());
        }
    }
    let _lock = SettingsFileLock::acquire(target).map_err(|e| format!("lock failed: {e}"))?;

    let mut root_obj: Map<String, Value> = match read_regular_file_bounded(target, MAX_CONFIG_BYTES)
    {
        Ok(raw) if !raw.trim().is_empty() => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(m)) => m,
            _ => return Err("invalid_json".into()),
        },
        Ok(_) => Map::new(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(format!("read failed: {e}")),
    };

    if let Some(ref raw_lang) = patch.lang {
        match validate_pref_lang(raw_lang)? {
            None => {
                root_obj.remove("lang");
            }
            Some(norm) => {
                root_obj.insert("lang".into(), Value::String(norm.to_string()));
            }
        }
    }

    if patch.currency_code.is_some() || patch.fx_rate.is_some() {
        let pricing = root_obj
            .entry("pricing".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !pricing.is_object() {
            *pricing = Value::Object(Map::new());
        }
        let pobj = pricing.as_object_mut().unwrap();
        if let Some(ref raw_cc) = patch.currency_code {
            match validate_pref_currency(raw_cc)? {
                None => {
                    pobj.remove("currency_code");
                    pobj.remove("currency_symbol");
                }
                Some(up) => {
                    let sym = crate::i18n::infer_currency_symbol(up);
                    pobj.insert("currency_code".into(), Value::String(up.to_string()));
                    pobj.insert("currency_symbol".into(), Value::String(sym.to_string()));
                }
            }
        }
        if let Some(fx) = patch.fx_rate {
            if !fx.is_finite() || !(0.01..=1000.0).contains(&fx) {
                return Err("fx_rate out of range".into());
            }
            pobj.insert(
                "fx_rate".into(),
                serde_json::json!((fx * 10000.0).round() / 10000.0),
            );
        }
    }

    if patch.poll_interval_sec.is_some()
        || patch.bg_poll_interval_sec.is_some()
        || patch.allow_auto_handoff.is_some()
        || patch.theme.is_some()
        || patch.last_host_theme.is_some()
    {
        let ui = root_obj
            .entry("ui".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !ui.is_object() {
            *ui = Value::Object(Map::new());
        }
        let uobj = ui.as_object_mut().unwrap();
        if let Some(p) = patch.poll_interval_sec {
            uobj.insert("poll_interval_sec".into(), serde_json::json!(p.min(300)));
        }
        if let Some(bg) = patch.bg_poll_interval_sec {
            let clamped = if bg < 0 { -1 } else { bg.min(3600) };
            uobj.insert("bg_poll_interval_sec".into(), serde_json::json!(clamped));
        }
        if let Some(allow) = patch.allow_auto_handoff {
            uobj.insert("allow_auto_handoff".into(), Value::Bool(allow));
        }
        if let Some(ref raw_theme) = patch.theme {
            let norm = validate_pref_theme(raw_theme)?;
            uobj.insert("theme".into(), Value::String(norm.to_string()));
        }
        if let Some(ref raw_lht) = patch.last_host_theme {
            let norm = validate_pref_last_host_theme(raw_lht)?;
            uobj.insert("last_host_theme".into(), Value::String(norm.to_string()));
        }
    }

    if let Some(ct) = patch.compact_threshold {
        if !(10_000..=2_000_000).contains(&ct) {
            return Err("compact_threshold out of range".into());
        }
        let ctx = root_obj
            .entry("context".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !ctx.is_object() {
            *ctx = Value::Object(Map::new());
        }
        ctx.as_object_mut()
            .unwrap()
            .insert("compact_threshold".into(), serde_json::json!(ct));
    }

    let mut payload =
        serde_json::to_string_pretty(&Value::Object(root_obj)).map_err(|e| e.to_string())?;
    payload.push('\n');

    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".settings.json.tmp.{}.{seq}", std::process::id()));
    let mut f = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(UNIX_O_NOFOLLOW)
        .open(&tmp_path)
        .map_err(|e| format!("create tmp failed: {e}"))?;
    if let Err(e) = f.write_all(payload.as_bytes()).and_then(|_| f.sync_all()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("write failed: {e}"));
    }
    drop(f);
    if let Err(e) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("rename failed: {e}"));
    }
    Ok(())
}

#[derive(Debug)]
pub struct SettingsWatcher {
    explicit_path: Option<String>,
    plugin_data_dir: Option<PathBuf>,
    last_path: Option<PathBuf>,
    last_sig: Option<(i128, u64, u64)>,
    generation: u64,
    cached: Arc<Settings>,
}

impl SettingsWatcher {
    pub fn new(explicit_path: Option<String>) -> Self {
        Self::new_with_plugin_data(explicit_path, None)
    }

    pub fn new_with_plugin_data(
        explicit_path: Option<String>,
        plugin_data_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            explicit_path,
            plugin_data_dir,
            last_path: None,
            last_sig: None,
            generation: 0,
            cached: Arc::new(Settings::default()),
        }
    }

    pub fn target_path(&self) -> Option<PathBuf> {
        resolve_settings_path_with_plugin_data(
            self.explicit_path.as_deref(),
            self.plugin_data_dir.as_deref(),
        )
    }

    pub fn current(&mut self) -> Arc<Settings> {
        let resolved = self.target_path();
        let Some(path) = resolved else {
            if self.last_path.is_some() || self.last_sig.is_some() {
                self.generation += 1;
                self.last_path = None;
                self.last_sig = None;
                self.cached = Arc::new(Settings {
                    generation: self.generation,
                    ..Settings::default()
                });
            }
            return Arc::clone(&self.cached);
        };

        let sig = match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.file_type().is_symlink() && meta.file_type().is_file() => {
                let mtime_ns = (meta.mtime() as i128) * 1_000_000_000 + (meta.mtime_nsec() as i128);
                (mtime_ns, meta.size(), meta.ino())
            }
            Ok(_) => {
                let mut kept = if self.last_sig.is_some() && self.last_path.as_ref() == Some(&path)
                {
                    (*self.cached).clone()
                } else {
                    Settings::default()
                };
                self.generation += 1;
                self.last_path = Some(path.clone());
                kept.generation = self.generation;
                kept.source_path = path.to_string_lossy().into_owned();
                kept.settings_error = Some("read_error".to_string());
                self.cached = Arc::new(kept);
                return Arc::clone(&self.cached);
            }
            Err(_) => {
                if self.last_path.as_ref() != Some(&path) || self.last_sig.is_some() {
                    self.generation += 1;
                    self.last_path = Some(path.clone());
                    self.last_sig = None;
                    self.cached = Arc::new(Settings {
                        generation: self.generation,
                        source_path: path.to_string_lossy().into_owned(),
                        ..Settings::default()
                    });
                }
                return Arc::clone(&self.cached);
            }
        };

        if self.last_path.as_ref() == Some(&path) && self.last_sig == Some(sig) {
            return Arc::clone(&self.cached);
        }

        self.generation += 1;
        let path_changed = self.last_path.as_ref() != Some(&path);
        let had_good = self.last_sig.is_some() && !path_changed;
        self.last_path = Some(path.clone());
        self.last_sig = Some(sig);

        let parsed = match read_regular_file_bounded(&path, MAX_CONFIG_BYTES) {
            Ok(txt) => match serde_json::from_str::<Value>(&txt) {
                Ok(val) if val.is_object() => {
                    parse_settings_value(&val, &path.to_string_lossy(), self.generation)
                }
                _ => {
                    // Fail-closed: preserve last-known-good settings and surface non-destructive error.
                    let mut kept = if had_good {
                        (*self.cached).clone()
                    } else {
                        Settings::default()
                    };
                    kept.generation = self.generation;
                    kept.source_path = path.to_string_lossy().into_owned();
                    kept.settings_error = Some("invalid_json".to_string());
                    kept
                }
            },
            Err(_) => {
                let mut kept = if had_good {
                    (*self.cached).clone()
                } else {
                    Settings::default()
                };
                kept.generation = self.generation;
                kept.source_path = path.to_string_lossy().into_owned();
                kept.settings_error = Some("read_error".to_string());
                kept
            }
        };
        self.cached = Arc::new(parsed);
        Arc::clone(&self.cached)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;
    use std::os::unix::fs::symlink;

    #[test]
    fn read_line_bounded_drains_oversized_without_oom_and_recovers() {
        let big = format!("{}\n{{\"ok\":true}}\n", "x".repeat(256));
        let mut reader = BufReader::new(big.as_bytes());
        let mut buf = Vec::new();
        match read_line_bounded(&mut reader, &mut buf, 64).unwrap() {
            BoundedLine::Oversized(n) => assert_eq!(n, 257),
            other => panic!("expected Oversized, got {other:?}"),
        }
        assert!(buf.len() <= 65);
        match read_line_bounded(&mut reader, &mut buf, 64).unwrap() {
            BoundedLine::Line(n) => {
                assert_eq!(n, 12);
                assert_eq!(&buf, b"{\"ok\":true}\n");
            }
            other => panic!("expected Line, got {other:?}"),
        }
        assert_eq!(
            read_line_bounded(&mut reader, &mut buf, 64).unwrap(),
            BoundedLine::Eof
        );
    }

    #[test]
    fn read_regular_file_bounded_rejects_symlinks_and_oversized() {
        let td = tempfile::tempdir().unwrap();
        let real = td.path().join("real.json");
        fs::write(&real, "{\"a\":1}").unwrap();
        assert_eq!(read_regular_file_bounded(&real, 64).unwrap(), "{\"a\":1}");

        let link = td.path().join("link.json");
        symlink(&real, &link).unwrap();
        assert!(read_regular_file_bounded(&link, 64).is_err());

        let big = td.path().join("big.json");
        fs::write(&big, "x".repeat(128)).unwrap();
        assert!(read_regular_file_bounded(&big, 64).is_err());
    }
}
