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
        link_clang_runtime();
    }
    tauri_build::build()
}

/// ONNX Runtime's prebuilt macOS library uses `@available` checks, which call
/// `__isPlatformVersionAtLeast` from clang's runtime. Rust links with
/// `-nodefaultlibs`, so that runtime has to be named explicitly.
fn link_clang_runtime() {
    let Ok(output) = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
    else {
        println!("cargo:warning=clang not found; the macOS link may miss __isPlatformVersionAtLeast");
        return;
    };
    let resource_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    println!("cargo:rustc-link-search=native={resource_dir}/lib/darwin");
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
