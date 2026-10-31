use std::io;
use std::ops::{Deref, DerefMut};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(unix)]
pub(crate) fn kill_owned_group(pid: Option<u32>) {
    let Some(pid) = pid.and_then(|value| i32::try_from(value).ok()).filter(|pid| *pid > 1) else { return; };
    // portable-pty makes the child a session leader. Never signal the GUI's
    // process group or a child that no longer has the expected ownership.
    unsafe {
        if libc::getpgid(pid) == pid && libc::getsid(pid) == pid && pid != libc::getpgrp() {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

/// Explicit stops use `into_inner` on a blocking worker. Implicit drops (including
/// application shutdown and replacement of an exited terminal) must also keep
/// process and PTY cleanup off the caller's thread.
pub(crate) struct BackgroundDrop<T: Send + 'static>(Option<T>);

impl<T: Send + 'static> BackgroundDrop<T> {
    pub(crate) fn new(value: T) -> Self {
        Self(Some(value))
    }

    pub(crate) fn into_inner(mut self) -> T {
        self.0.take().expect("terminal resources already taken")
    }
}

impl<T: Send + 'static> Deref for BackgroundDrop<T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.0.as_ref().expect("terminal resources already taken")
    }
}

impl<T: Send + 'static> DerefMut for BackgroundDrop<T> {
    fn deref_mut(&mut self) -> &mut T {
        self.0.as_mut().expect("terminal resources already taken")
    }
}

impl<T: Send + 'static> Drop for BackgroundDrop<T> {
    fn drop(&mut self) {
        if let Some(value) = self.0.take() {
            std::thread::spawn(move || drop(value));
        }
    }
}

/// Validate and detach under the lock; ownership of cleanup belongs to the
/// caller only after the guard has been released.
pub(crate) fn take_for_stop<T>(
    terminal: &Mutex<Option<T>>,
    validate: impl FnOnce(&mut T) -> Result<(), String>,
) -> Result<Option<T>, String> {
    let mut guard = terminal.lock().map_err(|error| error.to_string())?;
    if let Some(value) = guard.as_mut() {
        validate(value)?;
    }
    Ok(guard.take())
}

/// `portable_pty::Child::try_wait` is nonblocking. Never follow a kill with
/// `wait`: a failed kill or a lingering PTY must not stall teardown forever.
pub(crate) fn wait_for_exit<T>(
    mut try_wait: impl FnMut() -> io::Result<Option<T>>,
    timeout: Duration,
) -> io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        if try_wait()?.is_some() {
            return Ok(true);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    #[cfg(unix)]
    #[test]
    fn owned_session_group_exits_and_foreign_group_is_untouched() {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        unsafe { command.pre_exec(|| {
            if libc::setsid() < 0 { return Err(io::Error::last_os_error()); }
            Ok(())
        }); }
        let mut child = command.spawn().unwrap();
        kill_owned_group(Some(child.id()));
        let exited = wait_for_exit(|| child.try_wait(), Duration::from_secs(2)).unwrap();
        if !exited { let _ = child.kill(); let _ = child.wait(); }
        assert!(exited);
        kill_owned_group(Some(std::process::id()));
        kill_owned_group(None);
    }

    struct BlockedCleanup {
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl Drop for BlockedCleanup {
        fn drop(&mut self) {
            let _ = self.started.send(());
            // A timeout keeps a failed assertion from leaking a test worker.
            let _ = self.release.recv_timeout(Duration::from_secs(2));
        }
    }

    fn blocked_cleanup() -> (BackgroundDrop<BlockedCleanup>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        (BackgroundDrop::new(BlockedCleanup { started, release: release_rx }), started_rx, release)
    }

    #[test]
    fn explicit_cleanup_releases_state_lock_before_waiting() {
        let (value, started, release) = blocked_cleanup();
        let state = Arc::new(Mutex::new(Some(value)));
        let terminal = take_for_stop(&state, |_| Ok(())).unwrap().unwrap();
        let worker = std::thread::spawn(move || drop(terminal.into_inner()));
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(state.try_lock().unwrap().is_none());
        release.send(()).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn implicit_drop_does_not_wait_for_cleanup() {
        let (terminal, started, release) = blocked_cleanup();
        drop(terminal);
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        release.send(()).unwrap();
    }

    #[test]
    fn rejected_stop_preserves_terminal_without_cleanup() {
        let state = Mutex::new(Some(42));
        assert!(take_for_stop(&state, |_| Err("busy".into())).is_err());
        assert_eq!(*state.lock().unwrap(), Some(42));
    }

    #[test]
    fn exit_poll_has_a_deadline_for_a_child_that_never_exits() {
        let started = Instant::now();
        let mut polls = 0;
        let exited = wait_for_exit(|| { polls += 1; Ok::<Option<()>, io::Error>(None) }, Duration::from_millis(25)).unwrap();
        assert!(!exited);
        assert!(polls >= 2);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn exit_poll_reaps_an_exited_child_and_propagates_errors() {
        assert!(wait_for_exit(|| Ok(Some(())), Duration::from_secs(1)).unwrap());
        assert!(wait_for_exit::<()>(|| Err(io::Error::other("poll failed")), Duration::from_secs(1)).is_err());
    }
}
