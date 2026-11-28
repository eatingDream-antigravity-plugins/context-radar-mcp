//! Session/turn telemetry aggregation, 3-way (+ partial drop) cold-cache attribution, and multi-level snapshot cache.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Datelike, NaiveDateTime, Utc};
use serde::Serialize;

use crate::engine::grants::{workspaces_overlap, PanelPrefs, RelayGrant};
use crate::engine::rates::RateTable;
use crate::engine::tiers::{
    effective_critical_threshold, is_gemini_4_carbon, model_cache_ttl_sec, resolve_budget_tier,
};
use crate::i18n::{carbon_concurrency_warning_text, resolve_active_lang, Lang};
use crate::ledger::index_db::DbVersionSig;
use crate::ledger::journal_tail::JournalTailCache;
use crate::ledger::sqlite_ro::{stat_db_stamp, FileStamp, LedgerReader};
use crate::ledger::{is_safe_id, LiveStepProbe, SummaryRecord, TurnSample};
use crate::settings::{
    default_data_root_for_plugin_data, default_plugin_data_dir, expand_tilde, SettingsWatcher,
    CONVERSATION_ID_ENV, DEFAULT_CONTEXT_LIMIT, DISABLE_DISK_CACHE_ENV, INDEX_CACHE_PATH_ENV,
    WORKSPACE_ENV,
};

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ColdCacheBreakdown {
    pub turn_start_cold: usize,
    pub mid_loop_cold: usize,
    pub post_compact_cold: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct MidLoopBreakdown {
    pub slow_turn_self_expiry: usize,
    pub replica_spillover: usize,
    pub model_switch_cold: usize,
    pub other: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MidLoopSubReason {
    None,
    SlowTurnSelfExpiry,
    ReplicaSpillover,
    ModelSwitchCold,
    Other,
}

impl MidLoopSubReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "",
            Self::SlowTurnSelfExpiry => "slow_turn_self_expiry",
            Self::ReplicaSpillover => "replica_spillover",
            Self::ModelSwitchCold => "model_switch_cold",
            Self::Other => "other",
        }
    }

    pub fn label_and_reason_for_lang(
        self,
        lang: Lang,
        ttl_sec: u64,
        partial: bool,
    ) -> (&'static str, &'static str) {
        let zh = lang.is_zh();
        match self {
            Self::None => ("", ""),
            Self::SlowTurnSelfExpiry => match (zh, ttl_sec) {
                (true, 180) => (
                    "缓存过期",
                    "这一轮超过了缓存有效期（约 3 分钟），只能重算。",
                ),
                (false, 180) => (
                    "Cache expired",
                    "This turn ran past the cache lifetime (~3 min), so it was rebuilt.",
                ),
                (true, 240) => (
                    "缓存过期",
                    "这一轮超过了缓存有效期（约 4 分钟），只能重算。",
                ),
                (false, 240) => (
                    "Cache expired",
                    "This turn ran past the cache lifetime (~4 min), so it was rebuilt.",
                ),
                (true, _) => (
                    "缓存过期",
                    "这一轮超过了缓存有效期（约 5 分钟），只能重算。",
                ),
                (false, _) => (
                    "Cache expired",
                    "This turn ran past the cache lifetime (~5 min), so it was rebuilt.",
                ),
            },
            Self::ReplicaSpillover => {
                if zh {
                    ("缓存被清", "服务端繁忙，缓存被清掉了。")
                } else {
                    ("Cache dropped", "The server cleared the cache under load.")
                }
            }
            Self::ModelSwitchCold => {
                if zh {
                    ("换了模型", "换模型后用不上之前的缓存。")
                } else {
                    (
                        "Model switched",
                        "A different model can't reuse the old cache.",
                    )
                }
            }
            Self::Other => {
                ColdCacheKind::MidLoop.label_and_reason_for_lang_with_ttl(lang, partial, ttl_sec)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColdCacheKind {
    None,
    TurnStart,
    MidLoop,
    PostCompact,
}

impl ColdCacheKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "",
            Self::TurnStart => "turn_start_cold",
            Self::MidLoop => "mid_loop_cold",
            Self::PostCompact => "post_compact_cold",
        }
    }

    pub fn label_and_reason(self) -> (&'static str, &'static str) {
        self.label_and_reason_for_lang(resolve_active_lang(""), false)
    }

    pub fn label_and_reason_for_lang(
        self,
        lang: Lang,
        partial: bool,
    ) -> (&'static str, &'static str) {
        self.label_and_reason_for_lang_with_ttl(lang, partial, 300)
    }

    pub fn label_and_reason_for_lang_with_ttl(
        self,
        lang: Lang,
        partial: bool,
        ttl_sec: u64,
    ) -> (&'static str, &'static str) {
        let zh = lang.is_zh();
        match self {
            Self::None => ("", ""),
            Self::TurnStart => {
                if zh {
                    (
                        "新一轮未命中",
                        if partial {
                            "只用上了开头一部分缓存。"
                        } else if ttl_sec == 180 {
                            "新一轮超过了约 3 分钟的缓存有效期，没有用上缓存。"
                        } else if ttl_sec == 240 {
                            "新一轮超过了约 4 分钟的缓存有效期，没有用上缓存。"
                        } else {
                            "新一轮没有用上缓存。"
                        },
                    )
                } else {
                    (
                        "New-turn miss",
                        if partial {
                            "Only the start of the context was reused."
                        } else if ttl_sec == 180 {
                            "The new turn ran past the ~3 min cache lifetime."
                        } else if ttl_sec == 240 {
                            "The new turn ran past the ~4 min cache lifetime."
                        } else {
                            "The new turn didn't hit the cache."
                        },
                    )
                }
            }
            Self::MidLoop => {
                if partial {
                    if zh {
                        ("部分复用", "只用上了开头一部分缓存。")
                    } else {
                        ("Partly reused", "Only the start of the context was reused.")
                    }
                } else if zh {
                    ("中途失效", "这一轮中途缓存失效了。")
                } else {
                    ("Lost mid-turn", "The cache broke during the turn.")
                }
            }
            Self::PostCompact => {
                if zh {
                    ("压缩后重建", "/compact 之后需要重建，属正常。")
                } else {
                    ("After compact", "Expected rebuild after /compact.")
                }
            }
        }
    }
}

/// Detect partial prefix cache drops where a small static prefix still hits (`cache_read > 0`),
/// but `cache_read` drops sharply (`>= 35%` and `>= 20k` tokens) relative to the prior turn's
/// cached prefix (`cache_read + cache_write >= 24k`) and triggers a large rebuild (`cache_write >= 16k`
/// or `cache_write + input_tokens >= 24k` at `< 65%` hit rate).
pub fn is_partial_prefix_drop(prev_t: Option<&TurnSample>, t: &TurnSample) -> bool {
    let Some(prev) = prev_t else { return false };
    if t.is_checkpoint || prev.is_checkpoint || t.after_checkpoint || t.cache_read == 0 {
        return false;
    }
    let prev_cached = prev.cache_read.saturating_add(prev.cache_write);
    if prev_cached < 24_000 {
        return false;
    }
    let drop_tokens = prev_cached.saturating_sub(t.cache_read);
    if drop_tokens < 20_000 || (t.cache_read as f64) > (prev_cached as f64) * 0.65 {
        return false;
    }
    t.cache_write >= 16_000
        || (t.cache_write.saturating_add(t.input_tokens) >= 24_000 && t.cache_hit_rate() < 65.0)
}

#[inline]
pub fn now_epoch_sec() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[inline]
pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[inline]
fn round_dp(v: f64, decimals: i32) -> f64 {
    let f = 10f64.powi(decimals);
    (v * f).round() / f
}

pub fn parse_iso_ts(raw: &str) -> f64 {
    let text = raw.trim();
    if text.is_empty() {
        return 0.0;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        if dt.year() < 2000 {
            return 0.0;
        }
        return (dt.timestamp() as f64) + (dt.timestamp_subsec_nanos() as f64) * 1e-9;
    }
    let normalized = text.replace(' ', "T");
    if let Ok(dt) = DateTime::parse_from_rfc3339(&format!("{normalized}Z")) {
        if dt.year() < 2000 {
            return 0.0;
        }
        return (dt.timestamp() as f64) + (dt.timestamp_subsec_nanos() as f64) * 1e-9;
    }
    if let Ok(ndt) = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f"))
    {
        if ndt.year() < 2000 {
            return 0.0;
        }
        let dt = ndt.and_utc();
        return (dt.timestamp() as f64) + (dt.timestamp_subsec_nanos() as f64) * 1e-9;
    }
    if let Ok(raw) = text.parse::<i64>() {
        let ts = if raw >= 100_000_000_000_000_000 {
            (raw as f64) * 1e-9
        } else if raw >= 100_000_000_000_000 {
            (raw as f64) * 1e-6
        } else if raw >= 100_000_000_000 {
            (raw as f64) * 1e-3
        } else if raw >= 946_684_800 {
            raw as f64
        } else {
            0.0
        };
        if ts >= 946_684_800.0 {
            return ts;
        }
    }
    0.0
}

const SIDE_QUESTION_RECENT_PROBE_SEC: f64 = 60.0;

#[inline]
fn is_side_question_active(
    killed: bool,
    eff_mtime: f64,
    now_ts: f64,
    probe: Option<&LiveStepProbe>,
    latest_turn_step_idx: i64,
) -> bool {
    if killed {
        return false;
    }
    let Some(p) = probe else { return false };
    if p.live_phase.is_empty() || p.live_active_step_idx < latest_turn_step_idx {
        return false;
    }
    eff_mtime > 0.0 && (now_ts - eff_mtime).max(0.0) <= SIDE_QUESTION_RECENT_PROBE_SEC
}

