//! MCP tool/resource specifications (clean English schemas) and bilingual model-facing text formatters.

use serde_json::{json, Value};

use crate::engine::telemetry::{OverviewSnapshot, SessionTelemetry};
use crate::i18n::select_display_cost;

pub const PANEL_URI: &str = "ui://context-radar-mcp/panel";
pub const HANDOFF_URI: &str = "ui://context-radar-mcp/handoff";
pub const APP_MIME: &str = "text/html;profile=mcp-app";

pub fn fmt_k(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.2}M", (tokens as f64) / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}k", (tokens as f64) / 1_000.0)
    } else {
        tokens.to_string()
    }
}

pub fn tools_spec() -> Value {
    json!([
        {
            "name": "context_radar_overview",
            "title": "Context Radar",
            "description": "Open the live Context Radar dashboard and return active session and subagent context telemetry, KV cache hit rates, cold-cache attribution, latency, and estimated cost (supports if_digest deduplication).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "snapshot",
                            "turns"
                        ],
                        "description": "'snapshot' (default) returns the session overview; 'turns' returns per-turn breakdown for conversation_id."
                    },
                    "if_digest": {
                        "type": "string",
                        "maxLength": 64,
                        "description": "Digest from the previous snapshot; returns { unchanged: true } when state has not changed."
                    },
                    "if_hash": {
                        "type": "string",
                        "maxLength": 64,
                        "description": "Compatibility alias for if_digest."
                    },
                    "fresh": {
                        "type": "boolean",
                        "description": "Force a synchronous incremental refresh bypassing the short burst cache (default: false)."
                    },
                    "conversation_id": {
                        "type": "string",
                        "description": "Target conversation ID (used when action='turns', or to bind panel ownership)."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of main sessions or turns to return (default: 25, range: 1-200).",
                        "minimum": 1,
                        "maximum": 200
                    },
                    "show_history": {
                        "type": "boolean",
                        "description": "Include completed or idle historical subagents (default: false, active subagents only)."
                    },
                    "include_archived": {
                        "type": "boolean",
                        "description": "Include archived conversations (default: false)."
                    },
                    "workspace_filter": {
                        "type": "string",
                        "description": "Optional substring filter matched against all workspace roots of a conversation."
                    }
                },
                "additionalProperties": false
            },
            "_meta": {
                "ui": { "resourceUri": PANEL_URI },
                "com.google.antigravity/ui": {
                    "entrypoints": [
                        { "type": "aux_pane", "title": "Context Radar" },
                        { "type": "global", "title": "Context Radar" }
                    ]
                }
            }
        },
        {
            "name": "context_radar_ui_action",
            "title": "Context Radar Internal UI Action",
            "description": "Internal app-only state, distillation, and scoped relay grant actions invoked by the Context Radar MCP App panel.",
            "inputSchema": {
                "type": "object",
                "required": ["action"],
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "set_prefs",
                            "claim_grant",
                            "record_relay",
                            "record_compact",
                            "dismiss_grant",
                            "distill_slice",
                            "create_handoff"
                        ],
                        "description": "UI action to perform: persist preferences, claim/dismiss/record a scoped relay grant, distill a slice to scratch/, or prepare a handoff grant."
                    },
                    "allow_auto_handoff": {
                        "type": "boolean",
                        "description": "When action='set_prefs', enable or pause automatic target:new handoff launches."
                    },
                    "lang": {
                        "type": "string",
                        "enum": ["auto", "en", "zh-CN"],
                        "description": "When action='set_prefs', persist panel display language preference."
                    },
                    "currency_code": {
                        "type": "string",
                        "enum": ["auto", "USD", "CNY"],
                        "description": "When action='set_prefs', persist preferred display currency ('auto', 'USD', or 'CNY')."
                    },
                    "fx_rate": {
                        "type": "number",
                        "minimum": 0.01,
                        "maximum": 1000,
                        "description": "When action='set_prefs', persist USD-to-CNY exchange rate."
                    },
                    "poll_interval_sec": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 300,
                        "description": "When action='set_prefs', foreground refresh interval in seconds (0 = adaptive auto)."
                    },
                    "bg_poll_interval_sec": {
                        "type": "integer",
                        "minimum": -1,
                        "maximum": 3600,
                        "description": "When action='set_prefs', background refresh interval in seconds (0 = adaptive auto, -1 = paused)."
                    },
                    "compact_threshold": {
                        "type": "integer",
                        "minimum": 10000,
                        "maximum": 2000000,
                        "description": "When action='set_prefs', token threshold for suggesting /compact."
                    },
                    "theme": {
                        "type": "string",
                        "enum": ["system", "light", "dark"],
                        "description": "When action='set_prefs', persist panel color theme preference ('system', 'light', or 'dark')."
                    },
                    "last_host_theme": {
                        "type": "string",
                        "enum": ["light", "dark"],
                        "description": "When action='set_prefs', persist last resolved Antigravity host theme ('light' or 'dark') for Byte-0 SSR."
                    },
                    "grant_id": {
                        "type": "string",
                        "description": "Single-use relay grant ID."
                    },
                    "conversation_id": {
                        "type": "string",
                        "description": "Target or expected source conversation ID."
                    },
                    "workspace": {
                        "type": "string",
                        "description": "Expected source workspace path for cross-project relay protection."
                    },
                    "claim_mode": {
                        "type": "string",
                        "enum": [
                            "auto_handoff",
                            "manual_handoff",
                            "auto_compact",
                            "manual_compact",
                            "acp_auto_compact",
                            "manual"
                        ],
                        "description": "Grant claim verification mode."
                    },
                    "handoff_conversation_id": {
                        "type": "string",
                        "description": "New conversationId returned by official target:new when action='record_relay'."
                    },
                    "status": {
                        "type": "string",
                        "description": "Compaction dispatch status when action='record_compact' (e.g. 'sent', 'acp_compacted', 'fallback_copied')."
                    },
                    "start_step": {
                        "type": "integer",
                        "description": "Optional start step_index when action='distill_slice'."
                    },
                    "end_step": {
                        "type": "integer",
                        "description": "Optional end step_index when action='distill_slice'."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["handoff", "compact"],
                        "description": "Grant kind when action='create_handoff'."
                    },
                    "preserve_points": {
                        "type": "string",
                        "description": "Optional preservation notes when action='create_handoff'."
                    },
                    "resume_task": {
                        "type": "string",
                        "description": "Optional next task when action='create_handoff'."
                    },
                    "scratch_note_path": {
                        "type": "string",
                        "description": "Optional distilled scratch/ slice path when action='create_handoff'."
                    },
                    "estimated_remaining_turns": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "description": "Estimated remaining turns when action='create_handoff'."
                    },
                    "auto_fire": {
                        "type": "boolean",
                        "description": "Whether the UI should auto-launch target:new when action='create_handoff'."
                    }
                },
                "additionalProperties": false
            },
            "_meta": {
                "ui": { "visibility": ["app"] }
            }
        },
        {
            "name": "context_radar_turns",
            "title": "Per-Turn Context & Cache Breakdown",
            "description": "Inspect per-turn context size, KV cache hit rate, cold-cache attribution (new-turn miss, mid-turn break / partial prefix drop, post-compact rebuild), TTFT, streaming throughput, and turn cost.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "conversation_id": {
                        "type": "string",
                        "description": "Target conversation ID (defaults to the active session in the current workspace)."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of recent turns to return (default: 30, range: 1-200).",
                        "minimum": 1,
                        "maximum": 200
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "context_radar_hotspots",
            "title": "Context Bloat Hotspots & Out-of-Band Slice Distillation",
            "description": "Locate turns that caused the largest context jumps since the last checkpoint, or distill a historical step slice out-of-band into a <600-token summary in scratch/ (for fresh subagents or target:new handoffs) without mutating the active session's KV cache prefix.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "conversation_id": {
                        "type": "string",
                        "description": "Target conversation ID (defaults to the active session in the current workspace)."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["hotspots", "distill"],
                        "description": "'hotspots' (default) locates top context-growth turns; 'distill' summarizes a step range."
                    },
                    "start_step": {
                        "type": "integer",
                        "description": "Start step_index for mode='distill' (defaults to first step after the latest checkpoint)."
                    },
                    "end_step": {
                        "type": "integer",
                        "description": "End step_index for mode='distill' (defaults to the midpoint of active history)."
                    },
                    "save_note": {
                        "type": "boolean",
                        "description": "Write the distilled summary to brain/<id>/scratch/slice_<start>_<end>.md (default: false)."
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Maximum hotspots returned when mode='hotspots' (default: 8, range: 1-15).",
                        "minimum": 1,
                        "maximum": 15
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "radar_prepare_handoff",
            "title": "Evaluate Compaction & Handoff Budget",
            "description": "Evaluate model x reasoning-effort budget tiers, checkpoint cooldown, recent cold-rebuild protection, zero running subagents, and economic / token-physics break-even turns before compacting or starting a new conversation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "conversation_id": {
                        "type": "string",
                        "description": "Target conversation ID (defaults to the active session or running subagent in the current workspace)."
                    },
                    "estimated_remaining_turns": {
                        "type": "integer",
                        "description": "Estimated remaining turns for the task (default: 12).",
                        "minimum": 1,
                        "maximum": 500
                    },
                    "upcoming_noisy_tokens": {
                        "type": "integer",
                        "description": "Estimated upcoming noisy exploratory tokens (default: 0).",
                        "minimum": 0,
                        "maximum": 2000000
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "radar_commit_handoff",
            "title": "Commit /compact Command & Scoped target:new Handoff Grant",
            "description": "Verify server-side hard gates (model tier floor, cooldown, cold-rebuild amortization, break-even turns, and zero running subagents) and issue a workspace- and conversation-scoped single-use handoff grant with a ready-to-copy /compact command and official target:new prompt.",
            "inputSchema": {
                "type": "object",
                "required": ["preserve_points"],
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["handoff", "compact"],
                        "description": "Grant kind (default: 'handoff')."
                    },
                    "conversation_id": {
                        "type": "string",
                        "description": "Source conversation ID (required if multiple main chats are simultaneously running in the same workspace)."
                    },
                    "preserve_points": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Key findings, modified file paths, and constraints that must be preserved across compaction or handoff."
                    },
                    "resume_task": {
                        "type": "string",
                        "description": "Next task to execute immediately after compaction or handoff (omit to pause and await instructions)."
                    },
                    "scratch_note_path": {
                        "type": "string",
                        "description": "Optional scratch/ slice summary path created via context_radar_hotspots(save_note=true)."
                    },
                    "estimated_remaining_turns": {
                        "type": "integer",
                        "description": "Estimated remaining turns used for break-even verification (default: 12).",
                        "minimum": 1,
                        "maximum": 500
                    },
                    "auto_fire": {
                        "type": "boolean",
                        "description": "Automatically launch target:new when an inline card or matching workspace side pane is mounted and visible (default: true; pass false during interactive Q&A to keep the current window)."
                    }
                },
                "additionalProperties": false
            },
            "_meta": {
                "ui": { "resourceUri": HANDOFF_URI }
            }
        }
    ])
}

