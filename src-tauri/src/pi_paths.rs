use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub(crate) fn agent_directory(
    configured: Option<&OsStr>,
    home: Option<&OsStr>,
    userprofile: Option<&OsStr>,
    current_dir: &Path,
) -> Result<PathBuf, String> {
    if let Some(configured) = configured.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(configured);
        if path == Path::new("~") {
            return home.filter(|value| !value.is_empty()).or_else(|| userprofile.filter(|value| !value.is_empty())).map(PathBuf::from).ok_or_else(|| "HOME and USERPROFILE are not set".into());
        }
        if let Ok(rest) = path.strip_prefix("~") {
            if !rest.as_os_str().is_empty() {
                let root = home.filter(|value| !value.is_empty()).or_else(|| userprofile.filter(|value| !value.is_empty())).map(PathBuf::from).ok_or("HOME and USERPROFILE are not set")?;
                return Ok(root.join(rest));
            }
        }
        return Ok(if path.is_absolute() { path } else { current_dir.join(path) });
    }

    let root = home.filter(|value| !value.is_empty()).or_else(|| userprofile.filter(|value| !value.is_empty())).map(PathBuf::from).ok_or("HOME and USERPROFILE are not set")?;
    Ok(root.join(".pi").join("agent"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_directory_wins_and_expands_tilde() {
        let home = Path::new("/tmp/pi-paths-home");
        assert_eq!(agent_directory(Some(OsStr::new("/tmp/custom-agent")), Some(home.as_os_str()), None, Path::new("/tmp/cwd")).unwrap(), Path::new("/tmp/custom-agent"));
        assert_eq!(agent_directory(Some(OsStr::new("~/custom-agent")), Some(home.as_os_str()), None, Path::new("/tmp/cwd")).unwrap(), home.join("custom-agent"));
        assert_eq!(agent_directory(Some(OsStr::new("~")), Some(home.as_os_str()), None, Path::new("/tmp/cwd")).unwrap(), home);
    }

    #[test]
    fn empty_override_defaults_and_windows_profile_is_fallback() {
        assert_eq!(agent_directory(Some(OsStr::new("")), Some(OsStr::new("/tmp/pi-paths-home")), None, Path::new("/tmp/cwd")).unwrap(), Path::new("/tmp/pi-paths-home/.pi/agent"));
        assert_eq!(agent_directory(None, None, Some(OsStr::new("C:\\Users\\fixture")), Path::new("/tmp/cwd")).unwrap(), Path::new("C:\\Users\\fixture/.pi/agent"));
        assert!(agent_directory(None, None, None, Path::new("/tmp/cwd")).is_err());
        assert_eq!(agent_directory(Some(OsStr::new("relative-agent")), Some(OsStr::new("/tmp/home")), None, Path::new("/tmp/cwd")).unwrap(), Path::new("/tmp/cwd/relative-agent"));
    }
}
