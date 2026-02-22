// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Parsing helpers for command output returned by System Git.

/// Parsed status payload derived from `git status --porcelain=v2 --branch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedStatusPayload {
    /// Flattened file entries.
    pub files: Vec<ParsedFileEntry>,
    /// Ahead count relative to upstream.
    pub ahead: u32,
    /// Behind count relative to upstream.
    pub behind: u32,
}

/// Parsed file entry from porcelain-v2 status output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedFileEntry {
    /// Current path for the entry.
    pub path: String,
    /// Old path when this entry is a rename.
    pub old_path: Option<String>,
    /// Backend-agnostic status code.
    pub status: String,
    /// Whether the entry is staged.
    pub staged: bool,
    /// Whether the entry is a conflict.
    pub conflicted: bool,
}

/// Parsed branch entry from `git for-each-ref` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedBranch {
    /// Full ref name (for example `refs/heads/main`).
    pub full_ref: String,
    /// Short branch name (for example `main`).
    pub short_name: String,
    /// Whether this branch is currently checked out.
    pub current: bool,
}

/// Parsed commit entry from `git log` custom format output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedCommit {
    /// Full commit id.
    pub id: String,
    /// Commit subject.
    pub msg: String,
    /// Commit metadata string.
    pub meta: String,
    /// Commit author display string.
    pub author: String,
}

/// Parsed stash entry from `git stash list` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedStash {
    /// Stash selector (for example `stash@{0}`).
    pub selector: String,
    /// User-facing stash message.
    pub msg: String,
    /// Metadata associated with the stash.
    pub meta: String,
}

/// Parses porcelain-v2 status output.
pub(crate) fn parse_status_payload(text: &str) -> ParsedStatusPayload {
    let mut files = Vec::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;

    for line in text.lines() {
        if let Some((a, b)) = parse_branch_ab(line) {
            ahead = a;
            behind = b;
            continue;
        }

        if let Some(entry) = parse_status_line(line) {
            files.push(entry);
        }
    }

    ParsedStatusPayload {
        files,
        ahead,
        behind,
    }
}

/// Parses `# branch.ab +N -M` from porcelain-v2 status output.
fn parse_branch_ab(line: &str) -> Option<(u32, u32)> {
    let ab = line.strip_prefix("# branch.ab ")?;
    let mut parts = ab.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.strip_prefix('+'))
        .and_then(|value| value.parse::<u32>().ok())?;
    let behind = parts
        .next()
        .and_then(|value| value.strip_prefix('-'))
        .and_then(|value| value.parse::<u32>().ok())?;
    Some((ahead, behind))
}

/// Parses a single porcelain-v2 status line.
fn parse_status_line(line: &str) -> Option<ParsedFileEntry> {
    if let Some(path) = line.strip_prefix("? ") {
        let path = path.trim();
        if path.is_empty() {
            return None;
        }
        return Some(ParsedFileEntry {
            path: path.to_string(),
            old_path: None,
            status: "?".to_string(),
            staged: false,
            conflicted: false,
        });
    }

    if line.starts_with("! ") {
        return None;
    }

    if let Some(rest) = line.strip_prefix("u ") {
        let path = rest.split_whitespace().last()?.trim();
        if path.is_empty() {
            return None;
        }
        return Some(ParsedFileEntry {
            path: path.to_string(),
            old_path: None,
            status: "U".to_string(),
            staged: false,
            conflicted: true,
        });
    }

    if let Some(rest) = line.strip_prefix("1 ") {
        return parse_tracked_status(rest, false);
    }

    if let Some(rest) = line.strip_prefix("2 ") {
        return parse_tracked_status(rest, true);
    }

    None
}

/// Parses tracked (`1`) and rename/copy (`2`) status lines.
fn parse_tracked_status(rest: &str, rename_or_copy: bool) -> Option<ParsedFileEntry> {
    let xy = rest.split_whitespace().next()?.trim();
    if xy.len() < 2 {
        return None;
    }

    let (path, old_path) = if rename_or_copy {
        let (before_tab, after_tab) = rest.split_once('\t').unwrap_or((rest, ""));
        let path = remainder_after_fields(before_tab, 8)
            .unwrap_or_default()
            .trim()
            .to_string();
        let old_path = (!after_tab.trim().is_empty()).then(|| after_tab.trim().to_string());
        (path, old_path)
    } else {
        let path = remainder_after_fields(rest, 7)
            .unwrap_or_default()
            .trim()
            .to_string();
        (path, None)
    };
    if path.is_empty() {
        return None;
    }

    let x = xy.chars().next().unwrap_or('.');
    let y = xy.chars().nth(1).unwrap_or('.');
    let staged = x != '.';
    let conflicted = is_conflicted_xy(x, y);
    let status = if conflicted {
        "U".to_string()
    } else if rename_or_copy {
        "R".to_string()
    } else {
        dominant_status(x, y)
    };

    Some(ParsedFileEntry {
        path,
        old_path,
        status,
        staged,
        conflicted,
    })
}

/// Returns the trailing substring after `count` whitespace-delimited fields.
fn remainder_after_fields(text: &str, count: usize) -> Option<&str> {
    let mut idx = 0usize;
    let bytes = text.as_bytes();

    for _ in 0..count {
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() {
            return None;
        }
        while idx < bytes.len() && !bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
    }

    while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
        idx += 1;
    }

    (idx < bytes.len()).then_some(&text[idx..])
}

