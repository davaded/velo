#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::SocketAddr;
use velo_protocol::{DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT};

fn main() {
    // Automatically start embedded Velo daemon in background if port 6767 is available
    std::thread::spawn(|| {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let addr: SocketAddr = format!("{}:{}", DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT)
                .parse()
                .expect("valid socket address");
            let _ = velo_daemon::run_daemon_server(addr).await;
        });
    });

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Velo Tauri application");
}