pub fn resources_spec() -> Value {
    json!([
        {
            "uri": PANEL_URI,
            "name": "Context Radar",
            "title": "Context Radar",
            "description": "Live Antigravity context gauge, KV cache attribution, hotspot distillation, and scoped handoff dashboard.",
            "mimeType": APP_MIME,
            "_meta": { "ui": { "prefersBorder": false } }
        },
        {
            "uri": HANDOFF_URI,
            "name": "Context Radar Handoff Card",
            "title": "Context Radar Handoff",
            "description": "Inline card providing a 1-click /compact command and scoped official target:new session handoff.",
            "mimeType": APP_MIME,
            "_meta": { "ui": { "prefersBorder": false } }
        }
    ])
}

fn truncate_inline(s: &str, max_chars: usize) -> String {
    let mut count = 0usize;
    let mut cut_byte: Option<usize> = None;
    for (bidx, _) in s.char_indices() {
        if count == max_chars.saturating_sub(1) {
            cut_byte = Some(bidx);
        }
        count += 1;
        if count > max_chars {
            break;
        }
    }
    if count > max_chars {
        if let Some(b) = cut_byte {
            return format!("{}…", s[..b].trim_end());
        }
    }
    s.to_string()
}

/// Shared compact duration formatter (handles days cleanly, never overflows 32-bit ints).
/// EN: `45s`, `7m`, `2h 5m`, `3d 4h` · ZH: `45 秒`, `7 分钟`, `2 小时 5 分`, `3 天 4 小时`.
pub fn format_duration_compact(total_sec: u64, zh: bool) -> String {
    if total_sec < 60 {
        return if zh {
            format!("{total_sec} 秒")
        } else {
            format!("{total_sec}s")
        };
    }
    let total_min = total_sec / 60;
    if total_min < 60 {
        return if zh {
            format!("{total_min} 分钟")
        } else {
            format!("{total_min}m")
        };
    }
    let total_hr = total_min / 60;
    let rem_min = total_min % 60;
    if total_hr < 24 {
        return if rem_min > 0 {
            if zh {
                format!("{total_hr} 小时 {rem_min} 分")
            } else {
                format!("{total_hr}h {rem_min}m")
            }
        } else if zh {
            format!("{total_hr} 小时")
        } else {
            format!("{total_hr}h")
        };
    }
    let days = total_hr / 24;
    let rem_hr = total_hr % 24;
    if rem_hr > 0 {
        if zh {
            format!("{days} 天 {rem_hr} 小时")
        } else {
            format!("{days}d {rem_hr}h")
        }
    } else if zh {
        format!("{days} 天")
    } else {
        format!("{days}d")
    }
}

