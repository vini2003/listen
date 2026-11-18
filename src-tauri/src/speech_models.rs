//! The three speech models: where they come from, where they live on disk,
//! and a resumable, checksum-verified download.
//!
//! Every file is pinned to an exact Hugging Face commit and SHA-256, so an
//! upstream change can never silently swap the model Listen runs.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    speech::ModelPaths,
};

struct ModelFile {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    bytes: u64,
}

struct ModelSpec {
    id: &'static str,
    name: &'static str,
    role: &'static str,
    licence: &'static str,
    files: &'static [ModelFile],
}

const DIARIZER: &str = "nemotron-3-diarization";
const RECOGNIZER: &str = "parakeet-tdt-0.6b-v3-int8";
const EMBEDDER: &str = "wespeaker-resnet34-lm";

const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: DIARIZER,
        name: "Nemotron 3 Diarization",
        role: "Separates who is speaking",
        licence: "NVIDIA OpenMDW 1.1",
        files: &[
            ModelFile {
                name: "nemotron3_diar_v3.onnx",
                url: "https://huggingface.co/altunenes/parakeet-rs/resolve/26684938ff242cb4f7a65fad712476c6015a4477/nemotron-3-diarization/nemotron3_diar_v3.onnx",
                sha256: "c32d6056f1ca52bdd50a74e1e7c66d91e5147bc29f19ffa4c39cbe5452397d15",
                bytes: 402_167_515,
            },
            ModelFile {
                name: "LICENSE",
                url: "https://huggingface.co/altunenes/parakeet-rs/resolve/26684938ff242cb4f7a65fad712476c6015a4477/nemotron-3-diarization/LICENSE",
                sha256: "14cf93aed5ee7c72516170ecb65fb6d7e54ef19217d328c8b00b78eaf61c8b36",
                bytes: 2_660,
            },
        ],
    },
    ModelSpec {
        id: RECOGNIZER,
        name: "Parakeet TDT 0.6B v3",
        role: "Turns speech into text",
        licence: "CC BY 4.0",
        files: &[
            ModelFile {
                name: "encoder-model.int8.onnx",
                url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/encoder-model.int8.onnx",
                sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
                bytes: 652_183_999,
            },
            ModelFile {
                name: "decoder_joint-model.int8.onnx",
                url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/decoder_joint-model.int8.onnx",
                sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
                bytes: 18_202_004,
            },
            ModelFile {
                name: "vocab.txt",
                url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/vocab.txt",
                sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
                bytes: 93_939,
            },
            ModelFile {
                name: "config.json",
                url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/config.json",
                sha256: "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466",
                bytes: 97,
            },
        ],
    },
    ModelSpec {
        id: EMBEDDER,
        name: "WeSpeaker ResNet34-LM",
        role: "Recognises saved voices",
        licence: "CC BY 4.0",
        files: &[ModelFile {
            name: "voxceleb_resnet34_LM.onnx",
            url: "https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/f0c48c298fd835726c27956a5d617bad7115627e/voxceleb_resnet34_LM.onnx",
            sha256: "7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068",
            bytes: 26_530_309,
        }],
    },
];

