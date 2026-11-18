use std::path::Path;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;
use uuid::Uuid;
use velo_agent::{discover_augmented_path, resolve_cli_binary};

#[derive(Debug, Deserialize)]
pub struct TranscribeRequest {
    pub audio_base64: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TranscribeResponse {
    pub ok: bool,
    pub text: String,
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn transcribe_audio(
    temp_dir: &Path,
    audio_bytes: &[u8],
    mime_type: &str,
    language: Option<&str>,
) -> Value {
    let ext = if mime_type.contains("wav") {
        "wav"
    } else if mime_type.contains("mp4") || mime_type.contains("m4a") {
        "m4a"
    } else if mime_type.contains("caf") {
        "caf"
    } else {
        "webm"
    };
    let _ = tokio::fs::create_dir_all(temp_dir).await;
    let raw_file = temp_dir.join(format!("voice-{}.{}", Uuid::new_v4(), ext));
    if let Err(err) = tokio::fs::write(&raw_file, audio_bytes).await {
        return json!(TranscribeResponse {
            ok: false,
            text: String::new(),
            engine: "none".to_string(),
            error: Some(format!("Failed to write temporary audio: {}", err)),
        });
    }

    let aug_path = discover_augmented_path();
    let lang = language.unwrap_or("zh");

    // 1. Local whisper-cli / mlx_whisper if installed on macOS
    for bin_name in ["mlx_whisper", "whisper-cli", "whisper"] {
        if let Some(bin) = resolve_cli_binary(bin_name) {
            let out_dir = temp_dir.join(format!("whisper-out-{}", Uuid::new_v4()));
            let _ = tokio::fs::create_dir_all(&out_dir).await;
            let res = if bin_name == "whisper-cli" {
                Command::new(&bin)
                    .args(["-f", &raw_file.to_string_lossy(), "-nt", "-l", lang])
                    .env("PATH", &aug_path)
                    .output()
                    .await
            } else {
                Command::new(&bin)
                    .args([
                        &raw_file.to_string_lossy(),
                        "--output_format",
                        "txt",
                        "--output_dir",
                        &out_dir.to_string_lossy(),
                        "--language",
                        lang,
                    ])
                    .env("PATH", &aug_path)
                    .output()
                    .await
            };
            if let Ok(o) = res {
                if o.status.success() {
                    let stdout_text = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    let stem = raw_file
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("voice");
                    let txt_file = out_dir.join(format!("{}.txt", stem));
                    let text = if let Ok(f_txt) = tokio::fs::read_to_string(&txt_file).await {
                        f_txt.trim().to_string()
                    } else {
                        stdout_text
                    };
                    let _ = tokio::fs::remove_file(&raw_file).await;
                    let _ = tokio::fs::remove_dir_all(&out_dir).await;
                    return json!(TranscribeResponse {
                        ok: true,
                        text,
                        engine: bin_name.to_string(),
                        error: None,
                    });
                }
            }
            let _ = tokio::fs::remove_dir_all(&out_dir).await;
        }
    }

    // 2. OpenAI Whisper API fallback if OPENAI_API_KEY is configured in environment
    if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
        if !api_key.trim().is_empty() {
            let file_arg = format!("file=@{}", raw_file.display());
            let auth_hdr = format!("Authorization: Bearer {}", api_key.trim());
            let out = Command::new("curl")
                .args([
                    "-sS",
                    "--max-time",
                    "30",
                    "-X",
                    "POST",
                    "https://api.openai.com/v1/audio/transcriptions",
                    "-H",
                    &auth_hdr,
                    "-F",
                    &file_arg,
                    "-F",
                    "model=whisper-1",
                ])
                .output()
                .await;
            if let Ok(res) = out {
                if res.status.success() {
                    if let Ok(val) = serde_json::from_slice::<Value>(&res.stdout) {
                        if let Some(t) = val.get("text").and_then(|v| v.as_str()) {
                            let _ = tokio::fs::remove_file(&raw_file).await;
                            return json!(TranscribeResponse {
                                ok: true,
                                text: t.trim().to_string(),
                                engine: "openai-whisper-1".to_string(),
                                error: None,
                            });
                        }
                    }
                }
            }
        }
    }

    // 3. macOS Native Speech.framework (`SFSpeechURLRecognitionRequest`) zero-dependency fallback
    #[cfg(target_os = "macos")]
    {
        let mut speech_input = raw_file.clone();
        let mut converted_wav: Option<std::path::PathBuf> = None;

        // Convert webm/ogg to 16kHz wav if ffmpeg is available; m4a/wav/caf are read natively by Speech.framework
        if ext == "webm" {
            if let Some(ffmpeg) = resolve_cli_binary("ffmpeg") {
                let wav_path = temp_dir.join(format!("voice-conv-{}.wav", Uuid::new_v4()));
                let conv = Command::new(&ffmpeg)
                    .args([
                        "-y",
                        "-i",
                        &raw_file.to_string_lossy(),
                        "-ar",
                        "16000",
                        "-ac",
                        "1",
                        &wav_path.to_string_lossy(),
                    ])
                    .env("PATH", &aug_path)
                    .output()
                    .await;
                if let Ok(c) = conv {
                    if c.status.success() && wav_path.exists() {
                        speech_input = wav_path.clone();
                        converted_wav = Some(wav_path);
                    }
                }
            }
        }

        let locale_id = if lang.starts_with("zh") {
            "zh-CN"
        } else if lang.starts_with("en") {
            "en-US"
        } else {
            lang
        };
        let swift_src = format!(
            r#"
import Foundation
import Speech

let url = URL(fileURLWithPath: "{}")
guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "{}")) ?? SFSpeechRecognizer(),
      rec.isAvailable else {{
    exit(2)
}}
let req = SFSpeechURLRecognitionRequest(url: url)
if #available(macOS 13.0, *) {{
    req.addsPunctuation = true
}}
var best = ""
let sem = DispatchSemaphore(value: 0)
let _ = rec.recognitionTask(with: req) {{ result, error in
    if let r = result {{
        let s = r.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty {{ best = s }}
        if r.isFinal {{ sem.signal() }}
    }} else if error != nil {{
        sem.signal()
    }}
}}
_ = sem.wait(timeout: .now() + 12.0)
if !best.isEmpty {{
    print("VELO_STT_TEXT:\(best)")
    exit(0)
}}
exit(3)
"#,
            speech_input.display(),
            locale_id
        );

        let swift_out = Command::new("swift")
            .args(["-e", &swift_src])
            .output()
            .await;

        if let Some(wav_p) = converted_wav {
            let _ = tokio::fs::remove_file(wav_p).await;
        }

        if let Ok(out) = swift_out {
            if out.status.success() {
                let raw_stdout = String::from_utf8_lossy(&out.stdout);
                if let Some(txt) = raw_stdout.lines().find_map(|line| {
                    line.find("VELO_STT_TEXT:")
                        .map(|p| line[p + "VELO_STT_TEXT:".len()..].trim().to_string())
                }) {
                    if !txt.is_empty() {
                        let _ = tokio::fs::remove_file(&raw_file).await;
                        return json!(TranscribeResponse {
                            ok: true,
                            text: txt,
                            engine: "macos-speech-framework".to_string(),
                            error: None,
                        });
                    }
                }
            }
        }
    }

    let _ = tokio::fs::remove_file(&raw_file).await;
    json!(TranscribeResponse {
        ok: false,
        text: String::new(),
        engine: "webkit-speech".to_string(),
        error: Some("No local whisper CLI (`mlx_whisper` / `whisper-cli`) or `OPENAI_API_KEY` found; using native Speech.".to_string()),
    })
}
