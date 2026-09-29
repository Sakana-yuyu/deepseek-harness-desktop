//! Frameless main window, close preference, and custom title-bar commands.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use tauri::window::Color;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Theme, WebviewBuilder, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

const DSH_BG: Color = Color(21, 21, 23, 255);
const DSH_BG_LIGHT: Color = Color(249, 250, 251, 255);

/// OS color scheme at window creation; live changes arrive as `ThemeChanged`.
///
/// Tauri exposes no app-level getter before the first window exists, so the
/// initial value reads the OS directly: `AppsUseLightTheme` on Windows and
/// `AppleInterfaceStyle` on macOS, both defaulting to light.
#[cfg(target_os = "windows")]
fn system_theme() -> Theme {
    use winreg::enums::HKEY_CURRENT_USER;
    let personalize = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    match personalize.and_then(|key| key.get_value::<u32, _>("AppsUseLightTheme")) {
        Ok(0) => Theme::Dark,
        _ => Theme::Light,
    }
}

#[cfg(target_os = "macos")]
fn system_theme() -> Theme {
    let dark = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"Dark"));
    if dark { Theme::Dark } else { Theme::Light }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn system_theme() -> Theme {
    Theme::Light
}

fn theme_background(theme: Theme) -> Color {
    if theme == Theme::Dark { DSH_BG } else { DSH_BG_LIGHT }
}

fn theme_mode(theme: Theme) -> &'static str {
    if theme == Theme::Dark { "dark" } else { "light" }
}

/// Observer script mirroring the client's effective scheme onto the shell: the
/// theme presenter keeps `body[data-ds-dark-theme]` current, and every change
/// is reported to the shell's `/theme` route (a `no-cors` POST needs no CORS
/// handshake on the loopback server).
fn theme_report_script(theme_url: &str) -> String {
    let url = serde_json::to_string(theme_url).unwrap_or_else(|_| "\"\"".into());
    format!(
        ";(() => {{\n\
        \x20 const url = {url}\n\
        \x20 if (!url || window.__DSH_THEME_REPORT__) return\n\
        \x20 let last\n\
        \x20 const report = () => {{\n\
        \x20   const mode = document.body?.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'\n\
        \x20   if (mode === last) return\n\
        \x20   last = mode\n\
        \x20   try {{ fetch(url, {{ method: 'POST', mode: 'no-cors', body: mode }}) }} catch {{}}\n\
        \x20 }}\n\
        \x20 const arm = () => {{\n\
        \x20   report()\n\
        \x20   window.__DSH_THEME_REPORT__?.disconnect()\n\
        \x20   window.__DSH_THEME_REPORT__ = new MutationObserver(report)\n\
        \x20   window.__DSH_THEME_REPORT__.observe(document.body, {{ attributes: true, attributeFilter: ['data-ds-dark-theme'] }})\n\
        \x20 }}\n\
        \x20 if (document.body) arm()\n\
        \x20 else document.addEventListener('DOMContentLoaded', arm, {{ once: true }})\n\
        }})()"
    )
}

use crate::desktop_settings::{self, AgentEnvironment, CloseAction};
use crate::i18n::{self, Msg};
use crate::notify;
use crate::runtime::boot_log;
use crate::runtime::DesktopRuntime;
use crate::window_layout::resolve_controls_layout;

static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Client-reported effective scheme: 0 none (follow the system), 1 light, 2 dark.
static CLIENT_THEME: AtomicU8 = AtomicU8::new(0);

/// Record the content webview's effective color scheme and mirror it onto the
/// shell title bar. The client presenter keeps `body[data-ds-dark-theme]` in
/// sync with its resolved theme, and the injected observer posts every change
/// to the notify server's `/theme` route.
pub fn apply_client_theme(app: &AppHandle, mode: &str) {
    let (theme, code) = match mode {
        "light" => (Theme::Light, 1),
        "dark" => (Theme::Dark, 2),
        other => {
            if !other.is_empty() {
                boot_log::info(&format!("ignoring unknown client theme report: {other}"));
            }
            return;
        }
    };
    CLIENT_THEME.store(code, Ordering::SeqCst);
    boot_log::info(&format!("client theme report: {mode}"));
    apply_shell_theme(app, theme_mode(theme));
}

/// Apply one shell title-bar mode to the shell webview.
fn apply_shell_theme(app: &AppHandle, mode: &str) {
    if let Some(shell) = app.get_webview("main") {
        let script = format!(
            "window.__DSH_CHROME_THEME__?.apply({});",
            serde_json::to_string(mode).unwrap_or_else(|_| "\"dark\"".into())
        );
        if let Err(error) = shell.eval(&script) {
            boot_log::error(&format!("shell theme eval failed: {error}"));
        }
    }
}