const ATTEMPTS: usize = 4;
const STALL_TIMEOUT: Duration = Duration::from_secs(45);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallState {
    Missing,
    Downloading,
    Verifying,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    pub licence: &'static str,
    pub size_bytes: u64,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelsStatus {
    pub state: InstallState,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
    pub models: Vec<ModelStatus>,
}

struct Activity {
    state: InstallState,
    downloaded_bytes: u64,
    error: Option<String>,
}

pub struct SpeechModels {
    root: PathBuf,
    activity: Mutex<Activity>,
    cancel: AtomicBool,
}

impl SpeechModels {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            activity: Mutex::new(Activity {
                state: InstallState::Missing,
                downloaded_bytes: 0,
                error: None,
            }),
            cancel: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> SpeechModelsStatus {
        let models = MODELS
            .iter()
            .map(|model| ModelStatus {
                id: model.id,
                name: model.name,
                role: model.role,
                licence: model.licence,
                size_bytes: model.files.iter().map(|file| file.bytes).sum(),
                installed: self.is_installed(model),
            })
            .collect::<Vec<_>>();
        let total_bytes = models.iter().map(|model| model.size_bytes).sum();
        let installed_bytes = models
            .iter()
            .filter(|model| model.installed)
            .map(|model| model.size_bytes)
            .sum();
        let activity = self.activity.lock();
        let busy = matches!(
            activity.state,
            InstallState::Downloading | InstallState::Verifying
        );
        let state = if busy {
            activity.state
        } else if models.iter().all(|model| model.installed) {
            InstallState::Ready
        } else if activity.error.is_some() {
            InstallState::Failed
        } else {
            InstallState::Missing
        };
        SpeechModelsStatus {
            state,
            downloaded_bytes: if busy {
                activity.downloaded_bytes
            } else {
                installed_bytes
            },
            total_bytes,
            error: activity.error.clone(),
            models,
        }
    }

    /// Paths for the pipeline, or a message saying what is missing.
    pub fn paths(&self) -> AppResult<ModelPaths> {
        if !MODELS.iter().all(|model| self.is_installed(model)) {
            return Err(AppError::Validation(
                "Download the speech models in Settings before transcribing".to_string(),
            ));
        }
        Ok(ModelPaths {
            diarizer: self.root.join(DIARIZER).join("nemotron3_diar_v3.onnx"),
            recognizer: self.root.join(RECOGNIZER),
            embedder: self.embedder_path()?,
        })
    }

    pub fn embedder_path(&self) -> AppResult<PathBuf> {
        let model = MODELS
            .iter()
            .find(|model| model.id == EMBEDDER)
            .ok_or(AppError::NotFound("Voice matching model"))?;
        if !self.is_installed(model) {
            return Err(AppError::Validation(
                "Download the speech models in Settings to learn voices".to_string(),
            ));
        }
        Ok(self.root.join(EMBEDDER).join(model.files[0].name))
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Deletes every model file. The caller makes sure no job is using them.
    pub fn remove(&self) -> AppResult<()> {
        let activity = self.activity.lock();
        if matches!(
            activity.state,
            InstallState::Downloading | InstallState::Verifying
        ) {
            return Err(AppError::Validation(
                "Cancel the download before removing the speech models".to_string(),
            ));
        }
        drop(activity);
        match fs::remove_dir_all(&self.root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.activity.lock().error = None;
        Ok(())
    }

    /// Downloads whatever is missing. Partial files survive a cancel, a crash
    /// or a dropped connection and resume where they stopped.
    pub async fn download(&self, notify: impl Fn(SpeechModelsStatus)) -> AppResult<()> {
        {
            let mut activity = self.activity.lock();
            if matches!(
                activity.state,
                InstallState::Downloading | InstallState::Verifying
            ) {
                return Ok(());
            }
            activity.state = InstallState::Downloading;
            activity.error = None;
            activity.downloaded_bytes = 0;
        }
        self.cancel.store(false, Ordering::SeqCst);
        notify(self.status());

        let result = self.download_missing(&notify).await;
        {
            let mut activity = self.activity.lock();
            activity.state = InstallState::Missing;
            activity.error = match &result {
                Err(Failure::Retry(message)) => Some(message.clone()),
                Err(Failure::Fatal(error)) => Some(error.to_string()),
                Ok(()) | Err(Failure::Cancelled) => None,
            };
        }
        notify(self.status());
        match result {
            Ok(()) | Err(Failure::Cancelled) => Ok(()),
            Err(Failure::Retry(message)) => Err(AppError::Download(message)),
            Err(Failure::Fatal(error)) => Err(error),
        }
    }

    async fn download_missing(&self, notify: &impl Fn(SpeechModelsStatus)) -> Result<(), Failure> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .user_agent(concat!("Listen/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| Failure::Retry(format!("Could not start the download: {error}")))?;
        let mut completed = 0u64;
        for model in MODELS {
            let directory = self.root.join(model.id);
            fs::create_dir_all(&directory)?;
            for file in model.files {
                let target = directory.join(file.name);
                if installed_file(&target, file) {
                    completed += file.bytes;
                    continue;
                }
                let mut attempt = 0;
                loop {
                    match self
                        .download_file(&client, file, &target, completed, notify)
                        .await
                    {
                        Ok(()) => break,
                        Err(Failure::Retry(_)) if attempt + 1 < ATTEMPTS => {
                            attempt += 1;
                            tokio::time::sleep(Duration::from_secs(2u64.pow(attempt as u32))).await;
                        }
                        Err(failure) => return Err(failure),
                    }
                }
                completed += file.bytes;
            }
        }
        Ok(())
    }

    async fn download_file(
        &self,
        client: &reqwest::Client,
        file: &ModelFile,
        target: &Path,
        completed_before: u64,
        notify: &impl Fn(SpeechModelsStatus),
    ) -> Result<(), Failure> {
        let partial = target.with_file_name(format!("{}.part", file.name));
        let mut hasher = Sha256::new();
        let mut written = existing_partial(&partial, file.bytes, &mut hasher)?;

        let mut request = client.get(file.url);
        if written > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={written}-"));
        }
        let mut response = request.send().await.map_err(network_failure)?;
        let status = response.status();
        let mut output = if written > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
            fs::OpenOptions::new().append(true).open(&partial)?
        } else if status.is_success() {
            written = 0;
            hasher = Sha256::new();
            File::create(&partial)?
        } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            let _ = fs::remove_file(&partial);
            return Err(Failure::Retry(format!("{} had to restart", file.name)));
        } else if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(Failure::Retry(format!(
                "Hugging Face answered HTTP {} for {}",
                status.as_u16(),
                file.name
            )));
        } else {
            return Err(Failure::Fatal(AppError::Download(format!(
                "Hugging Face answered HTTP {} for {}",
                status.as_u16(),
                file.name
            ))));
        };

        let mut last_notice = Instant::now();
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                output.flush()?;
                return Err(Failure::Cancelled);
            }
            let chunk = tokio::time::timeout(STALL_TIMEOUT, response.chunk())
                .await
                .map_err(|_| Failure::Retry("The connection stalled".to_string()))?
                .map_err(network_failure)?;
            let Some(chunk) = chunk else {
                break;
            };
            written += chunk.len() as u64;
            if written > file.bytes {
                drop(output);
                let _ = fs::remove_file(&partial);
                return Err(Failure::Retry(format!(
                    "{} was larger than expected",
                    file.name
                )));
            }
            hasher.update(&chunk);
            output.write_all(&chunk)?;
            if last_notice.elapsed() >= PROGRESS_INTERVAL {
                last_notice = Instant::now();
                self.activity.lock().downloaded_bytes = completed_before + written;
                notify(self.status());
            }
        }
        output.flush()?;
        drop(output);
        if written < file.bytes {
            return Err(Failure::Retry(format!("{} ended early", file.name)));
        }

        self.activity.lock().state = InstallState::Verifying;
        notify(self.status());
        let digest = format!("{:x}", hasher.finalize());
        self.activity.lock().state = InstallState::Downloading;
        if digest != file.sha256 {
            let _ = fs::remove_file(&partial);
            return Err(Failure::Retry(format!(
                "{} failed its integrity check and was discarded",
                file.name
            )));
        }
        fs::rename(&partial, target)?;
        self.activity.lock().downloaded_bytes = completed_before + file.bytes;
        notify(self.status());
        Ok(())
    }

    fn is_installed(&self, model: &ModelSpec) -> bool {
        model
            .files
            .iter()
            .all(|file| installed_file(&self.root.join(model.id).join(file.name), file))
    }
}

