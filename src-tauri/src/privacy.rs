use std::sync::LazyLock;
use regex::Regex;

pub(crate) fn redact(text: &str) -> String {
    redact_full(text).chars().take(4096).collect()
}

pub(crate) fn redact_full(text: &str) -> String {
    static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| vec![
        (Regex::new(r"(?i)\b(?:sk-ant-[a-z0-9_-]{8,}|sk-[a-z0-9_-]{8,}|ghp_[a-z0-9_-]{8,}|github_pat_[a-z0-9_-]{8,}|glpat-[a-z0-9_-]{8,}|npm_[a-z0-9_-]{8,}|AIza[a-z0-9_-]{16,}|AKIA[A-Z0-9]{12,}|xox[baprs]-[a-z0-9-]{8,}|ya29\.[a-z0-9._-]{12,})").unwrap(), "[redacted]"),
        (Regex::new(r"(?i)\b(Bearer|Basic)\s+[a-z0-9+/_.=-]+").unwrap(), "$1 [redacted]"),
        (Regex::new(r#"(?i)((?:(?:[a-z0-9.-]+[_-])*)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|authorization|private[_-]?key|webhook|secret(?:(?:[_-]?access)?[_-]?key)?|token)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"',;&}]+)"#).unwrap(), "$1[redacted]"),
        (Regex::new(r"(?is)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----.*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)").unwrap(), "[redacted private key]"),
        (Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^/\s@]+@").unwrap(), "$1[redacted]@"),
        (Regex::new(r#"(?i)(?:/Users/[^/\s"'<>]+(?:/[^\s"'<>]*)?|/home/[^/\s"'<>]+(?:/[^\s"'<>]*)?|/root(?:/[^\s"'<>]*)?|/private/var/folders/[^\s"'<>]+|/var/folders/[^\s"'<>]+|[A-Za-z]:(?:\\[^\s"'<>]+|/[^/\s"'<>][^\s"'<>]*)|\\\\[^\\\s"'<>]+(?:\\[^\s"'<>]+)*)"#).unwrap(), "[redacted path]"),
    ]);
    PATTERNS.iter().fold(text.to_owned(), |value, (pattern, replacement)| {
        pattern.replace_all(&value, *replacement).into_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_removed_without_erasing_normal_errors() {
        let input = r#"{"apiKey":"private-value","password":"hidden","DB_PASSWORD":"database-secret","AWS_SECRET_ACCESS_KEY":"aws-secret"} Authorization: Bearer abc.xyz https://user:pass@example.test/?token=hidden postgresql://alice:db-secret@db.example.test/app sk-abcdefghijklmnop ghp_abcdefghijklmnop github_pat_abcdefghijklmnop glpat-abcdefghijklmnop npm_abcdefghijklmnop AIzaabcdefghijklmnop1234 AKIA1234567890 xoxb-abcdefghijklmnop ya29.abcdefghijklmnop -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY----- /Users/alice/secret.txt"#;
        let clean = redact(input);
        for secret in ["private-value", "hidden", "database-secret", "aws-secret", "abc.xyz", "user:pass", "alice:db-secret", "abcdefghijklmnop", "/Users/alice"] {
            assert!(!clean.contains(secret), "{clean}");
        }
        assert_eq!(redact("Git unavailable; retry"), "Git unavailable; retry");
        assert!(redact("Request failed at https://example.test/path").contains("https://example.test/path"));
        assert!(redact("DATABASE_URL=postgresql://alice:db-secret@db.example.test/app")
            .contains("postgresql://[redacted]@db.example.test/app"));
        assert_eq!(redact(r"Read C:\Users\alice\secret.txt"), "Read [redacted path]");
    }

    #[test]
    fn quoted_and_truncated_secrets_do_not_leak_suffixes() {
        for input in [
            r#"DB_PASSWORD="first secret second secret" retry later"#,
            r#"{"client_secret":"first secret second secret"} retry later"#,
            r#"DB_PASSWORD="first secret second secret"#,
            "-----BEGIN PRIVATE KEY-----\nfirst secret second secret",
        ] {
            let clean = redact(input);
            assert!(!clean.contains("first secret"), "{clean}");
            assert!(!clean.contains("second secret"), "{clean}");
            assert!(clean.contains("[redacted"), "{clean}");
        }
        assert!(redact(r#"DB_PASSWORD="first secret second secret" retry later"#).contains("retry later"));
    }
}