pub fn format_live_status_tag(item: &SessionTelemetry, zh: bool) -> String {
    if item.live_status == "error" {
        if item.live_error.is_empty() {
            return if zh { " [出错]" } else { " [error]" }.to_string();
        }
        let short_err = truncate_inline(&item.live_error, 48);
        return if zh {
            format!(" [出错：{short_err}]")
        } else {
            format!(" [error: {short_err}]")
        };
    }
    if item.live_phase == "compacting" {
        let elapsed = if item.live_elapsed_sec > 0 {
            format!(" {}", format_duration_compact(item.live_elapsed_sec, zh))
        } else {
            String::new()
        };
        let xmod = if item.cross_model_compact {
            if zh {
                " · 换模型"
            } else {
                " · new model"
            }
        } else {
            ""
        };
        return if zh {
            format!(" [压缩中{elapsed}{xmod}]")
        } else {
            format!(" [compacting{elapsed}{xmod}]")
        };
    }
    if item.live_status == "waiting" {
        return if item.live_elapsed_sec > 0 {
            let dur = format_duration_compact(item.live_elapsed_sec, zh);
            if zh {
                format!(" [等待中 {dur}]")
            } else {
                format!(" [waiting {dur}]")
            }
        } else if zh {
            " [等待中]".to_string()
        } else {
            " [waiting]".to_string()
        };
    }
    if item.is_active {
        return if item.is_subagent {
            if zh {
                " [运行中]"
            } else {
                " [running]"
            }
        } else if zh {
            " [进行中]"
        } else {
            " [active]"
        }
        .to_string();
    }
    if item.is_subagent {
        return if zh { " [历史]" } else { " [history]" }.to_string();
    }
    String::new()
}

