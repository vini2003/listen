#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Keep WebKit's accelerated renderer available, but transport frames through
    // shared memory to avoid failing GBM allocations on some Linux drivers.
    // Preserve explicit overrides, including the older compatibility mode.
    #[cfg(target_os = "linux")]
    {
        for (name, value) in [
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "0"),
            ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"),
        ] {
            if std::env::var_os(name).is_none() {
                std::env::set_var(name, value);
            }
        }
    }
    listen_lib::run();
}