/// True when the process is allowed to exit (tray Quit/Restart, Exit close, updater restart).
pub fn quit_requested() -> bool {
    QUIT_REQUESTED.load(Ordering::SeqCst)
}

/// Exit the process after marking quit so `ExitRequested` is not cancelled.
pub fn request_quit(app: &AppHandle) {
    mark_process_end(app);
    if let Some(window) = app.get_window("main") {
        let _ = window.destroy();
    }
    app.exit(0);
}

/// Relaunch the desktop process. Stops the Host first because `app.restart`
/// skips `Drop`, and marks quit so a non-main-thread restart is not cancelled.
pub fn request_restart(app: &AppHandle) -> ! {
    mark_process_end(app);
    app.restart()
}

/// Webview-facing restart: the plugin store's "重启" button asks for a full
/// app relaunch (shell + Host), not just a Host restart. Calls through to
/// `request_restart`, which stops the Host and relaunches this process.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    request_restart(&app)
}

fn mark_process_end(app: &AppHandle) {
    QUIT_REQUESTED.store(true, Ordering::SeqCst);
    stop_host(app);
}

/// Reap the Host Node tree. `app.exit` / `app.restart` skip `Drop`.
pub fn stop_host(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<DesktopRuntime>() {
        runtime.host.read().expect("host lock poisoned").stop();
    }
}

/// Create the frameless shell window that embeds `dsh web`.
pub fn open_main_window(app: &AppHandle, url: &str) -> Result<(), String> {
    if let Some(existing) = app.get_window("main") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "default window icon is missing".to_string())?;
    let locale = match i18n::current() {
        i18n::Locale::Zh => "zh",
        i18n::Locale::En => "en",
    };
    let theme = system_theme();
    let init = format!(
        "window.__DSH_CHROME__ = {}; window.__DSH_LOCALE__ = {}; window.__DSH_CHROME_THEME_INIT__ = {};",
        serde_json::to_string(&resolve_controls_layout()).unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(locale).unwrap_or_else(|_| "\"en\"".into()),
        serde_json::to_string(theme_mode(theme)).unwrap_or_else(|_| "\"dark\"".into()),
    );

    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("shell.html".into()))
        .title("DeepSeek Harness")
        .inner_size(1280.0, 860.0)
        .center()
        .decorations(false)
        .visible(false)
        .background_color(theme_background(theme))
        .theme(Some(theme))
        .initialization_script(&init);

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        builder = builder.shadow(true);
    }

    let window = builder
        .icon(icon)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    // 独立 WebView 提供第一方浏览器环境，保留上游 SameSite=Strict 的认证 cookie。
    let content_url = url.parse::<url::Url>().map_err(|_| "Host 启动地址无效")?;
    let native = app.get_window("main").ok_or("main window is missing")?;
    let mut content_builder =
        WebviewBuilder::new("content", WebviewUrl::External(content_url));
    if let Some(notify) = app.try_state::<notify::NotifyHandle>() {
        content_builder = content_builder.initialization_script(theme_report_script(&notify.theme_url));
    }
    let content = native
        .add_child(
            content_builder,
            LogicalPosition::new(0.0, f64::from(resolve_controls_layout().titlebar_height)),
            content_size(&native)?,
        )
        .map_err(|e| e.to_string())?;

    let app_handle = window.app_handle().clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            if let Ok(size) = content_size(&native) {
                let _ = content.set_position(LogicalPosition::new(
                    0.0,
                    f64::from(resolve_controls_layout().titlebar_height),
                ));
                let _ = content.set_size(size);
            }
        }
        if let WindowEvent::ThemeChanged(theme) = event {
            // The shell paints the title bar itself. While the client page owns
            // the scheme report, system flips reach the bar through the page's
            // own `prefers-color-scheme` handling; before it reports, the OS
            // change must reach the bar directly.
            if CLIENT_THEME.load(Ordering::SeqCst) == 0 {
                apply_shell_theme(&app_handle, theme_mode(*theme));
            }
        }
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            on_close_requested(&app_handle);
        }
    });

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Focus or unhide the main window (single-instance and tray).
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_window("main").or_else(|| app.get_window("splash")) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Apply the saved close action, or ask once when none is stored.
pub fn on_close_requested(app: &AppHandle) {
    match desktop_settings::load().close_action {
        Some(CloseAction::Minimize) => hide_main(app),
        Some(CloseAction::Exit) => request_quit(app),
        None => {
            if let Err(error) = open_close_prompt(app) {
                boot_log::info(&format!("close prompt fallback hide: {error}"));
                hide_main(app);
            }
        }
    }
}

