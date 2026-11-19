//! The three speech models: where they come from, where they live on disk,
//! and a resumable, checksum-verified download.
//!
//! Every file is pinned to an exact Hugging Face commit and SHA-256, so an
//! upstream change can never silently swap the model Listen runs.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use futures_util::future::join_all;
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

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
        role: "Speaker separation",
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
        role: "Transcription",
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
        role: "Fingerprinting",
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
    pub downloaded_bytes: u64,
    pub state: InstallState,
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
    download: Option<CancellationToken>,
    models: [InstallState; MODELS.len()],
    // Windows may cache a file's reported length until its writer closes.
    transfers: [Option<(&'static str, u64)>; MODELS.len()],
    error: Option<String>,
}

pub struct SpeechModels {
    root: PathBuf,
    activity: Mutex<Activity>,
}

impl SpeechModels {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            activity: Mutex::new(Activity {
                download: None,
                models: [InstallState::Missing; MODELS.len()],
                transfers: [None; MODELS.len()],
                error: None,
            }),
        }
    }

    pub fn status(&self) -> SpeechModelsStatus {
        let activity = self.activity.lock();
        let models: Vec<_> = MODELS
            .iter()
            .enumerate()
            .map(|(index, model)| {
                let directory = self.root.join(model.id);
                let mut installed = true;
                let mut downloaded_bytes = 0;
                for file in model.files {
                    if installed_file(&directory.join(file.name), file) {
                        downloaded_bytes += file.bytes;
                    } else {
                        installed = false;
                        if let Some((name, bytes)) = activity.transfers[index] {
                            if name == file.name {
                                downloaded_bytes += bytes;
                                continue;
                            }
                        }
                        let partial = directory.join(format!("{}.part", file.name));
                        if let Ok(metadata) = fs::metadata(partial) {
                            if metadata.len() <= file.bytes {
                                downloaded_bytes += metadata.len();
                            }
                        }
                    }
                }
                ModelStatus {
                    id: model.id,
                    name: model.name,
                    role: model.role,
                    licence: model.licence,
                    size_bytes: model.files.iter().map(|file| file.bytes).sum(),
                    downloaded_bytes,
                    installed,
                    state: if installed {
                        InstallState::Ready
                    } else {
                        activity.models[index]
                    },
                }
            })
            .collect();
        let total_bytes = models.iter().map(|model| model.size_bytes).sum();
        let state = if activity.download.is_some() {
            if models
                .iter()
                .any(|model| model.state == InstallState::Downloading)
            {
                InstallState::Downloading
            } else {
                InstallState::Verifying
            }
        } else if models.iter().all(|model| model.installed) {
            InstallState::Ready
        } else if activity.error.is_some() {
            InstallState::Failed
        } else {
            InstallState::Missing
        };
        SpeechModelsStatus {
            state,
            downloaded_bytes: models.iter().map(|model| model.downloaded_bytes).sum(),
            total_bytes,
            error: activity.error.clone(),
            models,
        }
    }

    /// Paths for the pipeline, or a message saying what is missing.
    pub fn paths(&self) -> AppResult<ModelPaths> {
        if !MODELS.iter().all(|model| self.is_installed(model)) {
            return Err(AppError::Validation(
                "Finish downloading the models before transcribing".to_string(),
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
                "Finish downloading the models to learn voices".to_string(),
            ));
        }
        Ok(self.root.join(EMBEDDER).join(model.files[0].name))
    }

    pub fn cancel(&self) {
        if let Some(token) = &self.activity.lock().download {
            token.cancel();
        }
    }

    /// Deletes every model file. The caller makes sure no job is using them.
    pub fn remove(&self) -> AppResult<()> {
        let mut activity = self.activity.lock();
        if activity.download.is_some() {
            return Err(AppError::Validation(
                "Cancel the download before removing the speech models".to_string(),
            ));
        }
        match fs::remove_dir_all(&self.root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        activity.error = None;
        activity.models.fill(InstallState::Missing);
        Ok(())
    }

    /// Downloads whatever is missing. Partial files survive a cancel, a crash
    /// or a dropped connection and resume where they stopped.
    pub async fn download(&self, notify: impl Fn(SpeechModelsStatus)) -> AppResult<()> {
        let cancellation = CancellationToken::new();
        {
            let mut activity = self.activity.lock();
            if activity.download.is_some() {
                return Ok(());
            }
            activity.download = Some(cancellation.clone());
            activity.error = None;
            activity.models.fill(InstallState::Downloading);
        }
        notify(self.status());

        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(Failure::Cancelled),
            result = self.download_missing(&notify) => result,
        };
        {
            let mut activity = self.activity.lock();
            activity.download = None;
            activity.transfers.fill(None);
            for state in &mut activity.models {
                if *state != InstallState::Failed {
                    *state = InstallState::Missing;
                }
            }
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
        // One independent transfer per model. A failed transfer leaves the others running.
        let transfers = MODELS.iter().enumerate().map(|(index, model)| {
            let client = &client;
            async move {
                let result = self.download_model(client, index, model, notify).await;
                self.activity.lock().models[index] = match &result {
                    Ok(()) => InstallState::Ready,
                    Err(Failure::Cancelled) => InstallState::Missing,
                    Err(_) => InstallState::Failed,
                };
                notify(self.status());
                result
            }
        });
        join_all(transfers).await.into_iter().collect()
    }

    async fn download_model(
        &self,
        client: &reqwest::Client,
        index: usize,
        model: &ModelSpec,
        notify: &impl Fn(SpeechModelsStatus),
    ) -> Result<(), Failure> {
        let directory = self.root.join(model.id);
        fs::create_dir_all(&directory)?;
        for file in model.files {
            let target = directory.join(file.name);
            if installed_file(&target, file) {
                continue;
            }
            for attempt in 1..=ATTEMPTS {
                self.activity.lock().models[index] = InstallState::Downloading;
                let result = self
                    .download_file(client, file, &target, index, notify)
                    .await;
                self.activity.lock().transfers[index] = None;
                match result {
                    Ok(()) => break,
                    Err(Failure::Retry(_)) if attempt < ATTEMPTS => {
                        tokio::time::sleep(Duration::from_secs(2u64.pow(attempt as u32))).await;
                    }
                    Err(failure) => return Err(failure),
                }
            }
        }
        Ok(())
    }

    async fn download_file(
        &self,
        client: &reqwest::Client,
        file: &ModelFile,
        target: &Path,
        index: usize,
        notify: &impl Fn(SpeechModelsStatus),
    ) -> Result<(), Failure> {
        let partial = target.with_file_name(format!("{}.part", file.name));
        let mut hasher = Sha256::new();
        let mut written = existing_partial(&partial, file.bytes, &mut hasher)?;

        if written == file.bytes {
            self.activity.lock().models[index] = InstallState::Verifying;
            notify(self.status());
            return finish_file(file, &partial, target, hasher);
        }

        let mut request = client.get(file.url);
        if written > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={written}-"));
        }
        let mut response = tokio::time::timeout(STALL_TIMEOUT, request.send())
            .await
            .map_err(|_| Failure::Retry("The connection timed out".to_string()))?
            .map_err(network_failure)?;
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

        self.activity.lock().transfers[index] = Some((file.name, written));
        let mut last_notice = Instant::now();
        loop {
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
                self.activity.lock().transfers[index] = Some((file.name, written));
                notify(self.status());
            }
        }
        output.flush()?;
        drop(output);
        if written < file.bytes {
            return Err(Failure::Retry(format!("{} ended early", file.name)));
        }

        {
            let mut activity = self.activity.lock();
            activity.models[index] = InstallState::Verifying;
            activity.transfers[index] = Some((file.name, written));
        }
        notify(self.status());
        finish_file(file, &partial, target, hasher)
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
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() == file.bytes)
}

