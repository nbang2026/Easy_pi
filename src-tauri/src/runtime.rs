use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Runtime {
    External(PathBuf),
    Bundled { node: PathBuf, entry: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommandSpec {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) path_prefix: Vec<PathBuf>,
}

impl CommandSpec {
    pub(crate) fn child_path(&self) -> Option<OsString> {
        self.path_with(std::env::var_os("PATH").as_deref())
    }

    fn path_with(&self, inherited: Option<&OsStr>) -> Option<OsString> {
        if self.path_prefix.is_empty() {
            return None;
        }
        let mut paths = self.path_prefix.clone();
        if let Some(path) = inherited {
            paths.extend(std::env::split_paths(path));
        }
        std::env::join_paths(paths).ok()
    }
}

impl Runtime {
    pub(crate) fn executable(&self) -> &Path {
        match self {
            Self::External(path) => path,
            Self::Bundled { node, .. } => node,
        }
    }

    pub(crate) fn command<I, S>(&self, args: I) -> CommandSpec
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
        match self {
            Self::External(executable) => {
                #[cfg(windows)]
                if executable.extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
                }) {
                    let mut command_args = vec![
                        OsString::from("/D"), OsString::from("/Q"), OsString::from("/C"),
                        executable.clone().into_os_string(),
                    ];
                    command_args.extend(args);
                    return CommandSpec {
                        program: PathBuf::from("cmd.exe"), args: command_args, path_prefix: Vec::new(),
                    };
                }
                CommandSpec { program: executable.clone(), args, path_prefix: Vec::new() }
            }
            Self::Bundled { node, entry } => {
                let mut command_args = vec![entry.clone().into_os_string()];
                command_args.extend(args);
                CommandSpec {
                    program: node.clone(), args: command_args,
                    path_prefix: vec![
                        node.parent().unwrap().to_path_buf(),
                        node.parent().unwrap().parent().unwrap().join("app/node_modules/.bin"),
                    ],
                }
            }
        }
    }
}