enum Failure {
    /// Worth another attempt: network trouble, a stall, a bad checksum.
    Retry(String),
    Fatal(AppError),
    Cancelled,
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Failure::Fatal(error.into())
    }
}

impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Failure::Fatal(error)
    }
}

fn installed_file(path: &Path, file: &ModelFile) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.len() == file.bytes)
}

/// Bytes already on disk from an interrupted download, fed into the hasher.
fn existing_partial(path: &Path, expected: u64, hasher: &mut Sha256) -> AppResult<u64> {
    let Ok(mut input) = File::open(path) else {
        return Ok(0);
    };
    if input.metadata()?.len() >= expected {
        drop(input);
        fs::remove_file(path)?;
        return Ok(0);
    }
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            return Ok(total);
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
}

fn network_failure(error: reqwest::Error) -> Failure {
    Failure::Retry(format!("Could not reach Hugging Face: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_is_pinned_and_complete() {
        for model in MODELS {
            for file in model.files {
                assert!(file.url.starts_with("https://huggingface.co/"));
                assert!(file.url.contains("/resolve/") && !file.url.contains("/resolve/main/"));
                assert_eq!(file.sha256.len(), 64);
                assert!(file.bytes > 0);
            }
        }
        let total: u64 = MODELS
            .iter()
            .flat_map(|model| model.files)
            .map(|file| file.bytes)
            .sum();
        assert!(total > 1_000_000_000 && total < 1_200_000_000);
    }

    #[test]
    fn reports_missing_until_every_file_is_present() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let models = SpeechModels::new(directory.path().to_path_buf());
        assert_eq!(models.status().state, InstallState::Missing);
        assert!(models.paths().is_err());

        for model in MODELS {
            let folder = directory.path().join(model.id);
            fs::create_dir_all(&folder).expect("model folder");
            for file in model.files {
                File::create(folder.join(file.name))
                    .and_then(|handle| handle.set_len(file.bytes))
                    .expect("sparse model file");
            }
        }
        let status = models.status();
        assert_eq!(status.state, InstallState::Ready);
        assert_eq!(status.downloaded_bytes, status.total_bytes);
        assert!(models.paths().is_ok());

        models.remove().expect("remove models");
        assert_eq!(models.status().state, InstallState::Missing);
    }

    #[test]
    fn resumes_partial_files_with_their_hash_state() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let partial = directory.path().join("model.part");
        fs::write(&partial, b"hello ").expect("partial");
        let mut hasher = Sha256::new();
        assert_eq!(
            existing_partial(&partial, 100, &mut hasher).expect("resume"),
            6
        );
        hasher.update(b"world");
        assert_eq!(
            format!("{:x}", hasher.finalize()),
            format!("{:x}", Sha256::digest(b"hello world"))
        );

        fs::write(&partial, vec![0u8; 100]).expect("oversized partial");
        let mut hasher = Sha256::new();
        assert_eq!(
            existing_partial(&partial, 100, &mut hasher).expect("restart"),
            0
        );
        assert!(!partial.exists());
    }
}
