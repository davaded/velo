use std::env;
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut listen = format!("127.0.0.1:{}", velo_relay::DEFAULT_RELAY_PORT);
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--listen" || arg == "-l" {
            if let Some(val) = args.next() {
                listen = val;
            }
        } else if let Some(val) = arg.strip_prefix("--listen=") {
            listen = val.to_string();
        }
    }
    let addr: SocketAddr = listen.parse()?;
    eprintln!("velo-relay listening on ws://{} (zero-trust blind E2EE)", addr);
    velo_relay::run_relay_server(addr).await
}
