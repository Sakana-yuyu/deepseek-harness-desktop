pub mod boot_log;
pub mod config;
pub mod env_path;
pub mod host_env;
pub mod io_fallback;
pub mod path_bridge;
pub mod plugin_catalog;
mod process;
pub mod profile_repair;
pub mod provision;
pub mod supervisor;
pub mod user_home;
pub mod watchdog;
pub mod wsl;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::desktop_settings::{effective_agent_environment, AgentEnvironment, DesktopSettings};
use crate::i18n::{self, Msg};
use plugin_catalog::PluginRunTarget;
use provision::RuntimePaths;
use supervisor::{HostHandle, HostOverlay};
use wsl::WslRuntimePaths;

/// Resolved Node + harness tree and the spawned Host child.
pub struct DesktopRuntime {
    pub paths: RuntimePaths,
    /// Live Host. The watchdog replaces it after a respawn; the old handle is
    /// stopped first, so a replacement never runs in parallel with its parent.
    pub host: RwLock<HostHandle>,
    /// Authenticated URL of the current Host generation; updated on respawn.
    pub web_url: RwLock<String>,
    /// How tray `dsh plugin add` must reach the live Host profile.
    pub plugin_target: PluginRunTarget,
}

impl DesktopRuntime {
    /// Swap in a respawned Host and its authenticated URL.
    pub fn replace_host(&self, host: HostHandle) {
        *self.web_url.write().expect("web_url lock poisoned") = host.web_url.clone();
        *self.host.write().expect("host lock poisoned") = host;
    }
}

impl DesktopRuntime {
    /// Start `dsh web` against an already provisioned Windows tree.
    ///
    /// Applies the Windows PATH bridge and profile repair, then spawns the
    /// Host with `node.exe`. WSL mode must use [`Self::start_wsl`] instead.
    pub async fn start(
        paths: RuntimePaths,
        overlay: Option<&HostOverlay>,
        progress: Arc<dyn Fn(ProvisionEvent) + Send + Sync>,
    ) -> Result<Self, String> {
        boot_log::info(&format!(
            "provision complete cli={} node={}",
            paths.cli_entry.display(),
            paths.node_binary.display()
        ));
        let host_path = match path_bridge::prepare_host_path(&paths, |event| progress(event)) {
            Ok(path) => path,
            Err(error) => {
                boot_log::info(&format!("path bridge fallback: {error}"));
                path_bridge::merge_path(Some(env_path::discovery_path()), &[])
            }
        };
        progress(ProvisionEvent::Status(
            i18n::t(Msg::StatusCheckProfile).into(),
        ));
        if let Err(error) =
            profile_repair::ensure_profile_installs(&paths, &host_path, &progress).await
        {
            return Err(error);
        }
        progress(ProvisionEvent::Status(i18n::t(Msg::StatusStartWeb).into()));
        let host = supervisor::spawn_web_host(&paths, overlay, &host_path, config::DEFAULT_WEB_PORT)
            .await?;
        boot_log::info("dsh web ready");
        Ok(Self {
            paths: paths.clone(),
            web_url: RwLock::new(host.web_url.clone()),
            plugin_target: PluginRunTarget::Windows {
                node: paths.node_binary.clone(),
                cli: paths.cli_entry.clone(),
                harness_root: paths.harness_root.clone(),
                dsh_home: paths.dsh_home.clone(),
                host_path,
            },
            host: RwLock::new(host),
        })
    }

    /// Wrap a Host already spawned inside WSL.
    ///
    /// Skips the Windows PATH bridge and Windows profile repair. `paths` is a
    /// documented placeholder: the live Linux tree lives on WSL runtime paths
    /// inside the supervisor session, not on Windows `RuntimePaths`.
    /// Wrap a Host already spawned inside WSL.
    ///
    /// Skips the Windows PATH bridge and Windows profile repair. `paths` is a
    /// documented placeholder: the live Linux tree lives on WSL runtime paths
    /// inside the supervisor session, not on Windows `RuntimePaths`.
    pub fn start_wsl(host: HostHandle, wsl_paths: WslRuntimePaths) -> Self {
        boot_log::info("wsl dsh web ready");
        Self {
            // Placeholder only — WSL Host does not consume Windows RuntimePaths.
            paths: RuntimePaths {
                node_binary: PathBuf::new(),
                pnpm_binary: PathBuf::new(),
                cli_entry: PathBuf::new(),
                harness_root: PathBuf::new(),
                runtime_root: PathBuf::new(),
                dsh_home: PathBuf::new(),
            },
            web_url: RwLock::new(host.web_url.clone()),
            plugin_target: PluginRunTarget::Wsl(wsl_paths),
            host: RwLock::new(host),
        }
    }
}

/// Progress events for the splash UI.
#[derive(Clone, Debug)]
pub enum ProvisionEvent {
    Status(String),
    Progress(u8),
}

/// Which agent environment boot should enter, from persisted settings.
pub fn boot_kind(settings: &DesktopSettings) -> AgentEnvironment {
    effective_agent_environment(settings)
}

pub fn app_data_root() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("DeepSeek Harness"))
        .ok_or_else(|| "cannot resolve application data directory".into())
}

#[cfg(test)]
mod boot_kind_tests {
    use super::boot_kind;
    use crate::desktop_settings::{AgentEnvironment, DesktopSettings};

    #[test]
    fn default_settings_select_windows() {
        assert_eq!(
            boot_kind(&DesktopSettings::default()),
            AgentEnvironment::Windows
        );
    }

    #[test]
    fn wsl_settings_select_wsl() {
        assert_eq!(
            boot_kind(&DesktopSettings {
                agent_environment: AgentEnvironment::Wsl,
                ..DesktopSettings::default()
            }),
            AgentEnvironment::Wsl
        );
    }
}