pub fn summarize_snapshot_text(snap: &OverviewSnapshot) -> String {
    let zh = snap.lang == "zh-CN";
    let s = &snap.summary;
    let ccode = if snap.currency_code.is_empty() {
        if zh {
            "CNY"
        } else {
            "USD"
        }
    } else {
        snap.currency_code.as_str()
    };
    let sym = if snap.currency_symbol.is_empty() {
        if zh {
            "¥"
        } else {
            "$"
        }
    } else {
        snap.currency_symbol.as_str()
    };
    let total_disp = select_display_cost(s.total_cost_usd, s.total_cost_cny, ccode);

    let mut live_counts = String::new();
    if s.compacting_count > 0 {
        live_counts.push_str(&if zh {
            format!("，压缩中 {} 个", s.compacting_count)
        } else {
            format!(", {} compacting", s.compacting_count)
        });
    }
    if s.error_session_count > 0 {
        live_counts.push_str(&if zh {
            format!("，出错 {} 个", s.error_session_count)
        } else {
            format!(", {} error", s.error_session_count)
        });
    }

    let mut lines = vec![if zh {
        format!(
            "Context Radar 快照（上限 {}）：主会话 {} 个（进行中 {}，已隐藏归档 {}），活跃子代理 {} 个（已隐藏历史子代理 {}），待压缩 {} 个{live_counts}，合计约 {}{:.2}。",
            fmt_k(snap.thresholds.max),
            s.shown_main_count,
            s.running_main_count,
            s.archived_hidden_count,
            s.running_subagent_count,
            s.history_subagents_hidden_count,
            s.compact_needed_count,
            sym,
            total_disp
        )
    } else {
        format!(
            "Context Radar Snapshot (limit {}): {} main session(s) ({} active, {} archived hidden), {} active subagent(s) ({} historical hidden), {} ready for /compact{live_counts}, est. total {}{:.2}.",
            fmt_k(snap.thresholds.max),
            s.shown_main_count,
            s.running_main_count,
            s.archived_hidden_count,
            s.running_subagent_count,
            s.history_subagents_hidden_count,
            s.compact_needed_count,
            sym,
            total_disp
        )
    }];

    if let Some(ref note) = snap.carbon_concurrency_note {
        lines.push(format!("! {note}"));
    }

    for item in snap.sessions.iter().take(8) {
        let item_cost = select_display_cost(item.cost_usd, item.cost_cny, ccode);
        let flag = if item.just_compacted {
            let kb_note = if item.compact_summary_kb > 0.0 {
                format!("·~{:.1}KB", item.compact_summary_kb)
            } else {
                String::new()
            };
            let xmod_note = if item.cross_model_compact {
                if zh {
                    "·跨模型"
                } else {
                    "·cross-model"
                }
            } else {
                ""
            };
            if zh {
                format!(
                    " [已压缩·原{}{kb_note}{xmod_note}]",
                    fmt_k(item.pre_compact_tokens)
                )
            } else {
                format!(
                    " [compacted from {}{kb_note}{xmod_note}]",
                    fmt_k(item.pre_compact_tokens)
                )
            }
        } else if item.suggest_compact {
            if zh {
                " [建议压缩]".to_string()
            } else {
                " [compact suggested]".to_string()
            }
        } else {
            String::new()
        };
        let run_tag = format_live_status_tag(item, zh);
        let think_txt = if item.total_thinking_tokens > 0 {
            if zh {
                format!(" | 思考 {:.0}%", item.thinking_share_pct)
            } else {
                format!(" | think {:.0}%", item.thinking_share_pct)
            }
        } else {
            String::new()
        };
        let cb = &item.cold_cache_breakdown;
        let mb = &item.mid_loop_breakdown;
        let mid_sub = if cb.mid_loop_cold > 0
            && (mb.slow_turn_self_expiry > 0
                || mb.replica_spillover > 0
                || mb.model_switch_cold > 0)
        {
            if zh {
                format!(
                    "[过期{}/被清{}/换模{}]",
                    mb.slow_turn_self_expiry, mb.replica_spillover, mb.model_switch_cold
                )
            } else {
                format!(
                    "[expired:{}/dropped:{}/switch:{}]",
                    mb.slow_turn_self_expiry, mb.replica_spillover, mb.model_switch_cold
                )
            }
        } else {
            String::new()
        };
        let cold_txt = if item.cold_cache_count > 0 {
            if zh {
                format!(
                    " (缓存未命中 {}：新一轮 {}/中途 {}{}/压缩后 {})",
                    item.cold_cache_count,
                    cb.turn_start_cold,
                    cb.mid_loop_cold,
                    mid_sub,
                    cb.post_compact_cold
                )
            } else {
                format!(
                    " ({} cache miss: {} new-turn/{} mid-turn{}/{} after-compact)",
                    item.cold_cache_count,
                    cb.turn_start_cold,
                    cb.mid_loop_cold,
                    mid_sub,
                    cb.post_compact_cold
                )
            }
        } else {
            String::new()
        };
        lines.push(if zh {
            format!(
                "- {} ({}){}: {}/{} (余 {}) | {} | 缓存 {:.1}%{}{think_txt} | {} 轮 | {}{:.2}{}",
                item.title,
                item.id,
                run_tag,
                fmt_k(item.latest_context_tokens),
                fmt_k(item.context_limit),
                fmt_k(item.remaining_context_tokens),
                item.model_display,
                item.cache_hit_rate,
                cold_txt,
                item.turns,
                sym,
                item_cost,
                flag
            )
        } else {
            format!(
                "- {} ({}){}: {}/{} ({} left) | {} | cache {:.1}%{}{think_txt} | {} turns | {}{:.2}{}",
                item.title,
                item.id,
                run_tag,
                fmt_k(item.latest_context_tokens),
                fmt_k(item.context_limit),
                fmt_k(item.remaining_context_tokens),
                item.model_display,
                item.cache_hit_rate,
                cold_txt,
                item.turns,
                sym,
                item_cost,
                flag
            )
        });
        for sub in item.subagents.iter().take(4) {
            let sub_cost = select_display_cost(sub.cost_usd, sub.cost_cny, ccode);
            let sub_run = format_live_status_tag(sub, zh);
            let sub_flag = if !sub.is_side_question && sub.suggest_compact && !sub.just_compacted {
                if zh {
                    " [建议换新会话]"
                } else {
                    " [new chat suggested]"
                }
            } else {
                ""
            };
            let kind_zh = if sub.is_side_question {
                "顺便问"
            } else {
                "子代理"
            };
            let kind_en = if sub.is_side_question {
                "Aside"
            } else {
                "Subagent"
            };
            lines.push(if zh {
                format!(
                    "  · {kind_zh} {} ({}){}: {}/{} (余 {}) | {} | 缓存 {:.1}% | {}{:.2}{}",
                    sub.title,
                    sub.id,
                    sub_run,
                    fmt_k(sub.latest_context_tokens),
                    fmt_k(sub.context_limit),
                    fmt_k(sub.remaining_context_tokens),
                    sub.model_display,
                    sub.cache_hit_rate,
                    sym,
                    sub_cost,
                    sub_flag
                )
            } else {
                format!(
                    "  · {kind_en} {} ({}){}: {}/{} ({} left) | {} | cache {:.1}% | {}{:.2}{}",
                    sub.title,
                    sub.id,
                    sub_run,
                    fmt_k(sub.latest_context_tokens),
                    fmt_k(sub.context_limit),
                    fmt_k(sub.remaining_context_tokens),
                    sub.model_display,
                    sub.cache_hit_rate,
                    sym,
                    sub_cost,
                    sub_flag
                )
            });
        }
    }

    lines.join("\n")
}