pub fn format_utc_iso(ts_sec: f64) -> String {
    if !ts_sec.is_finite() || ts_sec <= 0.0 {
        return String::new();
    }
    let secs = ts_sec.trunc() as i64;
    let nanos = ((ts_sec.fract().max(0.0)) * 1_000_000_000.0).min(999_999_999.0) as u32;
    DateTime::<Utc>::from_timestamp(secs, nanos)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

fn subagent_idle_at(summary: &SummaryRecord, last_ts: f64, silent_timeout_sec: f64) -> Option<f64> {
    (!summary.killed
        && summary.status != "CASCADE_RUN_STATUS_RUNNING"
        && summary.not_fully_idle
        && last_ts > 0.0)
        .then_some(last_ts + silent_timeout_sec)
}

pub fn is_subagent_active(
    summary: Option<&SummaryRecord>,
    last_ts: f64,
    now_ts: f64,
    silent_timeout_sec: f64,
) -> bool {
    let Some(s) = summary else { return false };
    !s.killed
        && (s.status == "CASCADE_RUN_STATUS_RUNNING" || s.not_fully_idle)
        && subagent_idle_at(s, last_ts, silent_timeout_sec).is_none_or(|until| now_ts <= until)
}

#[derive(Debug, Clone)]
pub struct ActiveModelWindow {
    pub cid: String,
    pub model_key: String,
    pub min_ts: f64,
    pub max_ts: f64,
    pub is_active: bool,
    pub is_carbon: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColdTurnClassification {
    pub kind: ColdCacheKind,
    pub sub_reason: MidLoopSubReason,
    pub partial: bool,
}

pub fn normalized_model_family(model: &str, model_display: &str) -> String {
    let mut s = if !model.trim().is_empty() && model.trim() != "unknown" {
        model.trim().to_ascii_lowercase()
    } else {
        model_display.trim().to_ascii_lowercase()
    };
    for suffix in ["-xhigh", "-high", "-medium", "-low"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.to_string();
            break;
        }
    }
    s
}

pub fn compute_overlap_counts(
    cid: &str,
    turns: &[TurnSample],
    windows: &[ActiveModelWindow],
) -> Vec<usize> {
    if windows.is_empty() {
        return vec![1; turns.len()];
    }
    turns
        .iter()
        .map(|t| {
            let mk = normalized_model_family(&t.model, &t.model_display);
            if mk.is_empty() {
                return 1;
            }
            let mut count = 1usize;
            for w in windows {
                if w.cid == cid || w.model_key != mk {
                    continue;
                }
                let overlaps = if t.timestamp > 0.0 && w.min_ts > 0.0 {
                    w.min_ts - 60.0 <= t.timestamp
                        && (w.is_active || t.timestamp <= w.max_ts + 60.0)
                } else {
                    w.is_active
                };
                if overlaps {
                    count += 1;
                }
            }
            count
        })
        .collect()
}

pub fn classify_cold_cache_turns_detailed(
    turns: &[TurnSample],
    transcript_step_types: Option<&HashMap<i64, String>>,
    overlap_counts_by_turn: Option<&[usize]>,
) -> Vec<ColdTurnClassification> {
    let mut sorted_indices: Vec<i64> = transcript_step_types
        .map(|m| {
            let mut ks: Vec<i64> = m.keys().copied().collect();
            ks.sort_unstable();
            ks
        })
        .unwrap_or_default();
    sorted_indices.dedup();

    let mut results = Vec::with_capacity(turns.len());

    for (i, t) in turns.iter().enumerate() {
        let prev_t = if i > 0 { Some(&turns[i - 1]) } else { None };
        let full_cold = t.is_cold_cache();
        let partial_cold = !full_cold && is_partial_prefix_drop(prev_t, t);
        if !full_cold && !partial_cold {
            results.push(ColdTurnClassification {
                kind: ColdCacheKind::None,
                sub_reason: MidLoopSubReason::None,
                partial: false,
            });
            continue;
        }

        let prev_step = prev_t.map(|p| p.step_idx).unwrap_or(-1);

        let mut saw_ckpt_between = false;
        let mut saw_user_or_sys_between = false;
        if let Some(tmap) = transcript_step_types {
            if !sorted_indices.is_empty() {
                let lo = sorted_indices.partition_point(|&x| x <= prev_step);
                let hi = sorted_indices.partition_point(|&x| x < t.step_idx);
                for &idx in &sorted_indices[lo..hi] {
                    if let Some(st) = tmap.get(&idx) {
                        if st == "CHECKPOINT" {
                            saw_ckpt_between = true;
                        } else if st == "USER_INPUT" || st == "SYSTEM_MESSAGE" {
                            saw_user_or_sys_between = true;
                        }
                    }
                }
            }
        }
        let transcript_covers_gap = sorted_indices
            .last()
            .is_some_and(|&max_idx| max_idx >= t.step_idx.saturating_sub(1));

        let ttl_sec = model_cache_ttl_sec(&t.model, &t.model_display);
        let start_dt = prev_t.and_then(|p| t.start_delta_sec(p));
        let idle_gap = prev_t.and_then(|p| t.idle_gap_sec(p));
        let model_switched = prev_t.is_some_and(|p| t.is_model_or_effort_switch(p));
        let concurrent_same_model = overlap_counts_by_turn
            .and_then(|s| s.get(i).copied())
            .unwrap_or(1);
        let prefix_rollback = partial_cold
            && (turns[..i.saturating_sub(1)].iter().any(|e| {
                !e.is_checkpoint
                    && e.context_tokens() > 0
                    && t.cache_read.abs_diff(e.context_tokens()) <= 64
            }) || turns.first().is_some_and(|t0| {
                !t0.is_checkpoint
                    && t0.context_tokens() >= 8_000
                    && t.cache_read >= 8_000
                    && t.cache_read <= t0.context_tokens().saturating_add(512)
            }));

        let kind = if t.after_checkpoint
            || prev_t.map(|p| p.is_checkpoint).unwrap_or(false)
            || saw_ckpt_between
        {
            ColdCacheKind::PostCompact
        } else if prev_t.is_none() || t.after_turn_start == Some(true) || saw_user_or_sys_between {
            if partial_cold {
                if start_dt.unwrap_or(0.0) >= ttl_sec {
                    ColdCacheKind::TurnStart
                } else {
                    ColdCacheKind::MidLoop
                }
            } else {
                ColdCacheKind::TurnStart
            }
        } else if t.after_turn_start == Some(false)
            || transcript_covers_gap
            || partial_cold
            || (idle_gap.is_some_and(|g| g < 60.0) && start_dt.is_some_and(|d| d >= ttl_sec))
        {
            ColdCacheKind::MidLoop
        } else if start_dt.is_some_and(|d| d >= ttl_sec) {
            ColdCacheKind::TurnStart
        } else {
            ColdCacheKind::MidLoop
        };

        let sub_reason = if kind == ColdCacheKind::MidLoop {
            if model_switched {
                MidLoopSubReason::ModelSwitchCold
            } else if idle_gap.is_some_and(|g| g < 60.0) && start_dt.is_some_and(|d| d >= ttl_sec) {
                MidLoopSubReason::SlowTurnSelfExpiry
            } else if prefix_rollback
                || (idle_gap.is_some_and(|g| g < 60.0) && concurrent_same_model >= 3)
            {
                MidLoopSubReason::ReplicaSpillover
            } else {
                MidLoopSubReason::Other
            }
        } else {
            MidLoopSubReason::None
        };

        results.push(ColdTurnClassification {
            kind,
            sub_reason,
            partial: partial_cold,
        });
    }
    results
}

pub fn classify_cold_cache_turns(
    turns: &[TurnSample],
    transcript_step_types: Option<&HashMap<i64, String>>,
) -> Vec<ColdCacheKind> {
    classify_cold_cache_turns_detailed(turns, transcript_step_types, None)
        .into_iter()
        .map(|c| c.kind)
        .collect()
}

fn median_u64(vals: &mut [u64]) -> u64 {
    if vals.is_empty() {
        return 0;
    }
    vals.sort_unstable();
    let n = vals.len();
    if n % 2 == 1 {
        vals[n / 2]
    } else {
        (((vals[n / 2 - 1] as f64) + (vals[n / 2] as f64)) / 2.0).round() as u64
    }
}

fn median_f64(vals: &mut [f64]) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = vals.len();
    if n % 2 == 1 {
        vals[n / 2]
    } else {
        (vals[n / 2 - 1] + vals[n / 2]) / 2.0
    }
}

#[inline]
pub fn bucket_live_elapsed_sec(raw_sec: u64) -> u64 {
    if raw_sec < 5 {
        0
    } else if raw_sec < 60 {
        (raw_sec / 5) * 5
    } else {
        (raw_sec / 10) * 10
    }
}

fn canonical_model_key(model: &str, model_display: &str) -> String {
    let m = model.trim().to_ascii_lowercase();
    if !m.is_empty() && m != "unknown" {
        return m;
    }
    let d = model_display.trim().to_ascii_lowercase();
    if !d.is_empty() && d != "未知模型" && d != "unknown model" {
        return d;
    }
    String::new()
}

