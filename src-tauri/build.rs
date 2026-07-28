fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/64x64.png");
    println!("cargo:rerun-if-changed=src/runtime/claude_permission_bridge.mjs");
    tauri_build::build()
}
