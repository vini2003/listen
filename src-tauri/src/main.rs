#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer produces a solid white window on several
    // Linux driver/compositor combinations (GBM buffer allocation fails).
    // Fall back to shared-memory rendering unless the user overrides it.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    listen_lib::run();
}
