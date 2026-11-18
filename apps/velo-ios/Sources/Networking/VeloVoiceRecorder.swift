import AVFoundation
import Foundation

@MainActor
public final class VeloVoiceRecorder: ObservableObject {
    @Published public private(set) var isRecording: Bool = false
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?

    public init() {}

    public func startRecording() async -> Bool {
        let granted: Bool
        if #available(iOS 17.0, *) {
            granted = await AVAudioApplication.requestRecordPermission()
        } else {
            granted = await withCheckedContinuation { cont in
                AVAudioSession.sharedInstance().requestRecordPermission { ok in
                    cont.resume(returning: ok)
                }
            }
        }
        guard granted else { return false }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("velo-voice-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.prepareToRecord()
            guard rec.record() else { return false }
            self.recorder = rec
            self.recordingURL = url
            self.isRecording = true
            return true
        } catch {
            return false
        }
    }

    public func stopRecording() -> Data? {
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let url = recordingURL else { return nil }
        recordingURL = nil
        let data = try? Data(contentsOf: url)
        try? FileManager.default.removeItem(at: url)
        return data
    }
}
