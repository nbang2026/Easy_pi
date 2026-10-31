use std::sync::LazyLock;
use regex::Regex;

const MAX_STARTUP_BYTES: usize = 64 * 1024;

#[derive(Default)]
pub(crate) struct StartupDiagnostics {
    bytes: Vec<u8>,
    finished: bool,
}

impl StartupDiagnostics {
    pub(crate) fn record(&mut self, bytes: &[u8]) {
        if !self.finished {
            let remaining = MAX_STARTUP_BYTES.saturating_sub(self.bytes.len());
            self.bytes.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        }
    }

    pub(crate) fn finish(&mut self) {
        self.finished = true;
        self.bytes.clear();
    }

    pub(crate) fn error(&self) -> Option<String> {
        static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(
            r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))",
        ).unwrap());
        static ERROR_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
            r"(?i)(?:\b(?:[a-z]*error|exception)(?:\s*\[[^\]]+\])?\s*:|failed to (?:load|start|open|resolve)|cannot find (?:module|package)|permission denied|command not found)",
        ).unwrap());
        let text = String::from_utf8_lossy(&self.bytes);
        let text = ANSI.replace_all(&text, "").replace('\r', "\n");
        let text: String = text.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
        // Redact the complete startup block before choosing lines, including
        // credentials split across PTY chunks or multiline private keys.
        let text = super::privacy::redact_full(&text);
        let errors = text.lines().map(str::trim).filter(|line| ERROR_LINE.is_match(line))
            .take(4).collect::<Vec<_>>().join("\n");
        if errors.is_empty() { None } else { Some(errors.chars().take(2048).collect()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_errors_are_readable_and_credentials_are_redacted_across_chunks() {
        let mut diagnostics = StartupDiagnostics::default();
        diagnostics.record(b"\x1b[31mError [ERR_MODULE_NOT_FOUND]: Cannot find package /Users/alice/private/file.js\x1b[0m\r\n");
        diagnostics.record(b"Error: apiKey=\"first ");
        diagnostics.record(b"secret second secret\"\r\n");
        let error = diagnostics.error().unwrap();
        assert!(error.contains("ERR_MODULE_NOT_FOUND"), "{error}");
        assert!(error.contains("[redacted path]"), "{error}");
        assert!(error.contains("apiKey=[redacted]"), "{error}");
        for secret in ["alice", "first secret", "second secret", "\x1b"] {
            assert!(!error.contains(secret), "{error}");
        }
    }

    #[test]
    fn successful_startup_discards_output_and_never_captures_subsequent_session_text() {
        let mut diagnostics = StartupDiagnostics::default();
        diagnostics.record(b"Error: old startup warning\n");
        diagnostics.finish();
        diagnostics.record(b"Error: private conversation text\n");
        assert!(diagnostics.bytes.is_empty());
        assert_eq!(diagnostics.error(), None);
    }

    #[test]
    fn ordinary_terminal_content_is_not_included_as_an_error() {
        let mut diagnostics = StartupDiagnostics::default();
        diagnostics.record(b"Pi ready\n> confidential draft\nstartup help\n");
        assert_eq!(diagnostics.error(), None);
    }

    #[test]
    fn startup_capture_and_presentation_have_fixed_memory_limits() {
        let mut diagnostics = StartupDiagnostics::default();
        diagnostics.record(b"Error: ");
        diagnostics.record(&vec![b'x'; MAX_STARTUP_BYTES * 2]);
        assert_eq!(diagnostics.bytes.len(), MAX_STARTUP_BYTES);
        assert_eq!(diagnostics.error().unwrap().chars().count(), 2048);
    }
}