fn finish_file(
    file: &ModelFile,
    partial: &Path,
    target: &Path,
    hash: Sha256,
) -> Result<(), Failure> {
    if format!("{:x}", hash.finalize()) != file.sha256 {
        fs::remove_file(partial)?;
        return Err(Failure::Retry(format!(
            "{} failed its integrity check and was discarded",
            file.name
        )));
    }
    fs::rename(partial, target)?;
    Ok(())
}

/// Bytes already on disk from an interrupted download, fed into the hasher.
fn existing_partial(path: &Path, expected: u64, hasher: &mut Sha256) -> AppResult<u64> {
    let Ok(mut input) = File::open(path) else {
        return Ok(0);
    };
    if input.metadata()?.len() > expected {
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
    Failure::Retry(format!(
        "Could not reach Hugging Face: {}",
        error.without_url()
    ))
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
    fn counts_resumable_bytes_per_model_after_relaunch() {
        let directory = tempfile::tempdir().expect("temporary directory");
        for (index, model) in MODELS.iter().enumerate() {
            let folder = directory.path().join(model.id);
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join(format!("{}.part", model.files[0].name)),
                vec![1; index + 1],
            )
            .unwrap();
        }
        let models = SpeechModels::new(directory.path().to_owned());
        let status = models.status();
        assert_eq!(status.state, InstallState::Missing);
        assert_eq!(status.downloaded_bytes, 6);
        for (index, model) in status.models.iter().enumerate() {
            assert_eq!(model.downloaded_bytes, index as u64 + 1);
            assert_eq!(model.state, InstallState::Missing);
        }
    }

    #[tokio::test]
    #[ignore = "downloads 1.1 GB from Hugging Face into a temporary directory"]
    async fn installs_pinned_models_concurrently_and_resumes() {
        let directory = tempfile::tempdir().unwrap();
        let models = SpeechModels::new(directory.path().to_owned());
        models
            .download(|status| {
                let active = status
                    .models
                    .iter()
                    .filter(|model| !model.installed && model.downloaded_bytes > 0)
                    .count();
                if active >= 2 {
                    models.cancel();
                }
            })
            .await
            .unwrap();
        let resumed = SpeechModels::new(directory.path().to_owned());
        let partial = resumed.status();
        assert_eq!(partial.state, InstallState::Missing);
        assert!(partial.downloaded_bytes > 0);
        resumed.download(|_| {}).await.unwrap();
        let complete = SpeechModels::new(directory.path().to_owned());
        let status = complete.status();
        assert_eq!(status.state, InstallState::Ready);
        assert_eq!(status.downloaded_bytes, status.total_bytes);
        assert!(complete.paths().is_ok());
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

        fs::write(&partial, vec![0u8; 101]).expect("oversized partial");
        let mut hasher = Sha256::new();
        assert_eq!(
            existing_partial(&partial, 100, &mut hasher).expect("restart"),
            0
        );
        assert!(!partial.exists());
    }
}