/// Returns true when the porcelain XY pair indicates an unresolved conflict.
fn is_conflicted_xy(x: char, y: char) -> bool {
    matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'))
}

/// Chooses a single status code from an XY pair.
fn dominant_status(x: char, y: char) -> String {
    if x != '.' {
        return x.to_string();
    }
    if y != '.' {
        return y.to_string();
    }
    "M".to_string()
}

/// Parses branch entries from `git for-each-ref` output.
pub(crate) fn parse_branches(text: &str) -> Vec<ParsedBranch> {
    let mut out = Vec::new();
    for line in text.lines() {
        let parts = line.split('\u{1f}').collect::<Vec<_>>();
        if parts.len() < 3 {
            continue;
        }
        let full_ref = parts[0].trim();
        let short_name = parts[1].trim();
        let head = parts[2].trim();
        if full_ref.is_empty() || short_name.is_empty() {
            continue;
        }
        out.push(ParsedBranch {
            full_ref: full_ref.to_string(),
            short_name: short_name.to_string(),
            current: head == "*",
        });
    }
    out
}

/// Parses commit entries from custom `git log` formatting.
pub(crate) fn parse_commits(text: &str) -> Vec<ParsedCommit> {
    let mut out = Vec::new();
    for record in text.split('\u{1e}') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }
        let fields = record.split('\u{1f}').collect::<Vec<_>>();
        if fields.len() < 4 {
            continue;
        }
        let id = fields[0].trim();
        if id.is_empty() {
            continue;
        }
        out.push(ParsedCommit {
            id: id.to_string(),
            msg: fields[1].trim().to_string(),
            meta: fields[2].trim().to_string(),
            author: fields[3].trim().to_string(),
        });
    }
    out
}

/// Parses stash entries from custom `git stash list` formatting.
pub(crate) fn parse_stashes(text: &str) -> Vec<ParsedStash> {
    let mut out = Vec::new();
    for line in text.lines() {
        let fields = line.split('\u{1f}').collect::<Vec<_>>();
        if fields.len() < 3 {
            continue;
        }
        let selector = fields[0].trim();
        if selector.is_empty() {
            continue;
        }
        out.push(ParsedStash {
            selector: selector.to_string(),
            msg: fields[1].trim().to_string(),
            meta: fields[2].trim().to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// Verifies ahead/behind parsing from porcelain-v2 metadata.
    fn parse_status_payload_extracts_branch_ab() {
        let parsed = parse_status_payload("# branch.ab +3 -7\n");
        assert_eq!(parsed.ahead, 3);
        assert_eq!(parsed.behind, 7);
    }

    #[test]
    /// Verifies untracked and tracked entries are parsed.
    fn parse_status_payload_extracts_files() {
        let input = [
            "1 M. N... 100644 100644 100644 1111111 2222222 src/lib.rs",
            "? README.md",
            "u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt",
        ]
        .join("\n");
        let parsed = parse_status_payload(&input);
        assert_eq!(parsed.files.len(), 3);
        assert_eq!(parsed.files[0].path, "src/lib.rs");
        assert_eq!(parsed.files[0].status, "M");
        assert_eq!(parsed.files[1].status, "?");
        assert_eq!(parsed.files[2].status, "U");
        assert!(parsed.files[2].conflicted);
    }

    #[test]
    /// Verifies tracked paths with spaces are preserved.
    fn parse_status_payload_preserves_spaces_in_tracked_paths() {
        let input = "1 .M N... 100644 100644 100644 abcdef1 abcdef2 docs/plugin architecture.md";
        let parsed = parse_status_payload(input);
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].path, "docs/plugin architecture.md");
    }

    #[test]
    /// Verifies rename records keep old/new paths with spaces.
    fn parse_status_payload_preserves_spaces_in_rename_paths() {
        let input = "2 R. N... 100644 100644 100644 abcdef1 abcdef2 R100 docs/new name.md\tdocs/old name.md";
        let parsed = parse_status_payload(input);
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].path, "docs/new name.md");
        assert_eq!(
            parsed.files[0].old_path.as_deref(),
            Some("docs/old name.md")
        );
        assert_eq!(parsed.files[0].status, "R");
    }

    #[test]
    /// Verifies branch list parsing keeps refs and current marker.
    fn parse_branches_extracts_expected_fields() {
        let input = [
            "refs/heads/main\u{1f}main\u{1f}*",
            "refs/remotes/origin/main\u{1f}origin/main\u{1f}",
        ]
        .join("\n");
        let branches = parse_branches(&input);
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].short_name, "main");
        assert!(branches[0].current);
        assert_eq!(branches[1].full_ref, "refs/remotes/origin/main");
        assert!(!branches[1].current);
    }

    #[test]
    /// Verifies commit records parse from control-character separators.
    fn parse_commits_extracts_records() {
        let input = "abc\u{1f}subject\u{1f}2026-01-02T03:04:05Z\u{1f}Ada <ada@example.com>\u{1e}";
        let commits = parse_commits(input);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].id, "abc");
        assert_eq!(commits[0].msg, "subject");
    }

    #[test]
    /// Verifies stash list parsing keeps selector/message/meta fields.
    fn parse_stashes_extracts_entries() {
        let input = "stash@{0}\u{1f}WIP on main\u{1f}2 hours ago\n";
        let stashes = parse_stashes(input);
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].selector, "stash@{0}");
        assert_eq!(stashes[0].msg, "WIP on main");
    }
}