/// The caller supplies resources only on Windows. Keep filesystem resolution
/// independent of Tauri so all precedence/completeness tests run on every host.
pub(crate) fn resolve(
    explicit: Option<&OsStr>,
    resources: Option<&Path>,
    external: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<Runtime, String> {
    if let Some(value) = explicit {
        let path = PathBuf::from(value);
        return if path.is_absolute() && super::is_executable(&path) {
            Ok(Runtime::External(path))
        } else {
            // A broken override is a configuration error, not a silent fallback.
            Err("PI_EXECUTABLE must point to an existing executable using an absolute path.".into())
        };
    }
    if let Some(resources) = resources {
        if let Some(bundled) = bundled_runtime(resources)? { return Ok(bundled); }
    }
    external().map(Runtime::External)
}

const BUNDLE_FILES: &[&str] = &[
    "node/node.exe",
    "node/npm.cmd",
    "node/node_modules/npm/bin/npm-cli.js",
    "app/node_modules/@earendil-works/pi-coding-agent/package.json",
    "app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli-runtime.js",
    "app/node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node",
];

fn bundled_runtime(resource_dir: &Path) -> Result<Option<Runtime>, String> {
    if !resource_dir.is_absolute() { return Err("Runtime resource directory must be absolute.".into()); }
    let root = resource_dir.join("runtime/windows-x64");
    if !root.exists() { return Ok(None); }
    for relative in BUNDLE_FILES {
        let path = root.join(relative);
        if !path.is_file() || path.metadata().map(|m| m.len() == 0).unwrap_or(true) {
            return Err(format!("Bundled Pi runtime is incomplete ({relative}). Reinstall N_B_PI."));
        }
    }
    let package: serde_json::Value = std::fs::read(root.join(BUNDLE_FILES[3]))
        .map_err(|e| format!("Bundled Pi metadata: {e}"))
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| format!("Bundled Pi metadata: {e}")))?;
    if package["name"] != "@earendil-works/pi-coding-agent" || package["version"] != "1.3.0" {
        return Err("Bundled Pi metadata is invalid. Reinstall N_B_PI.".into());
    }
    Ok(Some(Runtime::Bundled {
        node: root.join(BUNDLE_FILES[0]),
        entry: root.join(BUNDLE_FILES[4]),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(dir: &Path) -> (PathBuf, PathBuf) {
        let root = dir.join("runtime/windows-x64");
        (root.join("node/node.exe"), root.join("app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"))
    }

    fn write_file(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"test").unwrap();
    }

    fn complete_bundle(dir: &Path) {
        let root = dir.join("runtime/windows-x64");
        for relative in BUNDLE_FILES { write_file(&root.join(relative)); }
        std::fs::write(root.join(BUNDLE_FILES[3]), br#"{"name":"@earendil-works/pi-coding-agent","version":"1.3.0"}"#).unwrap();
    }

    #[test]
    fn bundle_requires_both_files_not_directories() {
        let dir = crate::tests::scratch().join("Pi GUI 测试");
        let (node, entry) = bundle(&dir);
        assert!(bundled_runtime(&dir).unwrap().is_none());
        write_file(&node);
        assert!(bundled_runtime(&dir).is_err());
        std::fs::create_dir_all(&entry).unwrap();
        assert!(bundled_runtime(&dir).is_err());
        std::fs::remove_dir(&entry).unwrap();
        complete_bundle(&dir);
        assert!(bundled_runtime(&dir).unwrap().is_some());
        std::fs::remove_file(&node).unwrap();
        assert!(bundled_runtime(&dir).is_err());
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn override_precedes_bundle_and_external_search() {
        let dir = crate::tests::scratch();
        let (_node, entry) = bundle(&dir);
        complete_bundle(&dir);
        let explicit = dir.join("用户 工具/pi");
        write_file(&explicit);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&explicit, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let result = resolve(Some(explicit.as_os_str()), Some(&dir), || panic!("must not search"));
        assert_eq!(result.unwrap(), Runtime::External(explicit));
        assert!(resolve(Some(OsStr::new("relative/pi")), Some(&dir), || panic!("must not search")).is_err());
        assert!(resolve(Some(dir.join("missing").as_os_str()), Some(&dir), || panic!("must not search")).is_err());
        assert_eq!(resolve(None, Some(&dir), || panic!("bundle precedes external")).unwrap(), bundled_runtime(&dir).unwrap().unwrap());
        std::fs::remove_file(&entry).unwrap();
        let external = dir.join("external pi");
        assert!(resolve(None, Some(&dir), || panic!("must not hide a damaged bundle")).is_err());
        assert_eq!(resolve(None, None, || Ok(external.clone())).unwrap(), Runtime::External(external));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bundled_commands_preserve_spaces_unicode_and_shell_metacharacters() {
        let dir = crate::tests::scratch().join("Program Files 测试 & Pi");
        let (node, entry) = bundle(&dir);
        let runtime = Runtime::Bundled { node: node.clone(), entry: entry.clone() };
        for args in [vec!["--extension", "扩展 path/x.js"], vec!["install", "C:/source path/包 & data"]] {
            let spec = runtime.command(args.clone());
            assert_eq!(spec.program, node);
            assert_eq!(spec.args, std::iter::once(entry.clone().into_os_string()).chain(args.iter().map(OsString::from)).collect::<Vec<_>>());
            assert_eq!(spec.path_prefix, vec![node.parent().unwrap().to_path_buf(), dir.join("runtime/windows-x64/app/node_modules/.bin")]);
            let inherited = std::env::join_paths([dir.join("existing bin"), dir.join("系统")]).unwrap();
            let path = spec.path_with(Some(&inherited)).unwrap();
            assert_eq!(std::env::split_paths(&path).collect::<Vec<_>>(), vec![node.parent().unwrap().to_path_buf(), dir.join("runtime/windows-x64/app/node_modules/.bin"), dir.join("existing bin"), dir.join("系统")]);
            assert_eq!(std::env::split_paths(&spec.path_with(None).unwrap()).collect::<Vec<_>>(), spec.path_prefix);
        }
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn external_native_command_preserves_arguments() {
        let path = PathBuf::from("Pi tools 测试/pi.exe");
        let spec = Runtime::External(path.clone()).command(["install", "source with spaces 包"]);
        assert_eq!(spec.program, path);
        assert_eq!(spec.args, vec![OsString::from("install"), OsString::from("source with spaces 包")]);
        assert!(spec.path_prefix.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn external_batch_shims_keep_existing_cmd_behavior() {
        for extension in ["cmd", "BAT"] {
            let path = PathBuf::from(format!(r"C:\用户 空间\pi.{extension}"));
            let spec = Runtime::External(path.clone()).command(["install", "包 source"]);
            assert_eq!(spec.program, PathBuf::from("cmd.exe"));
            assert_eq!(spec.args, vec![OsString::from("/D"), OsString::from("/Q"), OsString::from("/C"), path.into_os_string(), OsString::from("install"), OsString::from("包 source")]);
        }
    }
}
