//! Host keep-alive: probe the web endpoint and respawn the Host when it dies.
//!
//! The Host can disappear while the shell runs (a WSL VM torn down after sleep,
//! a crashed Node process). The served page then retries forever against a dead
//! origin. The watchdog probes the loopback endpoint and respawns the Host on
//! the same preferred port, then repoints the content webview at the fresh
//! authenticated URL so the page recovers without user action.

use std::time::Duration;

use tauri::Manager;

use crate::chrome::quit_requested;
use crate::i18n::{self, Msg};
use crate::notify;
use crate::overlay;
use crate::runtime::boot_log;
use crate::runtime::supervisor::{spawn_wsl_web_host, HostHandle, HostOverlay};
use crate::runtime::wsl::SystemWslRunner;
use crate::runtime::{DesktopRuntime, PluginRunTarget};

/// Probe cadence while the Host answers.
const PROBE_INTERVAL: Duration = Duration::from_secs(15);
/// Consecutive failed probes before the Host is declared dead. One failure can
/// be a transient blip; three span roughly 45 seconds of silence.
const DEAD_PROBES: usize = 3;
/// Per-probe HTTP timeout; a hung socket must not hold the loop hostage.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Run the keep-alive loop for the managed [`DesktopRuntime`]. Ends when the
/// shell quits.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run(app).await {
            boot_log::error(&format!("watchdog stopped: {error}"));
        }
    });
}

async fn run(app: tauri::AppHandle) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let mut dead_probes = 0usize;
    let mut announced_restart = false;
    loop {
        tokio::time::sleep(PROBE_INTERVAL).await;
        if quit_requested() {
            return Ok(());
        }
        let Some(runtime) = app.try_state::<DesktopRuntime>() else {
            continue;
        };
        if host_answers(&client, &probe_target(&runtime)).await {
            dead_probes = 0;
            continue;
        }
        dead_probes += 1;
        if dead_probes < DEAD_PROBES {
            continue;
        }
        dead_probes = 0;
        let stored_url = runtime.web_url.read().expect("web_url lock poisoned").clone();
        boot_log::error("watchdog: host unreachable; respawning");
        match respawn(&app, &runtime, &stored_url).await {
            Ok(host) => {
                let new_url = host.web_url.clone();
                runtime.replace_host(host);
                repoint_content_webview(&app, &new_url);
                // Announce once per outage; a long outage with a working
                // respawn still beats a toast every cycle.
                if !announced_restart {
                    notify::toast(&app, "DeepSeek Harness", i18n::t(Msg::ToastHostRestarted));
                    announced_restart = true;
                }
                boot_log::info(&format!("watchdog: host respawned url={new_url}"));
            }
            Err(error) => {
                boot_log::error(&format!("watchdog: respawn failed: {error}"));
            }
        }
    }
}

/// Origin the watchdog probes: the stored URL carries a one-time login token,
/// so probing it would burn the URL for no diagnostic gain.
fn probe_target(runtime: &DesktopRuntime) -> String {
    let stored = runtime
        .web_url
        .read()
        .expect("web_url lock poisoned")
        .clone();
    url::Url::parse(&stored)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or(stored)
}

/// Parse the loopback port out of a stored Host URL so a respawn rebinds the
/// port the page still points at.
pub fn parse_probe_port(web_url: &str) -> Option<u16> {
    url::Url::parse(web_url)
        .ok()?
        .port_or_known_default()
}

async fn host_answers(client: &reqwest::Client, url: &str) -> bool {
    // The auth wall answers 401/303 without credentials; any response at all
    // proves a live listener on the loopback port.
    client.get(url).send().await.is_ok()
}

/// Stop the dead Host and spawn a fresh one on the same preferred port, per
/// the runtime target recorded at boot.
async fn respawn(
    app: &tauri::AppHandle,
    runtime: &DesktopRuntime,
    stored_url: &str,
) -> Result<HostHandle, String> {
    let preferred_port =
        parse_probe_port(stored_url).ok_or_else(|| format!("无法解析宿主端口: {stored_url}"))?;
    runtime.host.read().expect("host lock poisoned").stop();

    let notify_url = app
        .try_state::<notify::NotifyHandle>()
        .map(|handle| handle.url.clone());
    match runtime.plugin_target.clone() {
        PluginRunTarget::Windows { host_path, .. } => {
            let host_overlay = notify_url.and_then(|url| {
                let overlay_src =
                    overlay::resolve_overlay_source(app.path().resource_dir().ok().as_deref());
                match overlay::install_overlay(&runtime.paths, &overlay_src, &url) {
                    Ok(implanted) => Some(HostOverlay {
                        patch_file: implanted.patch_file,
                        notify_url: url,
                    }),
                    Err(error) => {
                        boot_log::info(&format!("watchdog overlay skipped: {error}"));
                        None
                    }
                }
            });
            crate::runtime::supervisor::spawn_web_host(
                &runtime.paths,
                host_overlay.as_ref(),
                &host_path,
                preferred_port,
            )
            .await
        }
        PluginRunTarget::Wsl(wsl_paths) => {
            let host_overlay = notify_url.map(|url| HostOverlay {
                // Linux patch path is already on `wsl_paths.linux_patch`.
                patch_file: std::path::PathBuf::new(),
                notify_url: url,
            });
            spawn_wsl_web_host(&wsl_paths, host_overlay.as_ref(), &SystemWslRunner, preferred_port)
                .await
        }
    }
}

/// Navigate the content webview to the respawned Host's authenticated URL. The
/// fresh token mints a session cookie, so the page lands back in the app.
fn repoint_content_webview(app: &tauri::AppHandle, web_url: &str) {
    let Ok(target) = web_url.parse::<url::Url>() else {
        boot_log::error("watchdog: respawned URL is invalid; webview not repointed");
        return;
    };
    if let Some(content) = app.get_webview("content") {
        if let Err(error) = content.navigate(target) {
            boot_log::error(&format!("watchdog: webview navigate failed: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_probe_port;

    #[test]
    fn parse_probe_port_reads_explicit_and_default_ports() {
        assert_eq!(parse_probe_port("http://127.0.0.1:17890/?token=abc"), Some(17890));
        assert_eq!(parse_probe_port("http://127.0.0.1/?token=abc"), Some(80));
        assert_eq!(parse_probe_port("not a url"), None);
    }
}