/// Persist a close action from the in-window prompt, then apply it.
#[tauri::command]
pub fn set_close_action(app: AppHandle, action: String) -> Result<(), String> {
    let parsed = parse_close_action(&action)?;
    remember_close_action(&app, parsed)?;
    hide_close_prompt(&app);
    match parsed {
        None => {}
        Some(CloseAction::Minimize) => hide_main(&app),
        Some(CloseAction::Exit) => request_quit(&app),
    }
    Ok(())
}

/// Persist a close action from the tray without immediately hiding or quitting.
pub fn remember_close_action(app: &AppHandle, action: Option<CloseAction>) -> Result<(), String> {
    save_close_action(action)?;
    let message = match action {
        Some(CloseAction::Minimize) => i18n::t(Msg::ToastCloseMin),
        Some(CloseAction::Exit) => i18n::t(Msg::ToastCloseExit),
        None => i18n::t(Msg::ToastCloseAsk),
    };
    notify::toast(app, "DeepSeek Harness", message);
    Ok(())
}

fn parse_close_action(action: &str) -> Result<Option<CloseAction>, String> {
    match action {
        "minimize" => Ok(Some(CloseAction::Minimize)),
        "exit" => Ok(Some(CloseAction::Exit)),
        "ask" => Ok(None),
        other => Err(format!("unknown close action: {other}")),
    }
}

fn save_close_action(action: Option<CloseAction>) -> Result<(), String> {
    let mut settings = desktop_settings::load();
    settings.close_action = action;
    desktop_settings::save(&settings)
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
    }
}

fn open_close_prompt(app: &AppHandle) -> Result<(), String> {
    let main = app
        .get_webview("main")
        .ok_or_else(|| "main window is missing".to_string())?;
    main.eval("window.__DSH_CLOSE_PROMPT__?.show()")
        .map_err(|e| e.to_string())?;
    if let Some(content) = app.get_webview("content") {
        content.hide().map_err(|e| e.to_string())?;
    }
    let _ = main.set_focus();
    Ok(())
}

fn hide_close_prompt(app: &AppHandle) {
    if let Some(main) = app.get_webview("main") {
        let _ = main.eval("window.__DSH_CLOSE_PROMPT__?.hide()");
    }
    if let Some(content) = app.get_webview("content") {
        let _ = content.show();
    }
}

/// 取消关闭选择后恢复内容 WebView。
#[tauri::command]
pub fn dismiss_close_prompt(app: AppHandle) {
    hide_close_prompt(&app);
}

fn content_size(window: &tauri::Window) -> Result<LogicalSize<f64>, String> {
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    Ok(LogicalSize::new(
        size.width,
        (size.height - f64::from(resolve_controls_layout().titlebar_height)).max(1.0),
    ))
}

/// Toast copy when the tray changes the agent runtime target.
pub fn environment_changed_message() -> &'static str {
    i18n::t(Msg::EnvRestart)
}

/// Persist the agent runtime target from the tray without restarting the Host.
pub fn apply_agent_environment(value: AgentEnvironment) -> Result<(), String> {
    let mut settings = desktop_settings::load();
    settings.agent_environment = value;
    desktop_settings::save(&settings)
}

/// Persist the agent runtime target from the tray and toast success or failure.
pub fn remember_agent_environment(app: &AppHandle, value: AgentEnvironment) {
    match apply_agent_environment(value) {
        Ok(()) => notify::toast(app, "DeepSeek Harness", environment_changed_message()),
        Err(error) => {
            boot_log::error(&format!("tray agent environment save failed: {error}"));
            notify::toast(app, i18n::t(Msg::EnvSaveFailed), &error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{environment_changed_message, theme_background, theme_mode, theme_report_script};
    use tauri::Theme;
    use tauri::window::Color;

    #[test]
    fn environment_changed_message_is_restart_toast() {
        assert_eq!(environment_changed_message(), "运行环境将在重启后生效");
    }

    #[test]
    fn theme_helpers_follow_the_scheme() {
        assert_eq!(theme_mode(Theme::Dark), "dark");
        assert_eq!(theme_mode(Theme::Light), "light");
        assert_eq!(theme_background(Theme::Dark), Color(21, 21, 23, 255));
        assert_eq!(theme_background(Theme::Light), Color(249, 250, 251, 255));
    }

    #[test]
    fn theme_report_script_watches_the_dark_attribute() {
        let script = theme_report_script("http://127.0.0.1:9/theme");
        assert!(script.contains("http://127.0.0.1:9/theme"));
        assert!(script.contains("data-ds-dark-theme"));
        assert!(script.contains("MutationObserver"));
    }
}