fn compute_live_state(
    probe: Option<&LiveStepProbe>,
    is_active: bool,
    has_summary: bool,
    killed: bool,
    cross_model_compact: bool,
    now_ts: f64,
) -> (String, String, u64, String) {
    if killed {
        let live_error = probe.map(|p| p.live_error.clone()).unwrap_or_default();
        let live_status = if !live_error.is_empty() {
            "error"
        } else {
            "ready"
        };
        return (live_status.to_string(), String::new(), 0, live_error);
    }

    let raw_phase = probe.map(|p| p.live_phase.clone()).unwrap_or_default();
    // Suppress lingering non-compacting background steps on sessions whose summary explicitly
    // says idle/parked (e.g., parked swarm monitors or idle sessions with background commands).
    let live_phase = if has_summary && !is_active && raw_phase != "compacting" {
        String::new()
    } else {
        raw_phase
    };
    let raw_elapsed = if !live_phase.is_empty() {
        probe
            .filter(|p| p.live_started_ts > 0.0)
            .map(|p| (now_ts - p.live_started_ts).max(0.0) as u64)
            .unwrap_or(0)
    } else {
        0
    };
    let live_elapsed_sec = bucket_live_elapsed_sec(raw_elapsed);

    let has_newer_active = !live_phase.is_empty()
        && probe
            .map(|p| p.live_active_step_idx > p.live_error_step_idx || live_phase == "compacting")
            .unwrap_or(false);
    let live_error = if has_newer_active {
        String::new()
    } else {
        probe.map(|p| p.live_error.clone()).unwrap_or_default()
    };

    let live_status = if !live_error.is_empty() {
        "error"
    } else if !live_phase.is_empty()
        && (live_elapsed_sec >= 45 || (live_phase == "compacting" && cross_model_compact))
    {
        "waiting"
    } else if !live_phase.is_empty() || is_active {
        "running"
    } else {
        "ready"
    };

    (
        live_status.to_string(),
        live_phase,
        live_elapsed_sec,
        live_error,
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionTelemetry {
    pub id: String,
    pub conversation_id: String,
    pub short_id: String,
    pub title: String,
    pub agent_name: String,
    pub parent_id: String,
    pub is_subagent: bool,
    pub is_side_question: bool,
    pub is_running: bool,
    pub not_fully_idle: bool,
    pub is_active: bool,
    pub run_state: String,
    pub live_status: String,
    pub live_phase: String,
    pub live_elapsed_sec: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub live_error: String,
    pub killed: bool,
    pub archived: bool,
    pub pinned: bool,
    pub status: String,
    pub workspace: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub workspaces: Vec<String>,
    pub workspace_name: String,
    pub model: String,
    pub model_display: String,
    pub model_short: String,
    pub cache_ttl_sec: u64,
    pub pricing_known: bool,
    pub profile_label: String,
    pub min_compact_tokens: u64,
    pub recommend_compact_tokens: u64,
    pub urgent_compact_tokens: u64,
    pub just_compacted: bool,
    pub cross_model_compact: bool,
    pub compact_summary_kb: f64,
    pub pre_compact_tokens: u64,
    pub checkpoint_count: usize,
    pub turns_since_compact: usize,
    pub recent_cold_rebuild: bool,
    pub latest_context_tokens: u64,
    pub remaining_context_tokens: u64,
    pub peak_context_tokens: u64,
    pub context_limit: u64,
    pub context_pct: f64,
    pub level: String,
    pub suggest_compact: bool,
    pub turns: usize,
    pub cache_hit_rate: f64,
    pub latest_cache_hit_rate: f64,
    pub cold_cache_count: usize,
    pub cold_cache_breakdown: ColdCacheBreakdown,
    pub mid_loop_breakdown: MidLoopBreakdown,
    pub turn_start_cold_count: usize,
    pub mid_loop_cold_count: usize,
    pub post_compact_cold_count: usize,
    pub median_ttft_ms: u64,
    pub median_stream_tps: f64,
    pub latest_ttft_ms: u64,
    pub latest_stream_tps: f64,
    pub e2e_tps: f64,
    pub total_input_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_output_tokens: u64,
    pub total_thinking_tokens: u64,
    pub total_response_tokens: u64,
    pub thinking_share_pct: f64,
    pub last_loop_steps: usize,
    pub last_loop_output_tokens: u64,
    pub last_loop_thinking_tokens: u64,
    pub last_loop_cost_usd: f64,
    pub last_loop_cost_cny: f64,
    pub cost_usd: f64,
    pub cost_cny: f64,
    pub currency_code: String,
    pub currency_symbol: String,
    pub summary_modified_ts: f64,
    pub sidebar_sort_ts: f64,
    pub last_active_ts: f64,
    pub last_active_iso: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subagents: Vec<SessionTelemetry>,
    pub running_subagent_count: usize,
    pub history_subagent_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_last_active_ts: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_cost_cny: Option<f64>,
}

#[allow(clippy::too_many_arguments)]
pub fn build_session_telemetry(
    cid: &str,
    summary: Option<&SummaryRecord>,
    turns: &[TurnSample],
    eff_mtime: f64,
    fx_rate: f64,
    rates: &mut RateTable,
    now_ts: f64,
    transcript_step_types: Option<&HashMap<i64, String>>,
) -> SessionTelemetry {
    build_session_telemetry_with_overlap(
        cid,
        summary,
        turns,
        eff_mtime,
        fx_rate,
        rates,
        now_ts,
        transcript_step_types,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_session_telemetry_with_overlap(
    cid: &str,
    summary: Option<&SummaryRecord>,
    turns: &[TurnSample],
    eff_mtime: f64,
    fx_rate: f64,
    rates: &mut RateTable,
    now_ts: f64,
    transcript_step_types: Option<&HashMap<i64, String>>,
    overlap_counts_by_turn: Option<&[usize]>,
) -> SessionTelemetry {
    build_session_telemetry_with_probe(
        cid,
        summary,
        turns,
        eff_mtime,
        fx_rate,
        rates,
        now_ts,
        transcript_step_types,
        overlap_counts_by_turn,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_session_telemetry_with_probe(
    cid: &str,
    summary: Option<&SummaryRecord>,
    turns: &[TurnSample],
    eff_mtime: f64,
    fx_rate: f64,
    rates: &mut RateTable,
    now_ts: f64,
    transcript_step_types: Option<&HashMap<i64, String>>,
    overlap_counts_by_turn: Option<&[usize]>,
    live_probe: Option<&LiveStepProbe>,
) -> SessionTelemetry {
    let cfg = rates.current_settings();
    let lang = rates.get_lang();
    let zh = lang.is_zh();
    let (currency_code, currency_sym) = rates.get_currency();

    let latest = turns.last();
    let latest_turn_step_idx = turns.iter().map(|t| t.step_idx).max().unwrap_or(-1);
    let mut sorted_t_indices: Vec<i64> = transcript_step_types
        .map(|m| {
            let mut ks: Vec<i64> = m.keys().copied().collect();
            ks.sort_unstable();
            ks
        })
        .unwrap_or_default();
    sorted_t_indices.dedup();

    let tmap_has_between = |lo_excl: i64, hi_excl: i64, pred: fn(&str) -> bool| -> bool {
        let Some(tmap) = transcript_step_types else {
            return false;
        };
        if sorted_t_indices.is_empty() || hi_excl <= lo_excl.saturating_add(1) {
            return false;
        }
        let lo = sorted_t_indices.partition_point(|&x| x <= lo_excl);
        let hi = sorted_t_indices.partition_point(|&x| x < hi_excl);
        sorted_t_indices[lo..hi]
            .iter()
            .any(|idx| tmap.get(idx).is_some_and(|s| pred(s.as_str())))
    };

    let mut checkpoint_count = 0usize;
    let mut last_ckpt_pos: Option<usize> = None;
    let mut first_post_ckpt_turn_pos: Option<usize> = None;
    let mut last_ckpt_pre_tokens: u64 = 0;

    for (i, t) in turns.iter().enumerate() {
        let prev_is_ckpt = i > 0 && turns[i - 1].is_checkpoint;
        let prev_step = if i > 0 { turns[i - 1].step_idx } else { -1 };
        let implicit_ckpt_before = !t.is_checkpoint
            && !prev_is_ckpt
            && (t.after_checkpoint
                || tmap_has_between(prev_step, t.step_idx, |s| s == "CHECKPOINT"));

        if implicit_ckpt_before {
            checkpoint_count += 1;
            first_post_ckpt_turn_pos = Some(i);
            last_ckpt_pre_tokens = turns[..i]
                .iter()
                .rev()
                .find(|p| p.context_tokens() > 0)
                .map(|p| p.context_tokens())
                .unwrap_or(0);
        }
        if t.is_checkpoint {
            checkpoint_count += 1;
            last_ckpt_pos = Some(i);
            first_post_ckpt_turn_pos = Some(i + 1);
            last_ckpt_pre_tokens = if t.context_tokens() > 0 {
                t.context_tokens()
            } else {
                turns[..i]
                    .iter()
                    .rev()
                    .find(|p| p.context_tokens() > 0)
                    .map(|p| p.context_tokens())
                    .unwrap_or(0)
            };
        }
    }

    let is_compacting_now = live_probe.is_some_and(|p| p.live_phase == "compacting");
    let trailing_implicit_ckpt = !is_compacting_now
        && !latest.is_some_and(|t| t.is_checkpoint)
        && transcript_step_types.is_some_and(|tmap| {
            let lo = sorted_t_indices.partition_point(|&x| x <= latest_turn_step_idx);
            sorted_t_indices[lo..]
                .iter()
                .any(|idx| tmap.get(idx).map(String::as_str) == Some("CHECKPOINT"))
        });

    if trailing_implicit_ckpt {
        checkpoint_count += 1;
        first_post_ckpt_turn_pos = Some(turns.len());
        last_ckpt_pre_tokens = turns
            .iter()
            .rev()
            .find(|p| p.context_tokens() > 0)
            .map(|p| p.context_tokens())
            .unwrap_or(0);
    }

    let turns_since_compact = match first_post_ckpt_turn_pos {
        Some(first_pos) => turns.len().saturating_sub(first_pos),
        None => turns.len(),
    };
    let just_compacted = latest.is_some_and(|t| t.is_checkpoint) || trailing_implicit_ckpt;

    let post_ckpt_slice = &turns[first_post_ckpt_turn_pos.unwrap_or(0).min(turns.len())..];
    let latest_active_ctx_turn = post_ckpt_slice
        .iter()
        .rev()
        .find(|t| !t.is_checkpoint && t.context_tokens() > 0);

    let compact_summary_bytes = live_probe.map(|p| p.compact_summary_bytes).unwrap_or(0);
    let (pre_compact_tokens, latest_ctx) = if just_compacted {
        let summary_tok_est = if let Some(lt) = latest.filter(|t| t.is_checkpoint) {
            lt.output_tokens.clamp(2_500, 16_000)
        } else if compact_summary_bytes > 0 {
            ((compact_summary_bytes as u64) / 4).clamp(2_500, 16_000)
        } else {
            2_500
        };
        let est = cfg.context.est_post_compact_base + summary_tok_est;
        (last_ckpt_pre_tokens, est)
    } else {
        let cur = latest_active_ctx_turn
            .map(|t| t.context_tokens())
            .unwrap_or(0);
        (last_ckpt_pre_tokens, cur)
    };

    let peak_ctx = turns.iter().map(|t| t.context_tokens()).max().unwrap_or(0);
    let model_id = latest.map(|t| t.model.as_str()).unwrap_or("unknown");
    let default_disp = if zh { "未知模型" } else { "Unknown Model" };
    let model_disp = latest
        .map(|t| t.model_display.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_disp);
    let price = rates.resolve_rate(model_id, model_disp);
    let ctx_limit = if price.context_limit > 0 {
        price.context_limit
    } else if cfg.context.default_limit > 0 {
        cfg.context.default_limit
    } else {
        DEFAULT_CONTEXT_LIMIT
    };
    let remaining_context_tokens = ctx_limit.saturating_sub(latest_ctx);
    let prof = resolve_budget_tier(model_id, model_disp, &cfg);

    let mut total_in = 0u64;
    let mut total_cr = 0u64;
    let mut total_cw = 0u64;
    let mut total_out = 0u64;
    let mut total_thinking = 0u64;
    let mut total_response = 0u64;
    let mut ttfts: Vec<u64> = Vec::new();
    let mut tps_vals: Vec<f64> = Vec::new();
    let mut e2e_tps_vals: Vec<f64> = Vec::new();
    let mut total_usd = 0.0f64;

    for t in turns {
        total_in = total_in.saturating_add(t.input_tokens);
        total_cr = total_cr.saturating_add(t.cache_read);
        total_cw = total_cw.saturating_add(t.cache_write);
        total_out = total_out.saturating_add(t.output_tokens);
        let resp_tok = if t.thinking_tokens == 0 && t.response_tokens == 0 && t.output_tokens > 0 {
            t.output_tokens
        } else {
            t.response_tokens
        };
        total_thinking = total_thinking.saturating_add(t.thinking_tokens);
        total_response = total_response.saturating_add(resp_tok);
        if !t.is_checkpoint {
            if t.ttft_ms > 0 {
                ttfts.push(t.ttft_ms);
            }
            let tps = t.stream_tps();
            if tps > 0.0 {
                tps_vals.push(tps);
            }
            let e2e = t.e2e_tps();
            if e2e > 0.0 {
                e2e_tps_vals.push(e2e);
            }
        }
        total_usd += rates.calculate_cost_usd(
            &t.model,
            t.input_tokens,
            t.cache_read,
            t.cache_write,
            t.output_tokens,
            &t.model_display,
        );
    }
    let total_prompt = total_in.saturating_add(total_cr).saturating_add(total_cw);
    let cache_hit = if total_prompt > 0 {
        (total_cr as f64) / (total_prompt as f64) * 100.0
    } else {
        0.0
    };
    let thinking_share_pct = if total_out > 0 {
        round_dp(
            ((total_thinking as f64) / (total_out as f64) * 100.0).min(100.0),
            1,
        )
    } else {
        0.0
    };

    let latest_ttft_ms = turns
        .iter()
        .rev()
        .find(|t| !t.is_checkpoint && t.ttft_ms > 0)
        .map(|t| t.ttft_ms)
        .unwrap_or(0);
    let latest_stream_tps = turns
        .iter()
        .rev()
        .find(|t| !t.is_checkpoint && t.stream_tps() > 0.0)
        .map(|t| round_dp(t.stream_tps(), 1))
        .unwrap_or(0.0);

    // Current/latest agent loop rollup: walk backwards from the active post-checkpoint window
    // until hitting `after_turn_start == Some(true)` (inclusive) or a checkpoint/user boundary.
    let mut last_loop_steps = 0usize;
    let mut last_loop_output_tokens = 0u64;
    let mut last_loop_thinking_tokens = 0u64;
    let mut last_loop_cost_usd = 0.0f64;
    if !just_compacted {
        let active_start = first_post_ckpt_turn_pos.unwrap_or(0).min(turns.len());
        if let Some(rel_last) = turns[active_start..].iter().rposition(|t| !t.is_checkpoint) {
            let end_idx = active_start + rel_last;
            for idx in (active_start..=end_idx).rev() {
                let t = &turns[idx];
                if t.is_checkpoint {
                    break;
                }
                last_loop_steps += 1;
                last_loop_output_tokens = last_loop_output_tokens.saturating_add(t.output_tokens);
                last_loop_thinking_tokens =
                    last_loop_thinking_tokens.saturating_add(t.thinking_tokens);
                last_loop_cost_usd += rates.calculate_cost_usd(
                    &t.model,
                    t.input_tokens,
                    t.cache_read,
                    t.cache_write,
                    t.output_tokens,
                    &t.model_display,
                );
                let prev_step = if idx > 0 { turns[idx - 1].step_idx } else { -1 };
                let saw_loop_start_in_transcript = tmap_has_between(prev_step, t.step_idx, |s| {
                    matches!(s, "CHECKPOINT" | "USER_INPUT" | "SYSTEM_MESSAGE")
                });
                if t.after_turn_start == Some(true)
                    || t.after_checkpoint
                    || saw_loop_start_in_transcript
                {
                    break;
                }
            }
        }
    }
    let last_loop_cost_cny = last_loop_cost_usd * fx_rate;

    let cold_classified =
        classify_cold_cache_turns_detailed(turns, transcript_step_types, overlap_counts_by_turn);
    let mut cold_breakdown = ColdCacheBreakdown::default();
    let mut mid_loop_breakdown = MidLoopBreakdown::default();
    for c in &cold_classified {
        match c.kind {
            ColdCacheKind::TurnStart => cold_breakdown.turn_start_cold += 1,
            ColdCacheKind::MidLoop => {
                cold_breakdown.mid_loop_cold += 1;
                match c.sub_reason {
                    MidLoopSubReason::SlowTurnSelfExpiry => {
                        mid_loop_breakdown.slow_turn_self_expiry += 1
                    }
                    MidLoopSubReason::ReplicaSpillover => mid_loop_breakdown.replica_spillover += 1,
                    MidLoopSubReason::ModelSwitchCold => mid_loop_breakdown.model_switch_cold += 1,
                    MidLoopSubReason::Other | MidLoopSubReason::None => {
                        mid_loop_breakdown.other += 1
                    }
                }
            }
            ColdCacheKind::PostCompact => cold_breakdown.post_compact_cold += 1,
            ColdCacheKind::None => {}
        }
    }
    let cold_cache_count = cold_breakdown.turn_start_cold
        + cold_breakdown.mid_loop_cold
        + cold_breakdown.post_compact_cold;

    let post_ckpt_start = match first_post_ckpt_turn_pos {
        Some(first_pos) => (first_pos + 1).min(turns.len()),
        None => 1.min(turns.len()),
    };
    let post_ckpt_turns = &turns[post_ckpt_start..];
    let post_ckpt_kinds = &cold_classified[post_ckpt_start..];
    let recent_start = post_ckpt_turns.len().saturating_sub(3);
    let recent_cold_rebuild = post_ckpt_turns[recent_start..]
        .iter()
        .zip(post_ckpt_kinds[recent_start..].iter())
        .any(|(t, c)| c.kind != ColdCacheKind::None && t.context_tokens() >= 60_000);

    let med_ttft = median_u64(&mut ttfts);
    let med_tps = round_dp(median_f64(&mut tps_vals), 1);
    let e2e_tps = round_dp(median_f64(&mut e2e_tps_vals), 1);
    let total_cny = total_usd * fx_rate;

    let crit_line = effective_critical_threshold(&prof, &cfg);
    let (level, suggest_compact) = if just_compacted {
        ("ok", false)
    } else if latest_ctx >= crit_line {
        ("critical", true)
    } else if latest_ctx >= prof.min_ctx {
        ("warn", latest_ctx >= prof.recommend_ctx)
    } else {
        ("ok", latest_ctx >= prof.recommend_ctx)
    };

    let killed = summary.map(|s| s.killed).unwrap_or(false);
    let is_running = summary
        .map(|s| s.status == "CASCADE_RUN_STATUS_RUNNING" && !s.killed)
        .unwrap_or(false);
    let not_fully_idle = summary
        .map(|s| s.not_fully_idle && !s.killed)
        .unwrap_or(false);
    let is_side_question = summary.map(|s| s.is_side_question).unwrap_or(false)
        || live_probe.map(|p| p.is_side_question).unwrap_or(false);
    let is_subagent = is_side_question || summary.map(|s| s.is_subagent()).unwrap_or(false);
    let agent_name = summary.map(|s| s.agent_name.clone()).unwrap_or_default();
    let parent_id = summary
        .map(|s| s.parent_conversation_id.clone())
        .unwrap_or_default();
    let archived = summary.map(|s| s.archived).unwrap_or(false);
    let pinned = summary.map(|s| s.pinned).unwrap_or(false);
    let workspace = summary.map(|s| s.workspace.clone()).unwrap_or_default();
    let workspaces = summary.map(|s| s.workspaces.clone()).unwrap_or_default();
    let workspace_name = if workspace.is_empty() {
        String::new()
    } else {
        let base = Path::new(workspace.trim_end_matches('/'))
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if workspaces.len() > 1 && !base.is_empty() {
            format!("{base} (+{})", workspaces.len() - 1)
        } else {
            base
        }
    };

    let short_id: String = cid.chars().take(8).collect();
    let title = if let Some(s) = summary.filter(|s| !s.title.is_empty()) {
        s.title.clone()
    } else if !agent_name.is_empty() {
        agent_name.clone()
    } else if let Some(s) = summary.filter(|s| !s.preview.is_empty()) {
        s.preview.chars().take(48).collect()
    } else if zh {
        format!("会话 {short_id}")
    } else {
        format!("Session {short_id}")
    };

    let summary_mod_ts = summary
        .map(|s| parse_iso_ts(&s.last_modified_time))
        .unwrap_or(0.0);
    let turn_ts = latest
        .filter(|t| t.timestamp > 0.0)
        .map(|t| t.timestamp)
        .unwrap_or(eff_mtime);
    let last_ts = if summary_mod_ts > 0.0 {
        summary_mod_ts.max(turn_ts)
    } else {
        turn_ts
    };
    let last_iso = format_utc_iso(last_ts);

    let is_active = if is_side_question {
        is_side_question_active(killed, eff_mtime, now_ts, live_probe, latest_turn_step_idx)
    } else if is_subagent {
        is_subagent_active(
            summary,
            last_ts,
            now_ts,
            cfg.context.subagent_silent_timeout_sec,
        )
    } else {
        is_running || not_fully_idle
    };

    let run_state = if killed {
        "killed"
    } else if is_running {
        "running"
    } else if is_active {
        "active"
    } else {
        "idle"
    };

    let cache_ttl_sec = model_cache_ttl_sec(model_id, model_disp) as u64;
    let model_short = rates.short_model_label(model_disp, model_id);
    let ctx_pct = if ctx_limit > 0 {
        round_dp((latest_ctx as f64) / (ctx_limit as f64) * 100.0, 1)
    } else {
        0.0
    };

    let active_phase_str = if killed {
        ""
    } else {
        live_probe.map(|p| p.live_phase.as_str()).unwrap_or("")
    };
    let cross_model_compact = if active_phase_str == "compacting" {
        if let Some(ckpt_pos) = last_ckpt_pos.filter(|_| just_compacted) {
            let mut ckpt_model =
                canonical_model_key(&turns[ckpt_pos].model, &turns[ckpt_pos].model_display);
            if ckpt_model.is_empty() {
                ckpt_model = live_probe
                    .map(|p| canonical_model_key(&p.live_model, ""))
                    .unwrap_or_default();
            }
            let prev_model = turns[..ckpt_pos]
                .iter()
                .rev()
                .find(|t| !t.is_checkpoint)
                .map(|t| canonical_model_key(&t.model, &t.model_display))
                .unwrap_or_default();
            !ckpt_model.is_empty() && !prev_model.is_empty() && ckpt_model != prev_model
        } else {
            let active_model = live_probe
                .map(|p| canonical_model_key(&p.live_model, ""))
                .unwrap_or_default();
            let prev_model = turns
                .iter()
                .rev()
                .find(|t| !t.is_checkpoint)
                .map(|t| canonical_model_key(&t.model, &t.model_display))
                .unwrap_or_default();
            !active_model.is_empty() && !prev_model.is_empty() && active_model != prev_model
        }
    } else if let Some(ckpt_pos) = last_ckpt_pos.filter(|_| just_compacted) {
        let ckpt_model =
            canonical_model_key(&turns[ckpt_pos].model, &turns[ckpt_pos].model_display);
        let prev_model = turns[..ckpt_pos]
            .iter()
            .rev()
            .find(|t| !t.is_checkpoint)
            .map(|t| canonical_model_key(&t.model, &t.model_display))
            .unwrap_or_default();
        !ckpt_model.is_empty() && !prev_model.is_empty() && ckpt_model != prev_model
    } else {
        false
    };

    let effective_probe = if is_side_question && !is_active {
        None
    } else {
        live_probe
    };
    let (live_status, live_phase, live_elapsed_sec, live_error) = compute_live_state(
        effective_probe,
        is_active,
        summary.is_some(),
        killed,
        cross_model_compact,
        now_ts,
    );

    let compact_summary_kb = if compact_summary_bytes > 0 {
        round_dp((compact_summary_bytes as f64) / 1024.0, 1)
    } else {
        0.0
    };

    SessionTelemetry {
        id: cid.to_string(),
        conversation_id: cid.to_string(),
        short_id,
        title,
        agent_name,
        parent_id,
        is_subagent,
        is_side_question,
        is_running,
        not_fully_idle,
        is_active,
        run_state: run_state.to_string(),
        live_status,
        live_phase,
        live_elapsed_sec,
        live_error,
        killed,
        archived,
        pinned,
        status: summary.map(|s| s.status.clone()).unwrap_or_default(),
        workspace,
        workspaces,
        workspace_name,
        model: model_id.to_string(),
        model_display: model_disp.to_string(),
        model_short,
        cache_ttl_sec,
        pricing_known: price.pricing_known,
        profile_label: prof.label,
        min_compact_tokens: prof.min_ctx,
        recommend_compact_tokens: prof.recommend_ctx,
        urgent_compact_tokens: crit_line,
        just_compacted,
        cross_model_compact,
        compact_summary_kb,
        pre_compact_tokens,
        checkpoint_count,
        turns_since_compact,
        recent_cold_rebuild,
        latest_context_tokens: latest_ctx,
        remaining_context_tokens,
        peak_context_tokens: peak_ctx,
        context_limit: ctx_limit,
        context_pct: ctx_pct,
        level: level.to_string(),
        suggest_compact,
        turns: turns.len(),
        cache_hit_rate: round_dp(cache_hit, 1),
        latest_cache_hit_rate: if just_compacted {
            latest
                .map(|t| round_dp(t.cache_hit_rate(), 1))
                .unwrap_or(0.0)
        } else {
            latest_active_ctx_turn
                .or(latest)
                .map(|t| round_dp(t.cache_hit_rate(), 1))
                .unwrap_or(0.0)
        },
        cold_cache_count,
        turn_start_cold_count: cold_breakdown.turn_start_cold,
        mid_loop_cold_count: cold_breakdown.mid_loop_cold,
        post_compact_cold_count: cold_breakdown.post_compact_cold,
        cold_cache_breakdown: cold_breakdown,
        mid_loop_breakdown,
        median_ttft_ms: med_ttft,
        median_stream_tps: med_tps,
        latest_ttft_ms,
        latest_stream_tps,
        e2e_tps,
        total_input_tokens: total_in,
        total_cache_read_tokens: total_cr,
        total_output_tokens: total_out,
        total_thinking_tokens: total_thinking,
        total_response_tokens: total_response,
        thinking_share_pct,
        last_loop_steps,
        last_loop_output_tokens,
        last_loop_thinking_tokens,
        last_loop_cost_usd: round_dp(last_loop_cost_usd, 4),
        last_loop_cost_cny: round_dp(last_loop_cost_cny, 2),
        cost_usd: round_dp(total_usd, 4),
        cost_cny: round_dp(total_cny, 2),
        currency_code,
        currency_symbol: currency_sym,
        summary_modified_ts: round_dp(summary_mod_ts, 3),
        sidebar_sort_ts: round_dp(last_ts, 3),
        last_active_ts: round_dp(last_ts, 3),
        last_active_iso: last_iso,
        subagents: Vec::new(),
        running_subagent_count: 0,
        history_subagent_count: 0,
        effective_last_active_ts: None,
        group_cost_usd: None,
        group_cost_cny: None,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnViewRow {
    pub turn: usize,
    pub step_idx: i64,
    pub is_checkpoint: bool,
    pub time_iso: String,
    pub model: String,
    pub model_display: String,
    pub context_tokens: u64,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub response_tokens: u64,
    pub cache_hit_rate: f64,
    pub is_cold_cache: bool,
    pub is_partial_cold: bool,
    pub cold_cache_kind: String,
    pub cold_cache_label: String,
    pub cold_cache_reason: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cold_cache_sub_reason: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cold_cache_sub_label: String,
    pub ttft_ms: u64,
    pub total_ms: u64,
    pub stream_tps: f64,
    pub e2e_tps: f64,
    pub cost_usd: f64,
    pub cost_cny: f64,
    pub currency_code: String,
    pub currency_symbol: String,
}

pub fn format_turn_rows(
    turns: &[TurnSample],
    limit: usize,
    fx_rate: f64,
    rates: &mut RateTable,
    transcript_step_types: Option<&HashMap<i64, String>>,
) -> Vec<TurnViewRow> {
    format_turn_rows_with_overlap(turns, limit, fx_rate, rates, transcript_step_types, None)
}

pub fn format_turn_rows_with_overlap(
    turns: &[TurnSample],
    limit: usize,
    fx_rate: f64,
    rates: &mut RateTable,
    transcript_step_types: Option<&HashMap<i64, String>>,
    overlap_counts_by_turn: Option<&[usize]>,
) -> Vec<TurnViewRow> {
    let cold_classified =
        classify_cold_cache_turns_detailed(turns, transcript_step_types, overlap_counts_by_turn);
    let lang = rates.get_lang();
    let (currency_code, currency_sym) = rates.get_currency();
    let start = turns.len().saturating_sub(limit);
    let mut rows = Vec::with_capacity(turns.len() - start);
    for (t, c) in turns[start..]
        .iter()
        .zip(cold_classified[start..].iter())
        .rev()
    {
        let usd = rates.calculate_cost_usd(
            &t.model,
            t.input_tokens,
            t.cache_read,
            t.cache_write,
            t.output_tokens,
            &t.model_display,
        );
        let c_kind = c.kind;
        let is_cold = c_kind != ColdCacheKind::None;
        let is_partial = is_cold && t.cache_read > 0;
        let ttl_sec = model_cache_ttl_sec(&t.model, &t.model_display) as u64;
        let (c_label, c_reason) = if c_kind == ColdCacheKind::MidLoop
            && !matches!(
                c.sub_reason,
                MidLoopSubReason::None | MidLoopSubReason::Other
            ) {
            c.sub_reason
                .label_and_reason_for_lang(lang, ttl_sec, is_partial)
        } else {
            c_kind.label_and_reason_for_lang_with_ttl(lang, is_partial, ttl_sec)
        };
        let (sub_reason_str, sub_label_str) = if c_kind == ColdCacheKind::MidLoop {
            let (sl, _) = c
                .sub_reason
                .label_and_reason_for_lang(lang, ttl_sec, is_partial);
            (c.sub_reason.as_str().to_string(), sl.to_string())
        } else {
            (String::new(), String::new())
        };
        let resp_tok = if t.thinking_tokens == 0 && t.response_tokens == 0 && t.output_tokens > 0 {
            t.output_tokens
        } else {
            t.response_tokens
        };
        rows.push(TurnViewRow {
            turn: t.turn_index,
            step_idx: t.step_idx,
            is_checkpoint: t.is_checkpoint,
            time_iso: format_utc_iso(t.timestamp),
            model: t.model.clone(),
            model_display: t.model_display.clone(),
            context_tokens: t.context_tokens(),
            input_tokens: t.input_tokens,
            cache_read_tokens: t.cache_read,
            cache_write_tokens: t.cache_write,
            output_tokens: t.output_tokens,
            thinking_tokens: t.thinking_tokens,
            response_tokens: resp_tok,
            cache_hit_rate: round_dp(t.cache_hit_rate(), 1),
            is_cold_cache: is_cold,
            is_partial_cold: is_partial,
            cold_cache_kind: c_kind.as_str().to_string(),
            cold_cache_label: c_label.to_string(),
            cold_cache_reason: c_reason.to_string(),
            cold_cache_sub_reason: sub_reason_str,
            cold_cache_sub_label: sub_label_str,
            ttft_ms: t.ttft_ms,
            total_ms: t.total_ms,
            stream_tps: round_dp(t.stream_tps(), 1),
            e2e_tps: round_dp(t.e2e_tps(), 1),
            cost_usd: round_dp(usd, 4),
            cost_cny: round_dp(usd * fx_rate, 3),
            currency_code: currency_code.clone(),
            currency_symbol: currency_sym.clone(),
        });
    }
    rows
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotThresholds {
    pub warn: u64,
    pub compact: u64,
    pub critical: u64,
    pub max: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotSummary {
    pub total_db_files: usize,
    pub total_main_count: usize,
    pub total_subagent_count: usize,
    pub total_archived_count: usize,
    pub archived_hidden_count: usize,
    pub history_subagents_hidden_count: usize,
    pub shown_main_count: usize,
    pub shown_subagent_count: usize,
    pub running_main_count: usize,
    pub running_subagent_count: usize,
    pub active_carbon_count: usize,
    pub carbon_concurrency_warning: bool,
    pub compact_needed_count: usize,
    pub critical_count: usize,
    pub compacting_count: usize,
    pub error_session_count: usize,
    pub total_cost_usd: f64,
    pub total_cost_cny: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UiSettingsSnapshot {
    pub lang: String,
    pub currency_code: String,
    pub fx_rate: f64,
    pub poll_interval_sec: u64,
    pub bg_poll_interval_sec: i64,
    pub allow_auto_handoff: bool,
    pub compact_threshold: u64,
    pub theme: String,
    pub last_host_theme: String,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Serialize)]
pub struct OverviewSnapshot {
    pub mode: String,
    pub unchanged: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub stale: bool,
    pub digest: String,
    pub server_ms: u64,
    pub generated_at: String,
    pub generated_ts: f64,
    #[serde(skip)]
    pub(crate) refresh_at: f64,
    pub lang: String,
    pub fx_rate: f64,
    pub fx_source: String,
    pub currency_code: String,
    pub currency_symbol: String,
    pub currency_explicit: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub daemon_workspace: String,
    pub show_history_subagents: bool,
    pub thresholds: SnapshotThresholds,
    pub summary: SnapshotSummary,
    #[serde(skip_serializing_if = "is_zero")]
    pub active_carbon_count: usize,
    #[serde(skip_serializing_if = "is_false")]
    pub carbon_concurrency_warning: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub carbon_concurrency_note: Option<String>,
    pub sessions: Vec<SessionTelemetry>,
    pub orphan_subagents: Vec<SessionTelemetry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<PanelPrefs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_settings: Option<UiSettingsSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_grant: Option<RelayGrant>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionTurnsPayload {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionTelemetry>,
    pub total_turns: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cold_cache_breakdown: Option<ColdCacheBreakdown>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid_loop_breakdown: Option<MidLoopBreakdown>,
    pub turns: Vec<TurnViewRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MetricsCacheKey {
    db_stamp: Option<(u64, u64, DbVersionSig)>,
    transcript_stamp: Option<(u64, u64, i128, u64)>,
    summary: Option<SummaryRecord>,
    fx_micros: i64,
    settings_gen: u64,
    lang: Lang,
    currency_code: String,
    overlap_sig: u64,
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Deterministic 16-hex content digest ignoring volatile clock fields (`generated_at`/`server_ms`).
pub fn compute_snapshot_digest(snap: &OverviewSnapshot) -> String {
    #[derive(Serialize)]
    struct StableView<'a> {
        lang: &'a str,
        fx_rate: f64,
        currency_code: &'a str,
        currency_symbol: &'a str,
        currency_explicit: bool,
        daemon_workspace: &'a str,
        show_history_subagents: bool,
        thresholds: &'a SnapshotThresholds,
        summary: &'a SnapshotSummary,
        sessions: &'a [SessionTelemetry],
        orphan_subagents: &'a [SessionTelemetry],
        settings: &'a Option<PanelPrefs>,
        ui_settings: &'a Option<UiSettingsSnapshot>,
        settings_path: &'a Option<String>,
        settings_error: &'a Option<String>,
        pending_grant: &'a Option<RelayGrant>,
    }

    let stable = StableView {
        lang: &snap.lang,
        fx_rate: snap.fx_rate,
        currency_code: &snap.currency_code,
        currency_symbol: &snap.currency_symbol,
        currency_explicit: snap.currency_explicit,
        daemon_workspace: &snap.daemon_workspace,
        show_history_subagents: snap.show_history_subagents,
        thresholds: &snap.thresholds,
        summary: &snap.summary,
        sessions: &snap.sessions,
        orphan_subagents: &snap.orphan_subagents,
        settings: &snap.settings,
        ui_settings: &snap.ui_settings,
        settings_path: &snap.settings_path,
        settings_error: &snap.settings_error,
        pending_grant: &snap.pending_grant,
    };
    let bytes = serde_json::to_vec(&stable).unwrap_or_default();
    let h = fnv1a_64(&bytes);
    format!("{h:016x}")
}

fn resolve_disk_cache_path(
    data_root: &Path,
    plugin_data_dir: Option<&Path>,
    rates: &mut RateTable,
    explicit: Option<Option<PathBuf>>,
) -> Option<PathBuf> {
    if let Ok(dis) = env::var(DISABLE_DISK_CACHE_ENV) {
        let low = dis.trim().to_ascii_lowercase();
        if matches!(low.as_str(), "1" | "true" | "yes") {
            return None;
        }
    }
    if let Some(ov) = explicit {
        return ov;
    }
    let cfg = rates.current_settings();
    if !cfg.context.enable_disk_cache {
        return None;
    }
    if let Ok(env_p) = env::var(INDEX_CACHE_PATH_ENV) {
        let trimmed = env_p.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(expand_tilde(trimmed)));
        }
    }
    if !cfg.context.disk_cache_path.is_empty() {
        return Some(PathBuf::from(&cfg.context.disk_cache_path));
    }
    let base = plugin_data_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_plugin_data_dir(data_root));
    Some(base.join("index_cache.sqlite"))
}

fn detect_initial_workspace() -> (Option<String>, bool) {
    if let Ok(ov) = env::var(WORKSPACE_ENV) {
        let trimmed = ov.trim();
        if !trimmed.is_empty() {
            return (Some(expand_tilde(trimmed)), true);
        }
    }
    let cwd = env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty());
    (cwd, false)
}

pub struct TelemetryEngine {
    pub ledger: LedgerReader,
    pub rates: RateTable,
    #[cfg(test)]
    pub(crate) overview_build_count: usize,
    preferred_workspace: Option<String>,
    workspace_explicit: bool,
    metrics_cache: HashMap<String, (MetricsCacheKey, LiveStepProbe, SessionTelemetry)>,
}

impl TelemetryEngine {
    pub fn new(
        data_root: Option<PathBuf>,
        rates: Option<RateTable>,
        explicit_disk_cache: Option<Option<PathBuf>>,
    ) -> Self {
        Self::new_with_plugin_data(data_root, None, rates, explicit_disk_cache)
    }

    pub fn new_with_plugin_data(
        data_root: Option<PathBuf>,
        plugin_data_dir: Option<PathBuf>,
        rates: Option<RateTable>,
        explicit_disk_cache: Option<Option<PathBuf>>,
    ) -> Self {
        let root = data_root
            .unwrap_or_else(|| default_data_root_for_plugin_data(plugin_data_dir.as_deref()));
        let mut rate_table = rates.unwrap_or_else(|| {
            RateTable::new(
                SettingsWatcher::new_with_plugin_data(None, plugin_data_dir.clone()),
                None,
                None,
            )
        });
        let disk_path = resolve_disk_cache_path(
            &root,
            plugin_data_dir.as_deref(),
            &mut rate_table,
            explicit_disk_cache,
        );
        let ledger = LedgerReader::new(root, disk_path);
        let (preferred_workspace, workspace_explicit) = detect_initial_workspace();
        Self {
            ledger,
            rates: rate_table,
            #[cfg(test)]
            overview_build_count: 0,
            preferred_workspace,
            workspace_explicit,
            metrics_cache: HashMap::new(),
        }
    }

    pub fn set_preferred_workspace(&mut self, workspace: Option<String>, explicit: bool) {
        self.preferred_workspace = workspace.filter(|s| !s.trim().is_empty());
        self.workspace_explicit = explicit;
    }

    /// Return the workspace bound to this daemon process ONLY when explicitly set via
    /// `CONTEXT_RADAR_WORKSPACE` / `set_preferred_workspace` OR when `current_dir` matches at least
    /// one known session in `conversation_summaries.db` (so synthetic test fixtures are unaffected).
    pub fn effective_daemon_workspace(&mut self) -> Option<String> {
        let cand = self.preferred_workspace.as_deref()?.trim();
        if cand.is_empty() {
            return None;
        }
        if self.workspace_explicit {
            return Some(cand.to_string());
        }
        let summaries = self.ledger.read_summaries();
        let matched = summaries.values().any(|s| {
            (!s.workspace.is_empty() || !s.workspaces.is_empty())
                && workspaces_overlap(&s.workspace, &s.workspaces, cand)
        });
        if matched {
            Some(cand.to_string())
        } else {
            None
        }
    }

    pub fn close(&mut self) {
        self.ledger.close();
    }

    fn transcript_types_if_needed(
        &mut self,
        cid: &str,
        turns: &[TurnSample],
    ) -> Option<HashMap<i64, String>> {
        let needs_scan = turns.iter().enumerate().any(|(i, t)| {
            let prev = if i > 0 { Some(&turns[i - 1]) } else { None };
            (t.is_cold_cache() || is_partial_prefix_drop(prev, t)) && t.after_turn_start.is_none()
        });
        if needs_scan {
            let root = self.ledger.data_root.clone();
            Some(self.ledger.journal_cache.get_step_types(&root, cid))
        } else {
            None
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build_metrics_cached(
        &mut self,
        cid: &str,
        summary: Option<&SummaryRecord>,
        turns: &[TurnSample],
        stamp: Option<&FileStamp>,
        fx_rate: f64,
        ref_now: f64,
        overlap_counts_by_turn: Option<&[usize]>,
        live_probe: Option<&LiveStepProbe>,
    ) -> SessionTelemetry {
        let cfg = self.rates.current_settings();
        let lang = self.rates.get_lang();
        let (currency_code, _) = self.rates.get_currency();
        let mut overlap_sig = 0u64;
        if let Some(counts) = overlap_counts_by_turn {
            for &c in counts {
                overlap_sig = overlap_sig
                    .wrapping_mul(0x100000001b3)
                    .wrapping_add(u64::from(c >= 3));
            }
        }
        let transcript_stamp = if turns.iter().any(|t| t.after_turn_start.is_none()) {
            JournalTailCache::stat_transcript_stamp(&self.ledger.data_root, cid)
        } else {
            None
        };
        let cache_key = MetricsCacheKey {
            db_stamp: stamp.map(|s| (s.dev, s.ino, s.sig.clone())),
            transcript_stamp,
            summary: summary.cloned(),
            fx_micros: (fx_rate * 1_000_000.0).round() as i64,
            settings_gen: cfg.generation,
            lang,
            currency_code,
            overlap_sig,
        };
        let owned_probe = live_probe.cloned().unwrap_or_default();
        if let Some((prev_key, prev_probe, prev_tel)) = self.metrics_cache.get(cid) {
            if *prev_key == cache_key && *prev_probe == owned_probe {
                let mut out = prev_tel.clone();
                let eff_mtime = stamp.map(|s| s.eff_mtime).unwrap_or(out.last_active_ts);
                let latest_turn_step_idx = turns.iter().map(|t| t.step_idx).max().unwrap_or(-1);
                if out.is_subagent {
                    let is_act = if out.is_side_question {
                        is_side_question_active(
                            out.killed,
                            eff_mtime,
                            ref_now,
                            Some(prev_probe),
                            latest_turn_step_idx,
                        )
                    } else {
                        is_subagent_active(
                            summary,
                            out.last_active_ts,
                            ref_now,
                            cfg.context.subagent_silent_timeout_sec,
                        )
                    };
                    out.is_active = is_act;
                    out.run_state = if out.killed {
                        "killed"
                    } else if out.is_running {
                        "running"
                    } else if is_act {
                        "active"
                    } else {
                        "idle"
                    }
                    .to_string();
                }
                let eff_probe = if out.is_side_question && !out.is_active {
                    None
                } else {
                    Some(prev_probe)
                };
                let (ls, lp, le, lerr) = compute_live_state(
                    eff_probe,
                    out.is_active,
                    summary.is_some(),
                    out.killed,
                    out.cross_model_compact,
                    ref_now,
                );
                out.live_status = ls;
                out.live_phase = lp;
                out.live_elapsed_sec = le;
                out.live_error = lerr;
                return out;
            }
        }

        let t_types = self.transcript_types_if_needed(cid, turns);
        let eff_mtime = stamp.map(|s| s.eff_mtime).unwrap_or(0.0);
        let tel = build_session_telemetry_with_probe(
            cid,
            summary,
            turns,
            eff_mtime,
            fx_rate,
            &mut self.rates,
            ref_now,
            t_types.as_ref(),
            overlap_counts_by_turn,
            live_probe,
        );
        self.metrics_cache
            .insert(cid.to_string(), (cache_key, owned_probe, tel.clone()));
        tel
    }

    fn make_model_window(
        cid: &str,
        turns: &[TurnSample],
        summary: Option<&SummaryRecord>,
        eff_mtime: f64,
        is_active: bool,
    ) -> Option<ActiveModelWindow> {
        let latest = turns.last()?;
        let model_key = normalized_model_family(&latest.model, &latest.model_display);
        let min_ts = turns
            .iter()
            .map(|t| t.timestamp)
            .filter(|&ts| ts > 0.0)
            .fold(f64::INFINITY, f64::min);
        let min_ts = if min_ts.is_finite() {
            min_ts
        } else {
            eff_mtime
        };
        let summary_mod = summary
            .map(|s| parse_iso_ts(&s.last_modified_time))
            .unwrap_or(0.0);
        let max_ts = latest.ended_ts().max(eff_mtime).max(summary_mod);
        Some(ActiveModelWindow {
            cid: cid.to_string(),
            model_key,
            min_ts,
            max_ts,
            is_active,
            is_carbon: is_gemini_4_carbon(&latest.model, &latest.model_display),
        })
    }

    pub fn try_get_turn_and_checkpoint_counts(
        &mut self,
        cid: &str,
    ) -> rusqlite::Result<(usize, usize)> {
        if cid.is_empty() || !is_safe_id(cid) {
            return Ok((0, 0));
        }
        let (turns, _) = self.ledger.try_read_turns_and_probe(cid, None)?;
        let ckpts = turns.iter().filter(|t| t.is_checkpoint).count();
        Ok((turns.len(), ckpts))
    }

    pub fn get_turn_and_checkpoint_counts(&mut self, cid: &str) -> (usize, usize) {
        if cid.is_empty() || !is_safe_id(cid) {
            return (0, 0);
        }
        let turns = self.ledger.read_turns(cid, None);
        let ckpts = turns.iter().filter(|t| t.is_checkpoint).count();
        (turns.len(), ckpts)
    }

    pub fn try_get_running_subagent_count(
        &mut self,
        parent_cid: &str,
        now_override: Option<f64>,
    ) -> rusqlite::Result<usize> {
        if parent_cid.is_empty() || !is_safe_id(parent_cid) {
            return Ok(0);
        }
        let ref_now = now_override.unwrap_or_else(now_epoch_sec);
        let silent_sec = self
            .rates
            .current_settings()
            .context
            .subagent_silent_timeout_sec;
        let candidates: Vec<(String, SummaryRecord)> = self
            .ledger
            .try_read_summaries()?
            .iter()
            .filter(|(_, s)| s.parent_conversation_id == parent_cid && s.is_subagent())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let mut count = 0usize;
        for (cid, s) in candidates {
            let Some(stamp) = stat_db_stamp(&self.ledger.db_path(&cid)) else {
                continue;
            };
            if s.is_side_question {
                if !s.killed
                    && (ref_now - stamp.eff_mtime).max(0.0) <= SIDE_QUESTION_RECENT_PROBE_SEC
                {
                    let (turns, probe) =
                        self.ledger.try_read_turns_and_probe(&cid, Some(&stamp))?;
                    let latest_step = turns.iter().map(|t| t.step_idx).max().unwrap_or(-1);
                    if is_side_question_active(
                        s.killed,
                        stamp.eff_mtime,
                        ref_now,
                        Some(&probe),
                        latest_step,
                    ) {
                        count += 1;
                    }
                }
                continue;
            }
            let eff_ts = parse_iso_ts(&s.last_modified_time).max(stamp.eff_mtime);
            if is_subagent_active(Some(&s), eff_ts, ref_now, silent_sec) {
                count += 1;
            }
        }
        Ok(count)
    }

    pub fn get_running_subagent_count(
        &mut self,
        parent_cid: &str,
        now_override: Option<f64>,
    ) -> usize {
        if parent_cid.is_empty() || !is_safe_id(parent_cid) {
            return 0;
        }
        let ref_now = now_override.unwrap_or_else(now_epoch_sec);
        let silent_sec = self
            .rates
            .current_settings()
            .context
            .subagent_silent_timeout_sec;
        let candidates: Vec<(String, SummaryRecord)> = self
            .ledger
            .read_summaries()
            .iter()
            .filter(|(_, s)| s.parent_conversation_id == parent_cid && s.is_subagent())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let mut count = 0usize;
        for (cid, s) in candidates {
            let Some(stamp) = stat_db_stamp(&self.ledger.db_path(&cid)) else {
                continue;
            };
            if s.is_side_question {
                if !s.killed
                    && (ref_now - stamp.eff_mtime).max(0.0) <= SIDE_QUESTION_RECENT_PROBE_SEC
                {
                    let (turns, probe) = self.ledger.read_turns_and_probe(&cid, Some(&stamp));
                    let latest_step = turns.iter().map(|t| t.step_idx).max().unwrap_or(-1);
                    if is_side_question_active(
                        s.killed,
                        stamp.eff_mtime,
                        ref_now,
                        Some(&probe),
                        latest_step,
                    ) {
                        count += 1;
                    }
                }
                continue;
            }
            let eff_ts = parse_iso_ts(&s.last_modified_time).max(stamp.eff_mtime);
            if is_subagent_active(Some(&s), eff_ts, ref_now, silent_sec) {
                count += 1;
            }
        }
        count
    }

    /// Return IDs of main sessions concurrently in `CASCADE_RUN_STATUS_RUNNING` within the active
    /// workspace scope (modified within 120s), used to detect ambiguous omitted `conversation_id` on `commit_handoff`.
    pub fn ambiguous_running_mains_in_scope(&mut self, now_override: Option<f64>) -> Vec<String> {
        let ref_now = now_override.unwrap_or_else(now_epoch_sec);
        let eff_ws = self.effective_daemon_workspace();
        let summaries = self.ledger.read_summaries();
        let (file_mtimes, _) = self.ledger.scan_dir();
        let mut ids: Vec<(f64, String)> = Vec::new();
        for (cid, s) in summaries.iter() {
            if s.is_subagent() || s.killed || s.status != "CASCADE_RUN_STATUS_RUNNING" {
                continue;
            }
            let Some(&mtime) = file_mtimes.get(cid) else {
                continue;
            };
            let ts = parse_iso_ts(&s.last_modified_time).max(mtime);
            if ref_now > 0.0 && ts > 0.0 && (ref_now - ts) > 120.0 {
                continue;
            }
            if let Some(ref ws) = eff_ws {
                if (!s.workspace.is_empty() || !s.workspaces.is_empty())
                    && !workspaces_overlap(&s.workspace, &s.workspaces, ws)
                {
                    continue;
                }
            }
            ids.push((ts, cid.clone()));
        }
        ids.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.1.cmp(&b.1))
        });
        ids.into_iter().map(|(_, c)| c).collect()
    }

    pub fn resolve_session_fast(
        &mut self,
        cid: &str,
        now_override: Option<f64>,
    ) -> Option<SessionTelemetry> {
        let ref_now = now_override.unwrap_or_else(now_epoch_sec);
        let (fx_rate, _) = self.rates.get_fx_rate();
        let eff_ws = self.effective_daemon_workspace();
        let summaries = self.ledger.read_summaries();
        let target = cid.trim();

        let mut resolved_cid = String::new();
        let mut prefetched: Option<FileStamp> = None;

        if !target.is_empty() {
            if is_safe_id(target) {
                if let Some(st) = stat_db_stamp(&self.ledger.db_path(target)) {
                    resolved_cid = target.to_string();
                    prefetched = Some(st);
                }
            }
            if resolved_cid.is_empty() {
                let mut matches: Vec<(bool, f64, String, FileStamp)> = Vec::new();
                for (scid, srec) in summaries.iter() {
                    if is_safe_id(scid) && scid.starts_with(target) {
                        if let Some(st) = stat_db_stamp(&self.ledger.db_path(scid)) {
                            let is_act = !srec.killed
                                && (srec.status == "CASCADE_RUN_STATUS_RUNNING"
                                    || srec.not_fully_idle);
                            let ts = parse_iso_ts(&srec.last_modified_time).max(st.eff_mtime);
                            matches.push((is_act, ts, scid.clone(), st));
                        }
                    }
                }
                if !matches.is_empty() {
                    matches.sort_by(|a, b| {
                        b.0.cmp(&a.0)
                            .then_with(|| {
                                b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
                            })
                            .then_with(|| a.2.cmp(&b.2))
                    });
                    let (_, _, best_cid, best_st) = matches.remove(0);
                    resolved_cid = best_cid;
                    prefetched = Some(best_st);
                }
            }
            if resolved_cid.is_empty() {
                if let Ok(entries) = fs::read_dir(&self.ledger.conv_dir) {
                    for entry in entries.flatten() {
                        let fname = entry.file_name();
                        let Some(name) = fname.to_str() else { continue };
                        if let Some(cand) = name.strip_suffix(".db") {
                            if is_safe_id(cand) && cand.starts_with(target) {
                                if let Some(st) = stat_db_stamp(&entry.path()) {
                                    resolved_cid = cand.to_string();
                                    prefetched = Some(st);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        } else {
            if let Ok(env_cid) = env::var(CONVERSATION_ID_ENV) {
                let trimmed = env_cid.trim();
                if is_safe_id(trimmed) {
                    if let Some(st) = stat_db_stamp(&self.ledger.db_path(trimmed)) {
                        resolved_cid = trimmed.to_string();
                        prefetched = Some(st);
                    }
                }
            }

            if resolved_cid.is_empty() {
                let (file_mtimes, file_stamps) = self.ledger.scan_dir();
                // Candidate tuple: (strictly_running, eff_mtime, ts, cid)
                let mut ws_active: Vec<(bool, f64, f64, String)> = Vec::new();
                let mut ws_mains: Vec<(bool, f64, f64, String)> = Vec::new();
                let mut any_active: Vec<(bool, f64, f64, String)> = Vec::new();
                let mut any_mains: Vec<(bool, f64, f64, String)> = Vec::new();

                for (scid, mtime) in &file_mtimes {
                    let s = summaries.get(scid);
                    if s.is_some_and(|r| r.is_side_question) {
                        continue;
                    }
                    let is_sub = s.map(|r| r.is_subagent()).unwrap_or(false);
                    let strictly_running = s
                        .map(|r| !r.killed && r.status == "CASCADE_RUN_STATUS_RUNNING")
                        .unwrap_or(false);

                    // Parked/idle subagents never steal default resolution from main sessions,
                    // whereas an actively executing (`CASCADE_RUN_STATUS_RUNNING`) subagent CAN
                    // resolve when its DB was updated most recently (so a subagent omitting
                    // `conversation_id` receives `"subagent_handoff"` baton-pass guidance).
                    if is_sub && !strictly_running {
                        continue;
                    }

                    let s_ts = s
                        .map(|r| parse_iso_ts(&r.last_modified_time))
                        .unwrap_or(0.0);
                    let ts = s_ts.max(*mtime);
                    let is_act = if is_sub {
                        strictly_running
                    } else {
                        s.map(|r| {
                            !r.killed
                                && (r.status == "CASCADE_RUN_STATUS_RUNNING" || r.not_fully_idle)
                        })
                        .unwrap_or(false)
                    };

                    let in_ws = match (&eff_ws, s) {
                        (Some(ws), Some(r))
                            if !r.workspace.is_empty() || !r.workspaces.is_empty() =>
                        {
                            workspaces_overlap(&r.workspace, &r.workspaces, ws)
                        }
                        _ => false,
                    };

                    let item = (strictly_running, *mtime, ts, scid.clone());
                    if is_act {
                        if in_ws {
                            ws_active.push(item.clone());
                        }
                        any_active.push(item.clone());
                    }
                    if !is_sub {
                        if in_ws {
                            ws_mains.push(item.clone());
                        }
                        any_mains.push(item);
                    }
                }

                let pool = if !ws_active.is_empty() {
                    &mut ws_active
                } else if !ws_mains.is_empty() {
                    &mut ws_mains
                } else if !any_active.is_empty() {
                    &mut any_active
                } else {
                    &mut any_mains
                };

                if !pool.is_empty() {
                    pool.sort_by(|a, b| {
                        b.0.cmp(&a.0)
                            .then_with(|| {
                                b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
                            })
                            .then_with(|| {
                                b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)
                            })
                            .then_with(|| b.3.cmp(&a.3))
                    });
                    for (_, _, _, cand_cid) in pool.iter() {
                        let cand_st = file_stamps.get(cand_cid).cloned();
                        if summaries.get(cand_cid).is_none() {
                            let (_, probe) =
                                self.ledger.read_turns_and_probe(cand_cid, cand_st.as_ref());
                            if probe.is_side_question {
                                continue;
                            }
                        }
                        resolved_cid = cand_cid.clone();
                        prefetched = cand_st;
                        break;
                    }
                }
            }
        }

        if resolved_cid.is_empty() {
            return None;
        }

        let (turns, probe) = self
            .ledger
            .read_turns_and_probe(&resolved_cid, prefetched.as_ref());
        let summary = summaries.get(&resolved_cid);
        let mut tel = self.build_metrics_cached(
            &resolved_cid,
            summary,
            &turns,
            prefetched.as_ref(),
            fx_rate,
            ref_now,
            None,
            Some(&probe),
        );
        if !tel.is_subagent {
            let run_subs = self.get_running_subagent_count(&resolved_cid, Some(ref_now));
            tel.running_subagent_count = run_subs;
            tel.is_active = tel.is_active || run_subs > 0;
            if tel.is_active && tel.live_status == "ready" {
                tel.live_status = "running".to_string();
            }
        }
        Some(tel)
    }

    pub fn build_overview_snapshot(
        &mut self,
        limit: usize,
        show_history: bool,
        include_archived: bool,
        workspace_filter: &str,
        now_override: Option<f64>,
    ) -> OverviewSnapshot {
        #[cfg(test)]
        {
            self.overview_build_count += 1;
        }
        let t0 = Instant::now();
        let limit = limit.clamp(1, 60);
        let ref_now = now_override.unwrap_or_else(now_epoch_sec);
        let mut refresh_at = f64::INFINITY;
        let ws_filter = workspace_filter.trim().to_ascii_lowercase();
        let cfg = self.rates.current_settings();
        let lang = self.rates.get_lang();
        let (fx_rate, fx_source) = self.rates.get_fx_rate();
        let (currency_code, currency_sym) = self.rates.get_currency();
        let currency_explicit = self.rates.is_currency_explicit();
        let daemon_workspace = self.effective_daemon_workspace().unwrap_or_default();
        let summaries = self.ledger.read_summaries();
        let (file_mtimes, file_stamps) = self.ledger.scan_dir();

        let mut total_main_count = 0usize;
        let mut total_subagent_count = 0usize;
        let mut total_archived_count = 0usize;
        for cid in file_mtimes.keys() {
            let s = summaries.get(cid);
            if !ws_filter.is_empty() {
                let matched = s
                    .map(|r| r.matches_workspace_filter(&ws_filter))
                    .unwrap_or(false);
                if !matched {
                    continue;
                }
            }
            if s.is_some_and(|r| r.is_subagent()) {
                total_subagent_count += 1;
            } else if s.is_some_and(|r| r.archived) {
                total_archived_count += 1;
            } else {
                total_main_count += 1;
            }
        }

        let mut running_ids: HashSet<String> = HashSet::new();
        for (cid, s) in summaries.iter() {
            let Some(&mtime) = file_mtimes.get(cid) else {
                continue;
            };
            if s.is_side_question {
                if !s.killed && (ref_now - mtime).max(0.0) <= SIDE_QUESTION_RECENT_PROBE_SEC {
                    let stamp = file_stamps.get(cid);
                    match self.ledger.try_read_turns_and_probe(cid, stamp) {
                        Ok((turns, probe)) => {
                            let latest_step = turns.iter().map(|t| t.step_idx).max().unwrap_or(-1);
                            if is_side_question_active(
                                s.killed,
                                mtime,
                                ref_now,
                                Some(&probe),
                                latest_step,
                            ) {
                                running_ids.insert(cid.clone());
                                refresh_at = refresh_at.min(mtime + SIDE_QUESTION_RECENT_PROBE_SEC);
                            }
                        }
                        Err(_) => {
                            refresh_at = ref_now;
                        }
                    }
                }
            } else if s.is_subagent() {
                let eff_ts = parse_iso_ts(&s.last_modified_time).max(mtime);
                if is_subagent_active(
                    Some(s),
                    eff_ts,
                    ref_now,
                    cfg.context.subagent_silent_timeout_sec,
                ) {
                    running_ids.insert(cid.clone());
                    if let Some(deadline) =
                        subagent_idle_at(s, eff_ts, cfg.context.subagent_silent_timeout_sec)
                    {
                        refresh_at = refresh_at.min(deadline);
                    }
                }
            } else if !s.killed && (s.status == "CASCADE_RUN_STATUS_RUNNING" || s.not_fully_idle) {
                running_ids.insert(cid.clone());
            }
        }

        let mut priority_ids: HashSet<String> = running_ids.clone();
        for cid in &running_ids {
            if let Some(s) = summaries.get(cid) {
                if !s.parent_conversation_id.is_empty()
                    && file_mtimes.contains_key(&s.parent_conversation_id)
                {
                    priority_ids.insert(s.parent_conversation_id.clone());
                }
            }
        }

        let mut sorted_cids: Vec<String> = file_mtimes.keys().cloned().collect();
        sorted_cids.sort_by(|a, b| {
            let ma = file_mtimes.get(a).copied().unwrap_or(0.0);
            let mb = file_mtimes.get(b).copied().unwrap_or(0.0);
            mb.partial_cmp(&ma)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.cmp(b))
        });

        let mut candidate_order: Vec<String> = Vec::with_capacity(sorted_cids.len());
        let mut prio_sorted: Vec<String> = priority_ids.iter().cloned().collect();
        prio_sorted.sort();
        candidate_order.extend(prio_sorted);
        for c in sorted_cids {
            if !priority_ids.contains(&c) {
                candidate_order.push(c);
            }
        }

        let mut selected_mains: Vec<String> = Vec::new();
        let mut selected_unarchived_mains = 0usize;
        let mut selected_archived_mains = 0usize;
        let mut selected_subs: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for cid in candidate_order {
            if seen.contains(&cid) {
                continue;
            }
            let s = summaries.get(&cid);
            if !ws_filter.is_empty() {
                let matched = s
                    .map(|r| r.matches_workspace_filter(&ws_filter))
                    .unwrap_or(false);
                if !matched {
                    continue;
                }
            }
            let is_sub = s.map(|r| r.is_subagent()).unwrap_or(false);
            if is_sub {
                if !show_history && !running_ids.contains(&cid) {
                    continue;
                }
                if selected_subs.len() < limit * 3 || running_ids.contains(&cid) {
                    selected_subs.push(cid.clone());
                    seen.insert(cid);
                }
            } else {
                let is_arch = s.map(|r| r.archived).unwrap_or(false);
                if is_arch && !include_archived && !running_ids.contains(&cid) {
                    continue;
                }
                if is_arch {
                    if selected_archived_mains < limit || priority_ids.contains(&cid) {
                        selected_mains.push(cid.clone());
                        selected_archived_mains += 1;
                        seen.insert(cid);
                    }
                } else if selected_unarchived_mains < limit || priority_ids.contains(&cid) {
                    selected_mains.push(cid.clone());
                    selected_unarchived_mains += 1;
                    seen.insert(cid);
                }
            }
            let mains_done = if include_archived {
                selected_unarchived_mains >= limit && selected_archived_mains >= limit
            } else {
                selected_unarchived_mains >= limit
            };
            if mains_done && selected_subs.len() >= limit * 3 {
                break;
            }
        }

        for cid in selected_subs.clone() {
            if let Some(s) = summaries.get(&cid) {
                let pid = &s.parent_conversation_id;
                if !pid.is_empty() && file_mtimes.contains_key(pid) && !seen.contains(pid) {
                    let parent_arch = summaries.get(pid).map(|p| p.archived).unwrap_or(false);
                    if parent_arch && !include_archived && !running_ids.contains(&cid) {
                        continue;
                    }
                    selected_mains.push(pid.clone());
                    seen.insert(pid.clone());
                }
            }
        }

        let mut turns_by_cid: HashMap<String, (std::sync::Arc<Vec<TurnSample>>, LiveStepProbe)> =
            HashMap::new();
        let mut model_windows: Vec<ActiveModelWindow> = Vec::new();
        for cid in selected_mains.iter().chain(selected_subs.iter()) {
            let stamp = file_stamps.get(cid);
            let Ok((turns, probe)) = self.ledger.try_read_turns_and_probe(cid, stamp) else {
                refresh_at = ref_now;
                continue;
            };
            if turns.is_empty()
                && !running_ids.contains(cid)
                && probe.live_phase.is_empty()
                && probe.live_error.is_empty()
            {
                continue;
            }
            if let Some(w) = Self::make_model_window(
                cid,
                &turns,
                summaries.get(cid),
                stamp.map(|s| s.eff_mtime).unwrap_or(0.0),
                running_ids.contains(cid),
            ) {
                model_windows.push(w);
            }
            turns_by_cid.insert(cid.clone(), (turns, probe));
        }
        // Include any active conversations outside a workspace filter for global replica-pool/flagship contention accuracy.
        for cid in &running_ids {
            if turns_by_cid.contains_key(cid) {
                continue;
            }
            let stamp = file_stamps.get(cid);
            let Ok((turns, _)) = self.ledger.try_read_turns_and_probe(cid, stamp) else {
                refresh_at = ref_now;
                continue;
            };
            if let Some(w) = Self::make_model_window(
                cid,
                &turns,
                summaries.get(cid),
                stamp.map(|s| s.eff_mtime).unwrap_or(0.0),
                true,
            ) {
                model_windows.push(w);
            }
        }

        let active_carbon_count = model_windows
            .iter()
            .filter(|w| w.is_active && w.is_carbon)
            .count();
        let carbon_concurrency_warning = active_carbon_count >= 3;
        let carbon_concurrency_note = if carbon_concurrency_warning {
            Some(carbon_concurrency_warning_text(lang, active_carbon_count))
        } else {
            None
        };

        let mut metrics_by_id: HashMap<String, SessionTelemetry> = HashMap::new();
        for cid in selected_mains.iter().chain(selected_subs.iter()) {
            let Some((turns, probe)) = turns_by_cid.get(cid) else {
                continue;
            };
            let stamp = file_stamps.get(cid);
            let summary = summaries.get(cid);
            let overlaps = compute_overlap_counts(cid, turns, &model_windows);
            let tel = self.build_metrics_cached(
                cid,
                summary,
                turns,
                stamp,
                fx_rate,
                ref_now,
                Some(&overlaps),
                Some(probe),
            );
            if !tel.live_phase.is_empty() && probe.live_started_ts > 0.0 {
                // The displayed elapsed value changes at 5-second, then 10-second boundaries.
                let bucket_width = if tel.live_elapsed_sec < 60 { 5 } else { 10 };
                let next_bucket = tel.live_elapsed_sec + bucket_width;
                refresh_at = refresh_at.min(probe.live_started_ts + next_bucket as f64);
            }
            if tel.is_subagent && tel.is_active {
                if let Some(deadline) = summary.and_then(|s| {
                    subagent_idle_at(
                        s,
                        tel.last_active_ts,
                        cfg.context.subagent_silent_timeout_sec,
                    )
                }) {
                    // The serialized last activity time is rounded to milliseconds.
                    refresh_at = refresh_at.min(deadline - 0.001);
                }
            }
            metrics_by_id.insert(cid.clone(), tel);
        }

        let mut children_map: HashMap<String, Vec<SessionTelemetry>> = HashMap::new();
        let mut orphans: Vec<SessionTelemetry> = Vec::new();
        let mut discovered_subs: Vec<String> = Vec::new();
        for cid in &selected_mains {
            if metrics_by_id.get(cid).is_some_and(|m| m.is_subagent) {
                discovered_subs.push(cid.clone());
                if !summaries.get(cid).is_some_and(|s| s.is_subagent()) {
                    total_subagent_count += 1;
                    total_main_count = total_main_count.saturating_sub(1);
                }
            }
        }
        // Adjust totals for empty-turn DBs that were skipped when reading selected_mains/subs.
        for cid in selected_mains.iter().chain(selected_subs.iter()) {
            if !metrics_by_id.contains_key(cid) {
                let s = summaries.get(cid);
                if s.is_some_and(|r| r.is_subagent()) {
                    total_subagent_count = total_subagent_count.saturating_sub(1);
                } else if s.is_some_and(|r| r.archived) {
                    total_archived_count = total_archived_count.saturating_sub(1);
                } else {
                    total_main_count = total_main_count.saturating_sub(1);
                }
            }
        }
        for cid in selected_subs.iter().chain(discovered_subs.iter()) {
            let Some(m) = metrics_by_id.get(cid).cloned() else {
                continue;
            };
            if !show_history && !m.is_active {
                continue;
            }
            let attach_parent = !m.parent_id.is_empty()
                && metrics_by_id
                    .get(&m.parent_id)
                    .map(|p| !p.is_subagent)
                    .unwrap_or(false);
            if attach_parent {
                children_map.entry(m.parent_id.clone()).or_default().push(m);
            } else if m.is_active || show_history {
                orphans.push(m);
            }
        }

        let mut sessions: Vec<SessionTelemetry> = Vec::new();
        for cid in &selected_mains {
            let Some(mut m) = metrics_by_id.get(cid).cloned() else {
                continue;
            };
            if m.is_subagent {
                continue;
            }
            let mut subs = children_map.remove(cid).unwrap_or_default();
            subs.sort_by(|a, b| {
                b.is_active
                    .cmp(&a.is_active)
                    .then_with(|| {
                        b.sidebar_sort_ts
                            .partial_cmp(&a.sidebar_sort_ts)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .then_with(|| a.id.cmp(&b.id))
            });
            let run_subs = subs.iter().filter(|x| x.is_active).count();
            let hist_subs = subs.len() - run_subs;
            let eff_ts = subs
                .iter()
                .map(|x| x.last_active_ts)
                .fold(m.last_active_ts, f64::max);
            let sort_ts = m.summary_modified_ts.max(eff_ts);
            let group_usd = m.cost_usd + subs.iter().map(|x| x.cost_usd).sum::<f64>();
            let group_cny = m.cost_cny + subs.iter().map(|x| x.cost_cny).sum::<f64>();

            m.running_subagent_count = run_subs;
            m.history_subagent_count = hist_subs;
            m.is_active = m.is_active || run_subs > 0;
            if m.is_active && m.live_status == "ready" {
                m.live_status = "running".to_string();
            }
            m.effective_last_active_ts = Some(round_dp(eff_ts, 3));
            m.sidebar_sort_ts = round_dp(sort_ts, 3);
            m.group_cost_usd = Some(round_dp(group_usd, 4));
            m.group_cost_cny = Some(round_dp(group_cny, 2));
            m.subagents = subs;
            sessions.push(m);
        }

        // Prefer sessions belonging to this daemon's active workspace at the top when pinned is equal
        sessions.sort_by(|a, b| {
            let a_ws = !daemon_workspace.is_empty()
                && workspaces_overlap(&a.workspace, &a.workspaces, &daemon_workspace);
            let b_ws = !daemon_workspace.is_empty()
                && workspaces_overlap(&b.workspace, &b.workspaces, &daemon_workspace);
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| (b.is_active && b_ws).cmp(&(a.is_active && a_ws)))
                .then_with(|| {
                    b.sidebar_sort_ts
                        .partial_cmp(&a.sidebar_sort_ts)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| a.id.cmp(&b.id))
        });
        orphans.sort_by(|a, b| {
            b.last_active_ts
                .partial_cmp(&a.last_active_ts)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });

        let shown_subagent_count: usize =
            sessions.iter().map(|s| s.subagents.len()).sum::<usize>() + orphans.len();
        let shown_archived_count = sessions.iter().filter(|s| s.archived).count();
        let shown_unarchived_main_count = sessions.len().saturating_sub(shown_archived_count);
        let total_main_count = total_main_count.max(shown_unarchived_main_count);
        let total_subagent_count = total_subagent_count.max(shown_subagent_count);
        let total_archived_count = total_archived_count.max(shown_archived_count);
        let archived_hidden_count = total_archived_count.saturating_sub(shown_archived_count);
        let history_subagents_hidden_count =
            total_subagent_count.saturating_sub(shown_subagent_count);
        let running_main_count = sessions.iter().filter(|s| s.is_active).count();
        let mut running_subagent_count = 0usize;
        let mut compact_needed_count = 0usize;
        let mut critical_count = 0usize;
        let mut compacting_count = 0usize;
        let mut error_session_count = 0usize;
        let mut total_cost_usd = 0.0f64;
        let mut total_cost_cny = 0.0f64;

        let mut accum = |item: &SessionTelemetry| {
            if item.is_subagent && item.is_active {
                running_subagent_count += 1;
            }
            if item.suggest_compact {
                compact_needed_count += 1;
            }
            if item.level == "critical" {
                critical_count += 1;
            }
            if item.live_phase == "compacting" {
                compacting_count += 1;
            }
            if item.live_status == "error" {
                error_session_count += 1;
            }
            total_cost_usd += item.cost_usd;
            total_cost_cny += item.cost_cny;
        };
        for s in &sessions {
            accum(s);
            for sub in &s.subagents {
                accum(sub);
            }
        }
        for o in &orphans {
            accum(o);
        }

        let mut snap = OverviewSnapshot {
            mode: "snapshot".to_string(),
            unchanged: false,
            stale: false,
            digest: String::new(),
            server_ms: t0.elapsed().as_millis() as u64,
            generated_at: format_utc_iso(now_epoch_sec()),
            generated_ts: round_dp(ref_now, 3),
            refresh_at,
            lang: lang.as_str().to_string(),
            fx_rate: round_dp(fx_rate, 4),
            fx_source,
            currency_code,
            currency_symbol: currency_sym,
            currency_explicit,
            daemon_workspace,
            show_history_subagents: show_history,
            thresholds: SnapshotThresholds {
                warn: cfg.context.warn_threshold,
                compact: cfg.context.compact_threshold,
                critical: cfg.context.critical_threshold,
                max: cfg.context.default_limit,
            },
            summary: SnapshotSummary {
                total_db_files: file_mtimes.len(),
                total_main_count,
                total_subagent_count,
                total_archived_count,
                archived_hidden_count,
                history_subagents_hidden_count,
                shown_main_count: sessions.len(),
                shown_subagent_count,
                running_main_count,
                running_subagent_count,
                active_carbon_count,
                carbon_concurrency_warning,
                compact_needed_count,
                critical_count,
                compacting_count,
                error_session_count,
                total_cost_usd: round_dp(total_cost_usd, 4),
                total_cost_cny: round_dp(total_cost_cny, 2),
            },
            active_carbon_count,
            carbon_concurrency_warning,
            carbon_concurrency_note,
            sessions,
            orphan_subagents: orphans,
            settings: None,
            ui_settings: None,
            settings_path: None,
            settings_error: cfg.settings_error.clone(),
            pending_grant: None,
        };
        snap.digest = compute_snapshot_digest(&snap);
        snap
    }

    pub fn get_session_turns(&mut self, cid: &str, limit: usize) -> SessionTurnsPayload {
        let lang = self.rates.get_lang();
        let zh = lang.is_zh();
        let trimmed = cid.trim();
        let resolved = if trimmed.is_empty() {
            match self.resolve_session_fast("", None) {
                Some(s) => s.id,
                None => {
                    return SessionTurnsPayload {
                        mode: "turns".into(),
                        error: Some(if zh {
                            "未找到目标会话".into()
                        } else {
                            "Target session not found".into()
                        }),
                        conversation_id: String::new(),
                        session: None,
                        total_turns: 0,
                        cold_cache_breakdown: None,
                        mid_loop_breakdown: None,
                        turns: Vec::new(),
                    };
                }
            }
        } else {
            trimmed.to_string()
        };

        if !is_safe_id(&resolved) {
            return SessionTurnsPayload {
                mode: "turns".into(),
                error: Some(if zh {
                    "无效的会话 ID".into()
                } else {
                    "Invalid conversation ID".into()
                }),
                conversation_id: resolved,
                session: None,
                total_turns: 0,
                cold_cache_breakdown: None,
                mid_loop_breakdown: None,
                turns: Vec::new(),
            };
        }

        let limit = limit.clamp(1, 200);
        let ref_now = now_epoch_sec();
        let cfg = self.rates.current_settings();
        let (fx_rate, _) = self.rates.get_fx_rate();
        let summaries = self.ledger.read_summaries();
        let (file_mtimes, file_stamps) = self.ledger.scan_dir();
        let stamp = stat_db_stamp(&self.ledger.db_path(&resolved));
        let (turns, probe) = self.ledger.read_turns_and_probe(&resolved, stamp.as_ref());
        let mut model_windows: Vec<ActiveModelWindow> = Vec::new();
        for (cid, s) in summaries.iter() {
            let Some(&mtime) = file_mtimes.get(cid) else {
                continue;
            };
            let is_act = if s.is_side_question {
                if !s.killed && (ref_now - mtime).max(0.0) <= SIDE_QUESTION_RECENT_PROBE_SEC {
                    let (ct, p) = self.ledger.read_turns_and_probe(cid, file_stamps.get(cid));
                    let latest_step = ct.iter().map(|t| t.step_idx).max().unwrap_or(-1);
                    is_side_question_active(s.killed, mtime, ref_now, Some(&p), latest_step)
                } else {
                    false
                }
            } else if s.is_subagent() {
                let eff_ts = parse_iso_ts(&s.last_modified_time).max(mtime);
                is_subagent_active(
                    Some(s),
                    eff_ts,
                    ref_now,
                    cfg.context.subagent_silent_timeout_sec,
                )
            } else {
                !s.killed && (s.status == "CASCADE_RUN_STATUS_RUNNING" || s.not_fully_idle)
            };
            if is_act || cid == &resolved {
                let st = file_stamps.get(cid);
                let c_turns = if cid == &resolved {
                    turns.clone()
                } else {
                    self.ledger.read_turns(cid, st)
                };
                if let Some(w) = Self::make_model_window(
                    cid,
                    &c_turns,
                    Some(s),
                    st.map(|x| x.eff_mtime).unwrap_or(mtime),
                    is_act,
                ) {
                    model_windows.push(w);
                }
            }
        }
        let overlaps = compute_overlap_counts(&resolved, &turns, &model_windows);
        let t_types = self.transcript_types_if_needed(&resolved, &turns);
        let session = self.build_metrics_cached(
            &resolved,
            summaries.get(&resolved),
            &turns,
            stamp.as_ref(),
            fx_rate,
            ref_now,
            Some(&overlaps),
            Some(&probe),
        );
        let rows = format_turn_rows_with_overlap(
            &turns,
            limit,
            fx_rate,
            &mut self.rates,
            t_types.as_ref(),
            Some(&overlaps),
        );
        let cb = session.cold_cache_breakdown.clone();
        let mb = session.mid_loop_breakdown.clone();
        SessionTurnsPayload {
            mode: "turns".into(),
            error: None,
            conversation_id: resolved,
            session: Some(session),
            total_turns: turns.len(),
            cold_cache_breakdown: Some(cb),
            mid_loop_breakdown: Some(mb),
            turns: rows,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_turn(
        turn_index: usize,
        step_idx: i64,
        ts: f64,
        in_tok: u64,
        cr_tok: u64,
        out_tok: u64,
        is_checkpoint: bool,
    ) -> TurnSample {
        TurnSample {
            turn_index,
            step_idx,
            timestamp: ts,
            model: "gemini-4-neon-high".into(),
            model_display: "Gemini 4 Standard (High)".into(),
            input_tokens: in_tok,
            cache_read: cr_tok,
            cache_write: 0,
            output_tokens: out_tok,
            thinking_tokens: out_tok / 2,
            response_tokens: out_tok - (out_tok / 2),
            ttft_ms: if out_tok > 0 { 900 } else { 0 },
            total_ms: if out_tok > 0 { 3_000 } else { 0 },
            response_id: format!("r{turn_index}"),
            step_type: if is_checkpoint { 23 } else { 15 },
            is_checkpoint,
            after_turn_start: None,
            after_checkpoint: false,
        }
    }

    #[test]
    fn telemetry_handles_zero_post_checkpoint_turns_and_trailing_partial_turn() {
        let mut rates = RateTable::new(SettingsWatcher::new(Some("none".into())), None, None);
        let cid = "80000000-0000-0000-0000-000000000801";

        // 1. Explicit checkpoint TurnSample at EOF -> 0 post-checkpoint turns and 0 last_loop_steps
        let ckpt_turns = vec![
            sample_turn(1, 10, 1_000.0, 20_000, 350_000, 1_200, false),
            sample_turn(2, 11, 1_010.0, 5_000, 370_000, 4_000, true),
        ];
        let tel_ckpt = build_session_telemetry(
            cid,
            None,
            &ckpt_turns,
            1_010.0,
            7.2,
            &mut rates,
            1_020.0,
            None,
        );
        assert!(tel_ckpt.just_compacted);
        assert_eq!(tel_ckpt.turns_since_compact, 0);
        assert_eq!(tel_ckpt.last_loop_steps, 0);
        assert_eq!(tel_ckpt.last_loop_output_tokens, 0);
        assert!(!tel_ckpt.recent_cold_rebuild);

        // 2. Transcript ends immediately after CHECKPOINT with 0 post-checkpoint turns in `turns`
        let pre_turns = vec![sample_turn(1, 10, 1_000.0, 30_000, 360_000, 800, false)];
        let mut tmap = HashMap::new();
        tmap.insert(9, "USER_INPUT".to_string());
        tmap.insert(10, "PLANNER_RESPONSE".to_string());
        tmap.insert(11, "CHECKPOINT".to_string());

        let probe = LiveStepProbe {
            compact_summary_bytes: 16_000,
            ..LiveStepProbe::default()
        };
        let tel_tckpt = build_session_telemetry_with_probe(
            cid,
            None,
            &pre_turns,
            1_015.0,
            7.2,
            &mut rates,
            1_020.0,
            Some(&tmap),
            None,
            Some(&probe),
        );
        assert!(tel_tckpt.just_compacted);
        assert_eq!(tel_tckpt.checkpoint_count, 1);
        assert_eq!(tel_tckpt.turns_since_compact, 0);
        assert_eq!(tel_tckpt.pre_compact_tokens, 390_000);
        assert!(tel_tckpt.latest_context_tokens < 40_000);
        assert_eq!(tel_tckpt.level, "ok");
        assert!(!tel_tckpt.suggest_compact);
        assert_eq!(tel_tckpt.last_loop_steps, 0);

        // Empty `turns` with trailing transcript CHECKPOINT must not panic
        let tel_empty = build_session_telemetry_with_probe(
            cid,
            None,
            &[],
            1_015.0,
            7.2,
            &mut rates,
            1_020.0,
            Some(&tmap),
            None,
            Some(&probe),
        );
        assert!(tel_empty.just_compacted);
        assert_eq!(tel_empty.turns_since_compact, 0);

        // 3. Trailing partial/empty turn at EOF + lagging transcript_step_types
        let mut partial_eof = sample_turn(2, 15, 1_600.0, 0, 0, 0, false);
        partial_eof.ttft_ms = 0;
        partial_eof.total_ms = 0;
        let turns_with_partial = vec![
            sample_turn(1, 10, 1_000.0, 20_000, 80_000, 600, false),
            partial_eof,
        ];
        let tel_partial = build_session_telemetry(
            cid,
            None,
            &turns_with_partial,
            1_600.0,
            7.2,
            &mut rates,
            1_605.0,
            None,
        );
        assert_eq!(tel_partial.latest_context_tokens, 100_000);
        assert!((tel_partial.latest_cache_hit_rate - 80.0).abs() < 0.1);
        assert_eq!(tel_partial.latest_ttft_ms, 900);
        assert!(tel_partial.latest_stream_tps > 0.0);

        // Lagging transcript_step_types (only covers up to step 10, while turn 2 at step 15 ran 600s later)
        // must fall back to TTL TurnStart rather than falsely assuming MidLoop!
        let mut lagging_tmap = HashMap::new();
        lagging_tmap.insert(9, "USER_INPUT".to_string());
        lagging_tmap.insert(10, "PLANNER_RESPONSE".to_string());
        let turns_after_ttl = vec![
            sample_turn(1, 10, 1_000.0, 40_000, 0, 500, false),
            sample_turn(2, 15, 1_600.0, 50_000, 0, 500, false),
        ];
        let classified =
            classify_cold_cache_turns_detailed(&turns_after_ttl, Some(&lagging_tmap), None);
        assert_eq!(classified[1].kind, ColdCacheKind::TurnStart);
    }
}
