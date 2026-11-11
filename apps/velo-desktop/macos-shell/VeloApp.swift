import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var daemonProcess: Process?

    func isDaemonPortListening() -> Bool {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(6767).bigEndian
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)

        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        close(sock)
        return connected == 0
    }

    func ensureDaemonRunning() {
        if isDaemonPortListening() {
            return
        }

        let bundledBin = Bundle.main.bundlePath + "/Contents/MacOS/velo-daemon"
        let bundledUiDir = Bundle.main.bundlePath + "/Contents/Resources/dist"
        let devReleaseBin = "/Users/daiyudai/code/velo/target/release/velo"
        let devDebugBin = "/Users/daiyudai/code/velo/target/debug/velo"
        let daemonBin: String
        if FileManager.default.isExecutableFile(atPath: bundledBin) {
            daemonBin = bundledBin
        } else if FileManager.default.isExecutableFile(atPath: devReleaseBin) {
            daemonBin = devReleaseBin
        } else if FileManager.default.isExecutableFile(atPath: devDebugBin) {
            daemonBin = devDebugBin
        } else {
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: daemonBin)
        proc.arguments = ["--addr", "0.0.0.0:6767", "up", "--foreground"]
        var env = ProcessInfo.processInfo.environment
        if FileManager.default.fileExists(atPath: bundledUiDir + "/index.html") {
            env["VELO_UI_DIR"] = bundledUiDir
        }
        proc.environment = env
        try? proc.run()
        self.daemonProcess = proc

        for _ in 0..<35 {
            if isDaemonPortListening() {
                break
            }
            Thread.sleep(forTimeInterval: 0.08)
        }
    }

    func setupMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Velo", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide Velo", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Velo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload Window", action: #selector(reloadWebView), keyEquivalent: "r")
        viewMenuItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    @objc func reloadWebView() {
        webView?.reload()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "windowDrag", let event = NSApp.currentEvent {
            window.performDrag(with: event)
        } else if message.name == "windowTheme", let mode = message.body as? String {
            switch mode {
            case "light":
                window.appearance = NSAppearance(named: .aqua)
                window.backgroundColor = NSColor(calibratedRed: 0.98, green: 0.98, blue: 0.99, alpha: 1.0)
            case "dark":
                window.appearance = NSAppearance(named: .darkAqua)
                window.backgroundColor = NSColor(calibratedRed: 0.047, green: 0.047, blue: 0.055, alpha: 1.0)
            default:
                window.appearance = nil
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensureDaemonRunning()
        setupMenu()

        let rect = NSRect(x: 0, y: 0, width: 1360, height: 860)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Velo"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 960, height: 640)
        window.appearance = nil
        window.backgroundColor = NSColor.windowBackgroundColor
        window.center()

        let contentController = WKUserContentController()
        contentController.add(self, name: "windowDrag")
        contentController.add(self, name: "windowTheme")
        let scriptSource = """
        window.__VELO_MACOS_APP__ = true;
        window.addEventListener('mousedown', function(e) {
          if (e.button !== 0) return;
          if (e.target && e.target.closest && e.target.closest('button, input, textarea, a, select')) return;
          if (e.target && e.target.closest && e.target.closest('[data-tauri-drag-region]')) {
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.windowDrag) {
              window.webkit.messageHandlers.windowDrag.postMessage('drag');
            }
          }
        });
        """
        let userScript = WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        contentController.addUserScript(userScript)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window.contentView?.addSubview(webView)

        if let url = URL(string: "http://127.0.0.1:6767/?desktop=1") {
            webView.load(URLRequest(url: url))
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            if response == .OK {
                completionHandler(panel.urls)
            } else {
                completionHandler(nil)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
