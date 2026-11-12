import AVFoundation
import SwiftUI
import UIKit

public struct PairingSheetView: View {
    @ObservedObject var store: VeloStore
    @Environment(\.dismiss) private var dismiss

    @State private var manualAddress: String = ""
    @State private var statusHint: String?

    public init(store: VeloStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    // 1. Native Camera QR Scanner Card
                    VStack(spacing: 10) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(Color.black)
                                .frame(height: 250)

                            #if targetEnvironment(simulator)
                            VStack(spacing: 10) {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 44, weight: .light))
                                    .foregroundStyle(.white.opacity(0.85))
                                Text("iOS 模拟器无实体摄像头")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(.white)
                                Text("真机安装后可直接对准电脑端 Velo 二维码秒连")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.white.opacity(0.65))
                            }
                            .padding()
                            #else
                            CameraQRScannerRepresentable { code in
                                if store.applyPairingString(code) {
                                    dismiss()
                                }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .frame(height: 250)
                            .overlay {
                                RoundedRectangle(cornerRadius: 16)
                                    .strokeBorder(Color.white.opacity(0.65), style: StrokeStyle(lineWidth: 2, dash: [14, 10]))
                                    .frame(width: 175, height: 175)
                            }
                            #endif
                        }

                        Text("打开 Mac 端 Velo → 点击右上角手机配对图标 → 扫码直连（支持 Wi-Fi 局域网、Tailscale 与 ChaCha20-Poly1305 端到端加密中继）")
                            .font(.system(size: 12.5))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 6)
                    }

                    // 2. Manual URL / IP Entry & Quick Actions
                    VStack(alignment: .leading, spacing: 10) {
                        Text("手动输入地址或配对链接")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.secondary)

                        HStack(spacing: 8) {
                            TextField("例如 192.168.1.20:6767 或 velo://pair?...", text: $manualAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .font(.system(size: 14, design: .monospaced))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))

                            Button("连接") {
                                if store.applyPairingString(manualAddress) {
                                    dismiss()
                                } else {
                                    statusHint = "格式无效，请输入 IP:6767 或完整配对链接"
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(manualAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }

                        HStack(spacing: 10) {
                            Button {
                                if let clip = UIPasteboard.general.string, !clip.isEmpty {
                                    manualAddress = clip
                                    if store.applyPairingString(clip) {
                                        dismiss()
                                    }
                                } else {
                                    statusHint = "剪贴板为空"
                                }
                            } label: {
                                Label("粘贴配对链接", systemImage: "doc.on.clipboard")
                                    .font(.system(size: 13, weight: .medium))
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)

                            #if targetEnvironment(simulator)
                            Button {
                                if store.applyPairingString("http://127.0.0.1:6767") {
                                    dismiss()
                                }
                            } label: {
                                Label("连接本机 Mac", systemImage: "desktopcomputer")
                                    .font(.system(size: 13, weight: .medium))
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            #endif
                        }

                        if let statusHint {
                            Text(statusHint)
                                .font(.system(size: 12))
                                .foregroundStyle(.orange)
                        }
                    }
                    .padding(14)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                    )

                    // 3. Current Connection Summary
                    if let current = store.connectionConfig {
                        HStack {
                            Image(systemName: current.isEncryptedRelay ? "lock.shield.fill" : "wifi")
                                .foregroundStyle(store.isConnected ? .green : .orange)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(current.displayTitle)
                                        .font(.system(size: 13.5, weight: .semibold))
                                    if current.isEncryptedRelay && store.isForwardSecretRatcheted {
                                        Text("X25519·FS")
                                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                                            .foregroundStyle(.green)
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1.5)
                                            .background(Color.green.opacity(0.14), in: Capsule())
                                    }
                                }
                                Text(
                                    store.isConnected
                                        ? (current.isEncryptedRelay
                                            ? "零信任盲中继已加密连通（ChaCha20-Poly1305 AEAD）"
                                            : "已实时连接局域网 WebSocket")
                                        : (store.connectionError ?? "正在重连…")
                                )
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("断开", role: .destructive) {
                                store.disconnectAndClear()
                            }
                            .font(.system(size: 13, weight: .medium))
                        }
                        .padding(14)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("配对 Mac 守护进程")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear {
                if let direct = store.connectionConfig?.directBaseURL {
                    manualAddress = direct
                }
            }
        }
    }
}

#if !targetEnvironment(simulator)
private struct CameraQRScannerRepresentable: UIViewControllerRepresentable {
    var onCodeScanned: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerVC {
        let vc = ScannerVC()
        vc.onCodeScanned = onCodeScanned
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerVC, context: Context) {}

    final class ScannerVC: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCodeScanned: ((String) -> Void)?
        private let captureSession = AVCaptureSession()
        private var previewLayer: AVCaptureVideoPreviewLayer?
        private var didEmit = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black

            guard let videoDevice = AVCaptureDevice.default(for: .video),
                  let videoInput = try? AVCaptureDeviceInput(device: videoDevice),
                  captureSession.canAddInput(videoInput)
            else { return }

            captureSession.addInput(videoInput)

            let metadataOutput = AVCaptureMetadataOutput()
            guard captureSession.canAddOutput(metadataOutput) else { return }
            captureSession.addOutput(metadataOutput)
            metadataOutput.setMetadataObjectsDelegate(self, queue: .main)
            metadataOutput.metadataObjectTypes = [.qr]

            let preview = AVCaptureVideoPreviewLayer(session: captureSession)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.layer.bounds
            view.layer.addSublayer(preview)
            self.previewLayer = preview

            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.captureSession.startRunning()
            }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            previewLayer?.frame = view.layer.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            if captureSession.isRunning {
                DispatchQueue.global(qos: .background).async { [weak self] in
                    self?.captureSession.stopRunning()
                }
            }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !didEmit,
                  let readable = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let value = readable.stringValue, !value.isEmpty
            else { return }
            didEmit = true
            captureSession.stopRunning()
            onCodeScanned?(value)
        }
    }
}
#endif
