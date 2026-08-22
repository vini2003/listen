fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("macos/ScreenCaptureAudio.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("listen_screen_capture_audio");
        for framework in [
            "CoreAudio",
            "CoreGraphics",
            "CoreMedia",
            "Foundation",
            "ScreenCaptureKit",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
